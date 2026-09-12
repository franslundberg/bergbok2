import { randomUUID } from "node:crypto";
import { Bookkeeping } from "@bergbok/modular-system";
import { appendEvent, companyRecord, COMPANY_ID, periodValue } from "../lib/bergbok/application.ts";
import { bookkeepingModelConfig } from "../lib/bergbok/config.ts";
import { getDatabase, type BergbokDatabase } from "../lib/bergbok/database.ts";
import { effectivePoliciesForYear } from "../lib/bergbok/pilot-policy.ts";
import type { BookkeepingJobPhase } from "../lib/bergbok/types.ts";

type JobRow = { id: string; company_id: string; period_id: string; created_by: string };
type BookkeepingVariant = ReturnType<typeof bookkeepingModelConfig>["variant"];
type ConsolidateBookkeeping = (
  caseBundle: Parameters<typeof Bookkeeping.consolidate>[0],
  variant: BookkeepingVariant,
) => ReturnType<typeof Bookkeeping.consolidate>;

const consolidateBookkeeping = Bookkeeping.consolidate as unknown as ConsolidateBookkeeping;
const STALE_AFTER_MS = 90_000;

export function recoverStaleJobs(database = getDatabase(), now = Date.now()) {
  const result = database
    .prepare(
      "UPDATE bookkeeping_jobs SET status='failed',finished_at=?,error_message='Arbetsprocessen avbröts. Starta om körningen uttryckligen.' WHERE status='running' AND heartbeat_at<?",
    )
    .run(now, now - STALE_AFTER_MS);
  return Number(result.changes);
}

export function claimJob(database = getDatabase(), now = Date.now()): JobRow | null {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database
      .prepare(
        "SELECT id,company_id,period_id,created_by FROM bookkeeping_jobs WHERE status='queued' ORDER BY created_at LIMIT 1",
      )
      .get() as JobRow | undefined;
    if (!row) {
      database.exec("COMMIT");
      return null;
    }
    const changed = database
      .prepare(
        "UPDATE bookkeeping_jobs SET status='running',started_at=?,heartbeat_at=?,phase='preparing',phase_changed_at=? WHERE id=? AND status='queued'",
      )
      .run(now, now, now, row.id);
    database.exec("COMMIT");
    return changed.changes === 1 ? row : null;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function processJob(
  job: JobRow,
  database: BergbokDatabase = getDatabase(),
  consolidate: ConsolidateBookkeeping = consolidateBookkeeping,
  variant: BookkeepingVariant = bookkeepingModelConfig().variant,
) {
  if (job.company_id !== COMPANY_ID) throw new Error("Worker received an unknown company");
  appendEvent(
    "bookkeeping_started",
    "bookkeeping-worker",
    { jobId: job.id, periodId: job.period_id },
    database,
  );
  appendEvent(
    "bookkeeping_progress",
    "bookkeeping-worker",
    { jobId: job.id, periodId: job.period_id, phase: "preparing" },
    database,
  );
  const heartbeat = setInterval(
    () =>
      database
        .prepare("UPDATE bookkeeping_jobs SET heartbeat_at=? WHERE id=? AND status='running'")
        .run(Date.now(), job.id),
    10_000,
  );
  heartbeat.unref();
  try {
    const period = periodValue(job.period_id, database);
    const record = await companyRecord();
    const docset = await record.read({ kind: "docset", period });
    if (!docset?.payload?.documents?.length) throw new Error("Periodens Docset är tomt");
    const previousState = await record.read({ kind: "state" });
    const year = period.end.slice(0, 4);
    const caseBundle = await record.prepare("bookkeeping", period, {
      expectedDocsetHead: docset.ref,
      expectedStateRef: previousState.ref,
      actor: { id: "bookkeeping-worker", role: "worker" },
      effectivePolicies: effectivePoliciesForYear(year, previousState.payload.core, {
        onboarding: period.kind === "start",
      }),
      context: period.kind === "start" ? { onboarding: { start_date: "2026-05-12" } } : {},
    });
    updateJobPhase(database, job, "analyzing");
    const outcome = await consolidate(caseBundle, variant);
    updateJobPhase(database, job, "recording");
    const stored = await record.record(caseBundle.ref, outcome);
    const runId = randomUUID();
    const now = Date.now();
    database
      .prepare(
        "INSERT INTO bookkeeping_runs (id,company_id,period_id,job_id,outcome_kind,run_ref_json,run_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        runId,
        COMPANY_ID,
        period.id,
        job.id,
        outcome.kind,
        JSON.stringify(stored.ref),
        stored.ref.sha256,
        now,
      );
    database
      .prepare(
        "UPDATE bookkeeping_jobs SET status=?,finished_at=?,heartbeat_at=?,run_id=? WHERE id=?",
      )
      .run(outcome.kind, now, now, runId, job.id);
    appendEvent(
      `bookkeeping_${outcome.kind}`,
      "bookkeeping-worker",
      {
        jobId: job.id,
        runId,
        periodId: period.id,
        runSha256: stored.ref.sha256,
        summary: outcome.review?.summary ?? null,
        questions: outcome.questions ?? [],
        reasons: outcome.reasons ?? [],
      },
      database,
    );
    return { runId, outcome, stored };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    database
      .prepare(
        "UPDATE bookkeeping_jobs SET status='failed',finished_at=?,heartbeat_at=?,error_message=? WHERE id=?",
      )
      .run(now, now, message.slice(0, 1000), job.id);
    appendEvent(
      "bookkeeping_failed",
      "bookkeeping-worker",
      {
        jobId: job.id,
        periodId: job.period_id,
        message: "Körningen misslyckades. Försök igen när orsaken är åtgärdad.",
      },
      database,
    );
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

function updateJobPhase(database: BergbokDatabase, job: JobRow, phase: BookkeepingJobPhase) {
  const now = Date.now();
  database
    .prepare(
      "UPDATE bookkeeping_jobs SET phase=?,phase_changed_at=?,heartbeat_at=? WHERE id=? AND status='running'",
    )
    .run(phase, now, now, job.id);
  appendEvent(
    "bookkeeping_progress",
    "bookkeeping-worker",
    { jobId: job.id, periodId: job.period_id, phase },
    database,
  );
}

async function main() {
  const { model, variant } = bookkeepingModelConfig();
  const database = getDatabase();
  recoverStaleJobs(database);
  console.info(`[bookkeeping-worker] ready model=${model}`);
  while (true) {
    const job = claimJob(database);
    if (job)
      await processJob(job, database, consolidateBookkeeping, variant).catch((error) =>
        console.error("[bookkeeping-worker]", error instanceof Error ? error.message : error),
      );
    else await new Promise((resolve) => setTimeout(resolve, 750));
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) await main();
