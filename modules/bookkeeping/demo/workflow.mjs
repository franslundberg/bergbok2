import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { consolidate } from "../src/index.mjs";
import { create as createCompanyRecord, open as openCompanyRecord } from "../../company-record/src/index.mjs";
import { render as renderArtifacts } from "../../artifacts/src/index.mjs";
import { prettyCanonicalJson, sha256Json } from "../../../contracts/src/canonical.mjs";
import { allocateRunDirectory } from "../../../dev/demo-run-directory.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATED = path.join(HERE, "generated");
const FIXTURE = path.join(HERE, "fixtures", "fiktiv-ab");
const WORKSPACE_FILE = "workspace.json";
const DEFAULT_START_DATE = "2026-05-12";
const DEFAULT_MODEL = "gpt-5.6-luna";
export const DEFAULT_APPROVER = "Filippa Stark";

export function resolveApprover(actor) {
  return actor?.trim() || DEFAULT_APPROVER;
}

export async function setup(dependencies = {}) {
  const { setupImages } = await import("../src/private/ai/docker.mjs");
  return (dependencies.setupImages ?? setupImages)();
}

export async function start(options = {}) {
  return createInitialWorkspace("start", options);
}

export async function beginImport(options = {}) {
  if (!options.startDate) throw new Error("import requires --start-date YYYY-MM-DD");
  if (!options.docset) throw new Error("import requires --docset DIR");
  return createInitialWorkspace("import", options);
}

async function createInitialWorkspace(kind, options) {
  const output = options.output ? path.resolve(options.output) : await allocateRunDirectory(GENERATED);
  if (options.output) await mkdir(output, { recursive: false });
  const useDefaultFixture = kind === "start" && !options.docset && !options.startDate;
  const fixtureCatalog = useDefaultFixture ? await readFixturePeriodCatalog() : null;
  const fixturePeriods = fixtureCatalog?.map((entry) => entry.period) ?? null;
  const startDate = validDate(
    options.startDate
      ?? fixturePeriods?.find((period) => period.kind === "ordinary")?.start
      ?? DEFAULT_START_DATE,
  );
  const companyId = options.companyId ?? `local-${path.basename(output)}`;
  const initialPeriod = fixturePeriods?.[0] ?? { id: kind === "start" ? "Start" : "Import", kind, end: previousDate(startDate) };
  if (fixturePeriods && initialPeriod.end !== previousDate(startDate)) {
    throw new Error("Fixture Start period must end on the day before the first ordinary period");
  }
  const documentsRoot = path.join(output, "documents");
  await mkdir(documentsRoot, { recursive: true });
  const demoPeriods = fixturePeriods ?? [initialPeriod];
  if (fixtureCatalog) {
    for (const entry of fixtureCatalog) {
      await copyVisibleDocset(path.join(FIXTURE, entry.documents), path.join(documentsRoot, entry.period.id));
    }
  } else {
    await copyVisibleDocset(
      options.docset ? path.resolve(options.docset) : path.join(FIXTURE, "Start"),
      path.join(documentsRoot, initialPeriod.id),
    );
  }
  await createCompanyRecord({ rootDir: path.join(output, "record"), companyId, initialState: { core: {}, domains: {} }, actor: { id: "bookkeeping-demo", role: "operator" } });
  const workspace = {
    schema_version: "1.0",
    workspace_id: path.basename(output),
    company_id: companyId,
    created_at: new Date().toISOString(),
    start_date: startDate,
    initial_period: initialPeriod,
    demo_periods: demoPeriods,
    next_run_number: 1,
    runs: [],
  };
  await writeWorkspace(output, workspace);
  return run({ ...options, workspace: output, period: initialPeriod.id });
}

export async function run(options = {}) {
  const workspaceRoot = requiredWorkspace(options.workspace);
  const workspace = await readWorkspace(workspaceRoot);
  const period = periodFor(workspace, options);
  const visibleDirectory = path.join(workspaceRoot, "documents", period.id);
  if (options.docset) {
    try { await readdir(visibleDirectory); throw new Error(`Visible Docset already exists: ${visibleDirectory}`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await copyVisibleDocset(path.resolve(options.docset), visibleDirectory);
  }
  const record = await openCompanyRecord({ rootDir: path.join(workspaceRoot, "record"), companyId: workspace.company_id });
  const currentState = await record.read({ kind: "state" });
  assertPredecessorReady(currentState, period);
  const visibleBefore = await hashVisibleDirectory(visibleDirectory);
  const docset = await synchronizeDocset(record, period, visibleDirectory);
  const caseBundle = await record.prepare("bookkeeping", period, {
    expectedDocsetHead: docset.ref,
    actor: { id: "bookkeeping-ai", role: "worker" },
    effectivePolicies: pilotPolicies(period),
    context: ["start", "import"].includes(period.kind) ? { onboarding: { start_date: workspace.start_date } } : {},
  });
  const sequence = workspace.next_run_number;
  const runId = `R${String(sequence).padStart(3, "0")}-${period.id}`;
  const variant = modelVariant(options.model ?? DEFAULT_MODEL, Boolean(options.allowWeb));
  const startedAt = new Date();
  console.log(`[run] workspace=${workspace.workspace_id} run_id=${runId} period=${period.id} model=${options.model ?? DEFAULT_MODEL}`);
  let outcome;
  let candidate = null;
  try {
    outcome = await consolidate(caseBundle, variant, {
      onCandidate(value) {
        candidate = value;
      },
    });
    const visibleAfter = await hashVisibleDirectory(visibleDirectory);
    if (visibleAfter !== visibleBefore) throw new Error("Visible Documents changed during Consolidation; run the period again");
  } catch (error) {
    await writeFailure(workspaceRoot, runId, period, startedAt, error);
    console.log(`[result] workspace=${workspace.workspace_id} run_id=${runId} status=technical_failure`);
    throw error;
  }
  const storedRun = await record.record(caseBundle.ref, outcome);
  const finishedAt = new Date();
  const runDirectory = path.join(workspaceRoot, "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const descriptor = {
    run_id: runId,
    period_id: period.id,
    period,
    outcome_kind: outcome.kind,
    case_ref: caseBundle.ref,
    run_ref: storedRun.ref,
    docset_ref: docset.ref,
    previous_state_ref: caseBundle.payload.previous_state.ref,
    visible_docset_sha256: visibleBefore,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    candidate_sha256: candidate ? sha256Json(candidate) : null,
    approved: false,
  };
  const outputSnapshot = await record.read({ kind: "output_snapshot", runRef: storedRun.ref });
  const reportBundles = await Promise.all([
    "report-source-json-v1",
    "report-html-v1",
    "report-pdf-v1",
  ].map((profile) => renderArtifacts(outputSnapshot, profile)));
  const reportArtifacts = reportBundles.flatMap((bundle) => bundle.payload.artifacts);
  await Promise.all([
    writeFile(path.join(runDirectory, "case.json"), prettyCanonicalJson(caseBundle), "utf8"),
    writeFile(path.join(runDirectory, "outcome.json"), prettyCanonicalJson(outcome), "utf8"),
    ...(candidate ? [writeFile(path.join(runDirectory, "candidate.json"), prettyCanonicalJson(candidate), "utf8")] : []),
    writeFile(path.join(runDirectory, "manifest.json"), `${JSON.stringify(descriptor, null, 2)}\n`, "utf8"),
    writeFile(path.join(runDirectory, "events.ndjson"), `${JSON.stringify({ timestamp: startedAt.toISOString(), kind: "run_started", run_id: runId })}\n${JSON.stringify({ timestamp: finishedAt.toISOString(), kind: "run_complete", run_id: runId, outcome_kind: outcome.kind })}\n`, "utf8"),
    ...reportArtifacts.map((artifact) => writeFile(path.join(runDirectory, artifact.filename), Buffer.from(artifact.content_base64, "base64"))),
  ]);
  workspace.next_run_number += 1;
  workspace.runs.push(descriptor);
  await writeWorkspace(workspaceRoot, workspace);
  console.log(`Bookkeeping demo: ${outcome.kind}`);
  console.log(`Output: ${workspaceRoot}`);
  if (outcome.kind === "proposal") {
    console.log(`Next: npm run demo:bookkeeping -- approve --workspace ${shellQuote(workspaceRoot)} --run ${runId}`);
  } else {
    console.log(`Next: update ${visibleDirectory} and run the same period again`);
  }
  console.log(`[result] workspace=${workspace.workspace_id} run_id=${runId} status=${outcome.kind}`);
  return { workspaceRoot, runId, outcome, storedRun, outputSnapshot, reportArtifacts };
}

export async function approve(options = {}) {
  const workspaceRoot = requiredWorkspace(options.workspace);
  const workspace = await readWorkspace(workspaceRoot);
  const descriptor = workspace.runs.find((item) => item.run_id === options.run);
  if (!descriptor) throw new Error(`Unknown run ${String(options.run)}`);
  if (descriptor.approved) return descriptor;
  const actor = resolveApprover(options.actor);
  const visibleDirectory = path.join(workspaceRoot, "documents", descriptor.period_id);
  if (await hashVisibleDirectory(visibleDirectory) !== descriptor.visible_docset_sha256) {
    throw new Error("Visible Documents changed after this Proposal; run Consolidation again before approval");
  }
  const record = await openCompanyRecord({ rootDir: path.join(workspaceRoot, "record"), companyId: workspace.company_id });
  const result = await record.approve(descriptor.run_ref, {
    decision: "approved",
    actor: { id: actor, role: "approver" },
    authority: { kind: "role", role: "approver" },
    expectedRunSha256: descriptor.run_ref.sha256,
  });
  descriptor.approved = true;
  descriptor.approved_at = result.receipt.payload.decided_at;
  descriptor.resulting_state_ref = result.state.ref;
  await writeWorkspace(workspaceRoot, workspace);
  const approvalDirectory = path.join(workspaceRoot, "approvals");
  await mkdir(approvalDirectory, { recursive: true });
  const reportBundles = await Promise.all([
    "report-source-json-v1",
    "report-html-v1",
    "report-pdf-v1",
  ].map((profile) => renderArtifacts(result.output_snapshot, profile)));
  const reportArtifacts = reportBundles.flatMap((bundle) => bundle.payload.artifacts);
  await Promise.all([
    writeFile(path.join(approvalDirectory, `${descriptor.run_id}.json`), prettyCanonicalJson(result), "utf8"),
    ...reportArtifacts.map((artifact) => writeFile(
      path.join(approvalDirectory, `${descriptor.run_id}-${artifact.filename}`),
      Buffer.from(artifact.content_base64, "base64"),
    )),
  ]);
  console.log(`[approve] workspace=${workspace.workspace_id} run_id=${descriptor.run_id} state_version=${result.state.ref.version} actor=${actor}`);
  const nextPeriod = nextDemoPeriod(workspace, descriptor.period_id);
  if (nextPeriod && await directoryExists(path.join(workspaceRoot, "documents", nextPeriod.id))) {
    console.log(`Next: ${ordinaryRunCommand(workspaceRoot, nextPeriod)}`);
  }
  return descriptor;
}

export async function status(options = {}) {
  const root = requiredWorkspace(options.workspace);
  const workspace = await readWorkspace(root);
  const record = await openCompanyRecord({ rootDir: path.join(root, "record"), companyId: workspace.company_id });
  const state = await record.read({ kind: "state" });
  console.log(`Workspace: ${workspace.workspace_id}`);
  console.log(`Company ID: ${workspace.company_id}`);
  console.log(`State: sequence ${state.payload.sequence}, ${state.ref.sha256}`);
  for (const item of workspace.runs) console.log(`${item.run_id}: ${item.outcome_kind}, ${item.approved ? "approved" : "not approved"}`);
  return { workspace, state };
}

async function synchronizeDocset(record, period, directory) {
  const files = await visibleFiles(directory);
  if (!files.length) throw new Error(`Docset is empty: ${directory}`);
  const current = await record.read({ kind: "docset", period });
  const additions = [];
  for (const file of files) {
    const logRef = await record.ingest({
      filename: file.relative,
      media_type: mediaType(file.relative),
      bytes: await readFile(file.absolute),
      suggested_period: period.id,
    }, { id: "local-docset", role: "operator" });
    additions.push({ op: "add", log_item_ref: logRef, filename: file.relative, media_type: mediaType(file.relative), role: "evidence" });
  }
  const removals = (current?.payload.documents ?? []).map((item) => ({ op: "remove", document_id: item.document_id }));
  const revision = await record.reviseDocset(period, current?.ref ?? null, [...removals, ...additions]);
  return revision.docset;
}

async function visibleFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".DS_Store" || entry.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await visibleFiles(absolute, relative));
    else if (entry.isFile()) result.push({ relative, absolute });
  }
  return result;
}

async function hashVisibleDirectory(root) {
  const hash = createHash("sha256");
  for (const file of await visibleFiles(root)) {
    hash.update(file.relative, "utf8");
    hash.update("\0");
    hash.update(await readFile(file.absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function periodFor(workspace, options) {
  const id = options.period;
  if (!id) throw new Error("run requires --period PERIOD");
  if (!safePeriodId(id)) throw new Error("--period must be a filesystem-safe ID using letters, numbers, dot, underscore, or hyphen");
  const catalogPeriod = (workspace.demo_periods ?? []).find((period) => period.id === id);
  if (catalogPeriod) {
    validateCatalogPeriodBounds(catalogPeriod, options);
    return { ...catalogPeriod };
  }
  if (id === workspace.initial_period.id) {
    if (options.periodStart || options.periodEnd) throw new Error("Start and Import bounds come from --start-date, not ordinary interval options");
    return workspace.initial_period;
  }
  if (!options.periodStart || !options.periodEnd) throw new Error("ordinary run requires --period-start and --period-end");
  const start = validPeriodDate(options.periodStart, "--period-start");
  const end = validPeriodDate(options.periodEnd, "--period-end");
  if (start > end) throw new Error("--period-start must not be after --period-end");
  return { id, kind: "ordinary", start, end };
}

function pilotPolicies(period) {
  const year = (period.end ?? period.start).slice(0, 4);
  return {
    core: { country: "SE", currency: "SEK", fiscal_year: { start: `${year}-01-01`, end: `${year}-12-31` }, accounting_method: "invoice" },
    bookkeeping: { profile: "se-private-ab-invoice-calendar-demo-v1", verification_series: "A", chart_of_accounts: "BAS", vat_reporting: { frequency: "quarterly", input_accounts: ["2641"], output_accounts: ["2611"], settlement_account: "2650" }, open_items: { supplier_payable: { accounts: ["2440"], side: "credit" }, customer_receivable: { accounts: ["1510"], side: "debit" }, related_party_payable: { accounts: ["2893"], side: "credit" }, other_current_payable: { accounts: ["2890"], side: "credit" }, other_current_receivable: { accounts: ["1680"], side: "debit" } } },
  };
}

function assertPredecessorReady(state, period) {
  const bookkeeping = state.payload.domains?.bookkeeping;
  if (["start", "import"].includes(period.kind)) {
    if (bookkeeping || state.payload.sequence !== 0) throw new Error(`${period.id} requires empty State S0; start an ordinary Period instead`);
    return;
  }
  const expected = previousDate(period.start);
  const actual = bookkeeping?.through_date ?? null;
  if (actual !== expected) throw new Error(`Approve Bookkeeping State through ${expected} before running ${period.id}`);
}

function modelVariant(model, allowWeb) {
  if (model === "gpt-5.6-luna") return { id: "openai-gpt-5.6-luna-high-v3", allow_web: allowWeb };
  if (model === "gpt-5.6-sol") return { id: "openai-gpt-5.6-sol-high-v3", allow_web: allowWeb };
  throw new Error("--model must be gpt-5.6-luna or gpt-5.6-sol");
}

async function copyVisibleDocset(source, destination) {
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false, filter: (item) => path.basename(item) !== ".DS_Store" });
}

async function writeWorkspace(root, value) {
  await writeFile(path.join(root, WORKSPACE_FILE), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readWorkspace(root) {
  const value = JSON.parse(await readFile(path.join(root, WORKSPACE_FILE), "utf8"));
  if (value.schema_version !== "1.0" || !value.company_id || !value.initial_period || !Array.isArray(value.runs)) {
    throw new Error("Invalid Bookkeeping demo workspace");
  }
  return value;
}

async function writeFailure(root, runId, period, startedAt, error) {
  const directory = path.join(root, "runs", runId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "failure.json"), `${JSON.stringify({ run_id: runId, period_id: period.id, status: "technical_failure", started_at: startedAt.toISOString(), failed_at: new Date().toISOString(), message: error instanceof Error ? error.message : String(error), execution: error?.agent_state ?? null }, null, 2)}\n`, "utf8");
}

function requiredWorkspace(value) {
  if (!value) throw new Error("--workspace PATH is required");
  return path.resolve(value);
}

function validDate(value) {
  return validPeriodDate(value, "--start-date");
}

function validPeriodDate(value, option) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${option} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${option} is not a valid date`);
  return value;
}

function previousDate(value) {
  const date = new Date(`${validDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function mediaType(filename) {
  const extension = path.extname(filename).toLowerCase();
  return ({ ".pdf": "application/pdf", ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" })[extension] ?? "application/octet-stream";
}

async function directoryExists(directory) {
  try { return (await readdir(directory)).length >= 0; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function safePeriodId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
}

function nextDemoPeriod(workspace, periodId) {
  const index = (workspace.demo_periods ?? []).findIndex((item) => item.id === periodId);
  return index >= 0 ? workspace.demo_periods[index + 1] ?? null : null;
}

function ordinaryRunCommand(workspaceRoot, period) {
  return `npm run demo:bookkeeping -- run --workspace ${shellQuote(workspaceRoot)} --period ${period.id}`;
}

async function readFixturePeriodCatalog() {
  const source = JSON.parse(await readFile(path.join(FIXTURE, "periods.json"), "utf8"));
  if (source.schema_version !== "1.0" || !Array.isArray(source.periods) || source.periods.length < 2) {
    throw new Error("Invalid Fiktiv AB fixture period catalog");
  }
  return source.periods.map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.id || !entry.kind || !entry.documents) {
      throw new Error("Invalid Fiktiv AB fixture period entry");
    }
    const { documents, ...period } = entry;
    if (!safePeriodId(period.id)) throw new Error(`Invalid fixture period ID: ${period.id}`);
    if (!["start", "import", "ordinary"].includes(period.kind)) throw new Error(`Invalid fixture period kind: ${period.kind}`);
    if (period.kind === "ordinary" && (!period.start || !period.end)) {
      throw new Error(`Fixture ordinary period ${period.id} requires start and end dates`);
    }
    return { period, documents };
  });
}

function validateCatalogPeriodBounds(period, options) {
  const hasStart = options.periodStart !== undefined;
  const hasEnd = options.periodEnd !== undefined;
  if (!hasStart && !hasEnd) return;
  if (!hasStart || !hasEnd) throw new Error("A catalogued Period uses its fixture dates; provide both --period-start and --period-end if checking them explicitly");
  const start = validPeriodDate(options.periodStart, "--period-start");
  const end = validPeriodDate(options.periodEnd, "--period-end");
  if (start !== period.start || end !== period.end) {
    throw new Error(`Period ${period.id} has fixed dates ${period.start ?? "(no start)"} through ${period.end}; supplied dates do not match`);
  }
}
