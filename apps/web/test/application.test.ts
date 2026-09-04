import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Bookkeeping, createModuleOutcome } from "@bergbok/modular-system";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../lib/bergbok/auth-constraints.ts";
import { AuthService, validatePassword } from "../lib/bergbok/auth.ts";
import { createDatabase } from "../lib/bergbok/database.ts";
import {
  assignUpload,
  addDocumentNote,
  companySummary,
  conversationEvents,
  createTextDocument,
  decideRun,
  documentDetail,
  enqueueRun,
  periodDetail,
  periodValue,
  receiveUpload,
  removePeriodDocument,
  replaceTextDocument,
  requestProposalChanges,
  safeFilename,
  validateUploadContent,
} from "../lib/bergbok/application.ts";
import {
  activeToolsForStep,
  approvedBookkeepingThrough,
  createApplicationTools,
  isDirectBookkeepingCommand,
  MUTATION_TOOL_NAMES,
} from "../lib/bergbok/chat-tools.ts";
import { materializeChatSnapshot } from "../lib/bergbok/snapshot.ts";
import { formatElapsed } from "../lib/bergbok/job-progress.ts";
import { buildStartProfile } from "../lib/bergbok/start-profile.ts";
import { claimWorkbenchNavigation } from "../lib/bergbok/workbench-navigation.ts";
import {
  clampWorkbenchWidth,
  DEFAULT_WORKBENCH_WIDTH,
  MAX_WORKBENCH_WIDTH,
  MIN_WORKBENCH_WIDTH,
} from "../lib/bergbok/workbench-layout.ts";
import { claimJob, processJob, recoverStaleJobs } from "../worker/bookkeeping-worker.ts";

const session = {
  sessionId: "a".repeat(48),
  userId: "owner-1",
  email: "owner@example.se",
  expiresAt: Date.now() + 60_000,
};

test("demo passwords enforce the configured length boundaries", () => {
  const minimum = "x".repeat(PASSWORD_MIN_LENGTH);
  const maximum = "x".repeat(PASSWORD_MAX_LENGTH);
  const expectedRange = `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH}`;
  assert.equal(validatePassword(minimum), minimum);
  assert.equal(validatePassword(maximum), maximum);
  assert.throws(
    () => validatePassword("x".repeat(PASSWORD_MIN_LENGTH - 1)),
    (error) => error instanceof Error && error.message.includes(expectedRange),
  );
  assert.throws(
    () => validatePassword("x".repeat(PASSWORD_MAX_LENGTH + 1)),
    (error) => error instanceof Error && error.message.includes(expectedRange),
  );
});

test("bookkeeping progress uses calm elapsed-time buckets", () => {
  assert.equal(formatElapsed(0), "Startar…");
  assert.equal(formatElapsed(9), "Startar…");
  assert.equal(formatElapsed(10), "10 sekunder");
  assert.equal(formatElapsed(19), "10 sekunder");
  assert.equal(formatElapsed(20), "20 sekunder");
  assert.equal(formatElapsed(50), "50 sekunder");
  assert.equal(formatElapsed(59), "50 sekunder");
  assert.equal(formatElapsed(60), "1 minut");
  assert.equal(formatElapsed(119), "1 minut");
  assert.equal(formatElapsed(120), "2 minuter");
  assert.equal(formatElapsed(3600), "60 minuter");
});

test("database bootstraps Fiktiv AB with three empty periods", () => {
  const database = createDatabase(":memory:");
  assert.deepEqual(periodValue("Start", database), {
    id: "Start",
    kind: "start",
    end: "2026-05-11",
  });
  assert.deepEqual(periodValue("2026-05", database), {
    id: "2026-05",
    kind: "ordinary",
    start: "2026-05-12",
    end: "2026-05-31",
  });
  assert.equal(
    (database.prepare("SELECT COUNT(*) count FROM uploads").get() as { count: number }).count,
    0,
  );
});

test("Start review combines proposed core, fixed policy and cited evidence facts", () => {
  const profile = buildStartProfile(
    {
      proposed_changes: [
        {
          action: "initialize_core_state",
          core: {
            organization: { name: "Fiktiv AB", organization_number: "559999-0008" },
            registrations: {
              vat_number: "SE559999000801",
              eori_number: "SE5599990008",
            },
            address: {
              street: "Karl Gerhards väg 27",
              postal_code: "133 35",
              city: "Saltsjöbaden",
              country: "SE",
            },
            bookkeeping_start_date: "2026-05-12",
            policies: {
              accounting_method: "invoice",
              fiscal_year: { start: "2026-01-01", end: "2026-12-31" },
            },
          },
        },
      ],
    },
    [
      {
        id: "document-1",
        filename: "bolaget.md",
        contentUrl: "/api/documents/upload-1",
        text: [
          "* Aktier: 100 000 aktier, alla ägs av Filippa Stark. Aktiekapital: 25 000 kr.",
          "* Styrelseledamot: Filippa Stark, ledamot, personnummer: 900101-0000.",
          "* Bankgironummer: 5296-6666. Namn Fiktiv AB.",
          "* Betalkort, payment card: Mastercard, SEB Commercial debit xxx4444.",
          "* Vanlig BAS-kontoplan ska användas.",
        ].join("\n"),
      },
    ],
  );
  assert.ok(profile);
  assert.deepEqual(
    profile.accounting.map(({ label, value }) => [label, value]),
    [
      ["Bokföringsmetod", "Faktureringsmetoden"],
      ["Räkenskapsår", "2026-01-01–2026-12-31"],
      ["Momsperiod", "Kvartalsvis"],
      ["Kontoplan", "BAS"],
      ["Bokföringsstart", "2026-05-12"],
    ],
  );
  assert.equal(
    profile.evidence.find(({ label }) => label === "Betalkort")?.value,
    "Mastercard, SEB Commercial debit xxx4444",
  );
  assert.equal(
    profile.evidence.find(({ label }) => label === "Styrelseledamot")?.value,
    "Filippa Stark, ledamot",
  );
  assert.ok(profile.evidence.every(({ contentUrl }) => contentUrl === "/api/documents/upload-1"));
});

test("a completed chat tool can navigate the workbench only once", () => {
  const handled = new Set<string>();
  const periodResult = { workbench: { kind: "period", periodId: "Start" } };
  assert.deepEqual(claimWorkbenchNavigation(handled, "call-1", periodResult), {
    kind: "period",
    periodId: "Start",
  });
  assert.equal(
    claimWorkbenchNavigation(handled, "call-1", {
      workbench: { kind: "period", periodId: "2026-05" },
    }),
    null,
  );
  assert.deepEqual(
    claimWorkbenchNavigation(handled, "call-2", {
      workbench: { kind: "proposal", periodId: "Start" },
    }),
    { kind: "proposal", periodId: "Start" },
  );
});

test("the desktop workbench width supports the configured range within the viewport", () => {
  assert.equal(clampWorkbenchWidth(100, 1600), MIN_WORKBENCH_WIDTH);
  assert.equal(clampWorkbenchWidth(DEFAULT_WORKBENCH_WIDTH, 1600), DEFAULT_WORKBENCH_WIDTH);
  assert.equal(clampWorkbenchWidth(2000, 1600), 1536);
  assert.equal(clampWorkbenchWidth(2000, 2400), MAX_WORKBENCH_WIDTH);
});

test("authentication sends a PIN only to the configured owner and creates membership", async () => {
  const database = createDatabase(":memory:");
  const sent: Array<{ email: string; pin: string }> = [];
  const service = new AuthService({
    database,
    pepper: "p".repeat(32),
    sessionSecret: "s".repeat(32),
    ownerEmail: "owner@example.se",
    sendPin: async (email, pin) => {
      sent.push({ email, pin });
    },
  });
  assert.equal(service.accountKind("owner@example.se"), "new");
  const denied = await service.startCode("other@example.se", "127.0.0.1");
  assert.equal(denied.challengeToken, null);
  assert.equal(sent.length, 0);
  const allowed = await service.startCode("owner@example.se", "127.0.0.1");
  assert.equal(sent.length, 1);
  const verified = await service.verifyCode(allowed.challengeToken ?? undefined, sent[0].pin);
  assert.equal(verified.kind, "set_password");
  if (verified.kind !== "set_password") throw new Error("Expected password setup.");
  assert.equal(service.accountKind("owner@example.se"), "new");
  await service.setPassword(verified.signupToken, "secret");
  assert.equal(service.accountKind("owner@example.se"), "existing");
  const membership = database.prepare("SELECT role,can_approve FROM company_memberships").get() as {
    role: string;
    can_approve: number;
  };
  assert.equal(membership.role, "owner");
  assert.equal(membership.can_approve, 1);
});

test("real upload remains unassigned until explicit confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-web-test-"));
  process.env.BERGBOK_DATA_ROOT = root;
  process.env.BERGBOK_OWNER_EMAIL = session.email;
  try {
    const database = createDatabase(":memory:");
    const uploaded = await receiveUpload(
      session,
      new File(["Fiktivt underlag\n"], "underlag.md", { type: "text/markdown" }),
      database,
    );
    assert.equal(uploaded.status, "unassigned");
    let summary = await companySummary(database);
    assert.equal(summary.periods[0].uploadCount, 0);
    const assigned = await assignUpload(session, uploaded.id, "assign", database);
    assert.equal(assigned.periodId, "Start");
    summary = await companySummary(database);
    assert.equal(summary.periods[0].uploadCount, 1);
    assert.equal(summary.periods[1].status, "locked");
    const job = enqueueRun(session, "Start", database);
    assert.equal(job.status, "queued");
    assert.equal(claimJob(database)?.id, job.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("database migration backfills legacy assigned documents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-web-migration-test-"));
  const databasePath = path.join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE companies (id TEXT PRIMARY KEY,name TEXT NOT NULL,language TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
    INSERT INTO companies VALUES ('fiktiv-ab','Fiktiv AB','sv',1);
    CREATE TABLE uploads (id TEXT PRIMARY KEY,company_id TEXT NOT NULL,log_item_id TEXT NOT NULL UNIQUE,filename TEXT NOT NULL,media_type TEXT NOT NULL,sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('unassigned','assigned','ignored')),period_id TEXT,document_id TEXT,duplicate_of TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    INSERT INTO uploads VALUES ('source','fiktiv-ab','log','legacy.pdf','application/pdf','${"a".repeat(64)}',10,'assigned','Start','doc-1',NULL,'owner',1,1);
  `);
  legacy.close();
  try {
    const database = createDatabase(databasePath);
    const columns = new Set(
      (database.prepare("PRAGMA table_info(uploads)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );
    assert.ok(columns.has("origin"));
    assert.ok(columns.has("target_period_id"));
    const entry = database.prepare("SELECT document_id,status FROM docset_entries").get() as {
      document_id: string;
      status: string;
    };
    assert.equal(entry.document_id, "doc-1");
    assert.equal(entry.status, "active");
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active Underlag supports direct upload, duplicates, notes, replacement and removal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-web-docset-test-"));
  process.env.BERGBOK_DATA_ROOT = root;
  process.env.BERGBOK_OWNER_EMAIL = session.email;
  try {
    const database = createDatabase(":memory:");
    const uploaded = await receiveUpload(
      session,
      new File(["Originalt underlag\n"], "underlag.md", { type: "text/markdown" }),
      database,
      "Start",
    );
    assert.equal(uploaded.status, "assigned");
    let detail = await periodDetail("Start", database);
    assert.equal(detail.documents.length, 1);

    const duplicate = await receiveUpload(
      session,
      new File(["Originalt underlag\n"], "kopia.md", { type: "text/markdown" }),
      database,
      "Start",
    );
    assert.equal(duplicate.status, "unassigned");
    assert.ok(duplicate.duplicateOf);
    detail = await periodDetail("Start", database);
    assert.equal(detail.pendingUploads.length, 1);
    await assignUpload(session, duplicate.id, "ignore", database);

    const authored = await createTextDocument(
      session,
      "Start",
      "egen-uppgift",
      "# Uppgift\n\nFaktureringsmetoden används.\n",
      database,
    );
    const note = await addDocumentNote(
      session,
      "Start",
      String(uploaded.documentId),
      "Kontrollerad mot avtalet.",
      database,
    );
    const parent = await documentDetail("Start", String(uploaded.documentId), database);
    assert.equal(parent.notes[0].id, note.documentId);

    const replaced = await replaceTextDocument(
      session,
      "Start",
      String(authored.documentId),
      "# Uppdaterad uppgift\n",
      database,
    );
    detail = await periodDetail("Start", database);
    assert.ok(!detail.documents.some((document) => document.id === authored.documentId));
    assert.ok(detail.documents.some((document) => document.id === replaced.documentId));
    await assert.rejects(
      replaceTextDocument(session, "Start", String(uploaded.documentId), "försök", database),
      /Uppladdade original/,
    );

    await removePeriodDocument(session, "Start", replaced.documentId, database);
    detail = await periodDetail("Start", database);
    assert.ok(!detail.documents.some((document) => document.id === replaced.documentId));
    assert.equal(
      (
        database
          .prepare("SELECT status FROM docset_entries WHERE document_id=?")
          .get(replaced.documentId) as { status: string }
      ).status,
      "removed",
    );
    const snapshot = await materializeChatSnapshot(database);
    const manifest = JSON.parse(
      await readFile(path.join(snapshot.root, "manifest.json"), "utf8"),
    ) as {
      documents: Array<{
        document_id: string | null;
        parent_document_id: string | null;
        filename: string;
        download_path: string;
      }>;
    };
    assert.ok(!manifest.documents.some(({ document_id }) => document_id === replaced.documentId));
    assert.ok(
      manifest.documents.some(
        ({ document_id, parent_document_id }) =>
          document_id === note.documentId && parent_document_id === uploaded.documentId,
      ),
    );
    assert.ok(
      manifest.documents.every(
        ({ filename, download_path }) =>
          filename.length > 0 && download_path.startsWith("/api/documents/"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unassigned upload does not supersede a proposal but a Docset change does", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-web-supersede-test-"));
  process.env.BERGBOK_DATA_ROOT = root;
  process.env.BERGBOK_OWNER_EMAIL = session.email;
  try {
    const database = createDatabase(":memory:");
    database
      .prepare(
        "INSERT INTO bookkeeping_jobs (id,company_id,period_id,status,created_by,created_at,finished_at,run_id) VALUES ('job','fiktiv-ab','Start','proposal','owner',1,1,'run')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO bookkeeping_runs (id,company_id,period_id,job_id,outcome_kind,run_ref_json,run_sha256,review_markdown,outcome_json,created_at) VALUES ('run','fiktiv-ab','Start','job','proposal','{}',?,'review','{}',1)",
      )
      .run("b".repeat(64));
    await receiveUpload(
      session,
      new File(["Osorterat\n"], "osorterat.md", { type: "text/markdown" }),
      database,
    );
    assert.equal(
      (
        database.prepare("SELECT superseded_at FROM bookkeeping_runs WHERE id='run'").get() as {
          superseded_at: number | null;
        }
      ).superseded_at,
      null,
    );
    await createTextDocument(session, "Start", "nytt.md", "Ny uppgift", database);
    assert.equal(
      typeof (
        database.prepare("SELECT superseded_at FROM bookkeeping_runs WHERE id='run'").get() as {
          superseded_at: number | null;
        }
      ).superseded_at,
      "number",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a chat change request rejects the exact current proposal with the user's note", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-web-change-request-test-"));
  process.env.BERGBOK_DATA_ROOT = root;
  process.env.BERGBOK_OWNER_EMAIL = session.email;
  try {
    const database = createDatabase(":memory:");
    await receiveUpload(
      session,
      new File(["Startuppgift\n"], "start.md", { type: "text/markdown" }),
      database,
      "Start",
    );
    enqueueRun(session, "Start", database);
    const job = claimJob(database);
    assert.ok(job);
    const processed = await processJob(job, database, async (caseBundle) => {
      const documentId = caseBundle.payload.docset.payload.documents[0].document_id;
      return Bookkeeping.consolidateOffline(caseBundle, "offline-change-request-test-v1", {
        input: {
          schema_id: "se.bergbok.bookkeeping-input",
          schema_version: "2.0",
          company_id: "fiktiv-ab",
          period_id: "Start",
          mode: "start",
          organization: { name: "Fiktiv AB", organization_number: "559999-9999" },
          transactions: [],
          open_item_changes: [],
          reconciliations: [],
          vat: { status: "not_due" },
        },
        core: {
          organization: { name: "Fiktiv AB", organization_number: "559999-9999" },
          evidence_document_ids: [documentId],
        },
        assessment: { questions: [], warnings: [], reasons: [] },
      });
    });
    await requestProposalChanges(
      session,
      "Start",
      "Organisationsnumret ska kontrolleras.",
      database,
    );
    const row = database
      .prepare("SELECT decision,run_sha256 FROM bookkeeping_runs WHERE id=?")
      .get(processed.runId) as { decision: string; run_sha256: string };
    assert.equal(row.decision, "rejected");
    assert.equal(row.run_sha256, processed.stored.ref.sha256);
    const event = conversationEvents(0, database).at(-1);
    assert.equal(event?.type, "bookkeeping_decided");
    assert.equal(event?.payload.note, "Organisationsnumret ska kontrolleras.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chat exposes mutations only on the first step and never exposes approval", () => {
  const tools = createApplicationTools(session, { kind: "period", periodId: "Start" });
  assert.ok(MUTATION_TOOL_NAMES.every((name) => name in tools));
  assert.ok(!("approve" in tools));
  assert.ok(!("approve_proposal" in tools));
  assert.ok((activeToolsForStep(0) as readonly string[]).includes("remove_document"));
  assert.ok(!(activeToolsForStep(1) as readonly string[]).includes("remove_document"));
  assert.deepEqual(activeToolsForStep(1), [
    "shell",
    "show_period",
    "list_documents",
    "show_document",
    "show_proposal",
    "show_artifacts",
    "prepare_upload",
  ]);
});

test("clear bookkeeping chat commands select the trusted run tool", () => {
  assert.equal(isDirectBookkeepingCommand("Bokför 2026-05"), true);
  assert.equal(isDirectBookkeepingCommand("Kan du bokföra perioden Start?"), true);
  assert.equal(isDirectBookkeepingCommand("Bokför den här perioden"), false);
  assert.equal(isDirectBookkeepingCommand("Hur bokför jag 2026-05?"), false);
});

test("chat context identifies the latest approved bookkeeping cutoff", () => {
  assert.deepEqual(
    approvedBookkeepingThrough([
      { id: "Start", sequence: 1, status: "approved", end: "2026-05-11" },
      { id: "2026-05", sequence: 2, status: "approved", end: "2026-05-31" },
      { id: "2026-06", sequence: 3, status: "approved", end: "2026-06-30" },
      { id: "2026-07", sequence: 4, status: "working", end: "2026-07-31" },
    ]),
    { period_id: "2026-06", end: "2026-06-30" },
  );
  assert.equal(
    approvedBookkeepingThrough([
      { id: "Start", sequence: 1, status: "preliminary", end: "2026-05-11" },
    ]),
    null,
  );
});

test("job recovery fails abandoned work without retrying it", () => {
  const database = createDatabase(":memory:");
  database
    .prepare(
      "INSERT INTO bookkeeping_jobs (id,company_id,period_id,status,created_by,created_at,heartbeat_at) VALUES ('job','fiktiv-ab','Start','running','owner',1,1)",
    )
    .run();
  assert.equal(recoverStaleJobs(database, 200_000), 1);
  assert.equal(
    (
      database.prepare("SELECT status FROM bookkeeping_jobs WHERE id='job'").get() as {
        status: string;
      }
    ).status,
    "failed",
  );
  assert.equal(claimJob(database), null);
});

test("worker records deterministic needs-input outcomes and timeline questions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-web-worker-test-"));
  process.env.BERGBOK_DATA_ROOT = root;
  process.env.BERGBOK_OWNER_EMAIL = session.email;
  try {
    const database = createDatabase(":memory:");
    const uploaded = await receiveUpload(
      session,
      new File(["Belopp saknas\n"], "fraga.md", { type: "text/markdown" }),
      database,
    );
    await assignUpload(session, uploaded.id, "assign", database);
    enqueueRun(session, "Start", database);
    const job = claimJob(database);
    assert.ok(job);
    assert.equal(
      (
        database.prepare("SELECT phase FROM bookkeeping_jobs WHERE id=?").get(job.id) as {
          phase: string;
        }
      ).phase,
      "preparing",
    );
    const observedPhases: string[] = [];
    const result = await processJob(job, database, async (caseBundle) =>
      (() => {
        observedPhases.push(
          (
            database.prepare("SELECT phase FROM bookkeeping_jobs WHERE id=?").get(job.id) as {
              phase: string;
            }
          ).phase,
        );
        return createModuleOutcome({
          kind: "needs_input",
          domain: "bookkeeping",
          caseRef: caseBundle.ref,
          questions: [{ question_id: "BKQ1", prompt: "Vilket belopp gäller?" }] as never[],
          review: { language: "sv", summary: "En fråga måste besvaras" },
          provenance: { module_id: "test.bookkeeping", module_version: "1" },
        });
      })(),
    );
    assert.equal(result.outcome.kind, "needs_input");
    const storedJob = database
      .prepare("SELECT status,phase FROM bookkeeping_jobs WHERE id=?")
      .get(job.id) as { status: string; phase: string };
    assert.equal(storedJob.status, "needs_input");
    assert.deepEqual(observedPhases, ["analyzing"]);
    assert.equal(storedJob.phase, "recording");
    const event = conversationEvents(0, database).at(-1);
    assert.equal(event?.type, "bookkeeping_needs_input");
    assert.ok(event);
    const questions = event.payload.questions as Array<{ prompt: string }>;
    assert.equal(questions[0].prompt, "Vilket belopp gäller?");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Start, May and June can be proposed, approved and rendered in order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-web-continuity-test-"));
  process.env.BERGBOK_DATA_ROOT = root;
  process.env.BERGBOK_OWNER_EMAIL = session.email;
  try {
    const database = createDatabase(":memory:");
    for (const periodId of ["Start", "2026-05", "2026-06"]) {
      const uploaded = await receiveUpload(
        session,
        new File([`Underlag för ${periodId}\n`], `${periodId}.md`, { type: "text/markdown" }),
        database,
      );
      await assignUpload(session, uploaded.id, "assign", database);
      enqueueRun(session, periodId, database);
      const job = claimJob(database);
      assert.ok(job);
      const processed = await processJob(job, database, async (caseBundle) => {
        const period = caseBundle.payload.period;
        const documentId = caseBundle.payload.docset.payload.documents[0].document_id;
        return Bookkeeping.consolidateOffline(caseBundle, "offline-deterministic-web-test-v1", {
          input: {
            schema_id: "se.bergbok.bookkeeping-input",
            schema_version: "2.0",
            company_id: "fiktiv-ab",
            period_id: period.id,
            mode: period.kind,
            organization: {
              name: "Fiktiv AB",
              organization_number: "559999-9999",
            },
            transactions: [],
            open_item_changes: [],
            reconciliations: [],
            vat: { status: "not_due" },
          },
          ...(period.kind === "start"
            ? {
                core: {
                  organization: {
                    name: "Fiktiv AB",
                    organization_number: "559999-9999",
                  },
                  evidence_document_ids: [documentId],
                },
              }
            : {}),
          assessment: { questions: [], warnings: [], reasons: [] },
        });
      });
      assert.equal(processed.outcome.kind, "proposal");
      await decideRun(session, processed.runId, processed.stored.ref.sha256, "approved", database);
    }
    const summary = await companySummary(database);
    assert.deepEqual(
      summary.periods.map((period) => period.status),
      ["approved", "approved", "approved"],
    );
    assert.equal(summary.activePeriodId, null);
    assert.equal(summary.artifacts.length, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filenames cannot escape application storage", () => {
  assert.equal(safeFilename("../../receipt.pdf"), "receipt.pdf");
  assert.throws(() => safeFilename(".."), /Filnamnet/);
  assert.throws(
    () => validateUploadContent("application/pdf", Buffer.from("not a pdf")),
    /giltig PDF/,
  );
  assert.throws(
    () => validateUploadContent("text/plain", Buffer.from([0x66, 0x00, 0x6f])),
    /binärdata/,
  );
});
