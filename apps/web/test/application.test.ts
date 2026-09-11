import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Bookkeeping, createModuleOutcome } from "@bergbok/modular-system";
import { convertToModelMessages } from "ai";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../lib/bergbok/auth-constraints.ts";
import { AuthService, validatePassword } from "../lib/bergbok/auth.ts";
import {
  artifactBaseMediaType,
  isInlineArtifactMediaType,
} from "../lib/bergbok/artifact-delivery.ts";
import { createDatabase } from "../lib/bergbok/database.ts";
import {
  assignUpload,
  addDocumentNote,
  appendChatMessage,
  companySummary,
  conversationEvents,
  createTextDocument,
  decideRun,
  documentDetail,
  enqueueRun,
  getResultReport,
  periodDetail,
  periodValue,
  receiveUpload,
  removePeriodDocument,
  replaceTextDocument,
  reviewContent,
  requestProposalChanges,
  safeFilename,
  UPLOAD_ASSIGNMENT_PENDING_WINDOW_MS,
  normalizeUploadMediaType,
  validateUploadContent,
} from "../lib/bergbok/application.ts";
import {
  activeToolsForStep,
  approvedBookkeepingThrough,
  createApplicationTools,
  isDirectBookkeepingCommand,
  isDirectResultReportCommand,
  MUTATION_TOOL_NAMES,
  READ_TOOL_NAMES,
} from "../lib/bergbok/chat-tools.ts";
import { messagesForNewClaims, sanitizeAssistantParts } from "../lib/bergbok/chat-history.ts";
import { materializeChatSnapshot } from "../lib/bergbok/snapshot.ts";
import { formatElapsed } from "../lib/bergbok/job-progress.ts";
import { formatResultReportMoney } from "../lib/bergbok/result-report-view.ts";
import { claimWorkContextNavigation } from "../lib/bergbok/workbench-navigation.ts";
import {
  defaultWorkContext,
  documentsContext,
  isWorkContextValidForSummary,
  restoreWorkContext,
  switchWorkContextPeriod,
  validateWorkContextDomain,
} from "../lib/bergbok/work-context.ts";
import {
  parseWorkContext,
  validateWorkContext,
  type CompanySummary,
} from "../lib/bergbok/types.ts";
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

test("HTML and PDF artifacts open inline while source files download", () => {
  assert.equal(artifactBaseMediaType("text/html; charset=utf-8"), "text/html");
  assert.equal(isInlineArtifactMediaType("text/html; charset=utf-8"), true);
  assert.equal(isInlineArtifactMediaType("application/pdf"), true);
  assert.equal(isInlineArtifactMediaType("application/json; charset=utf-8"), false);
  assert.equal(isInlineArtifactMediaType("application/x-sie; charset=utf-8"), false);
});

test("result report cells distinguish covered zero from uncovered values", () => {
  assert.equal(formatResultReportMoney("0.00 SEK", "SEK"), "0,00");
  assert.equal(formatResultReportMoney("-1234567.89 SEK", "SEK"), "−1 234 567,89");
  assert.equal(formatResultReportMoney(null, "SEK"), "—");
});

test("WorkContext validates activities, objects and domain compatibility", () => {
  const documents = documentsContext("fiktiv-ab", "2026-05");
  assert.doesNotThrow(() => validateWorkContext(documents));
  assert.deepEqual(parseWorkContext(documents), documents);
  assert.throws(() => validateWorkContext({ ...documents, area: "payroll" }), /WorkContext.area/);
  assert.throws(
    () =>
      validateWorkContext({
        ...documents,
        activity: "review",
        object: { kind: "document", id: "doc-1" },
      }),
    /WorkContext.object/,
  );
  assert.throws(
    () =>
      validateWorkContext({
        ...documents,
        activity: "artifacts",
        object: { kind: "run", id: "run-1" },
      }),
    /WorkContext.object/,
  );
  const summary = {
    company: { id: "fiktiv-ab", name: "Fiktiv AB", language: "sv" },
    state: { sequence: 0, sha256: "a".repeat(64) },
    periods: [
      {
        id: "2026-05",
        sequence: 1,
        kind: "ordinary",
        start: "2026-05-01",
        end: "2026-05-31",
        status: "preliminary",
        uploadCount: 1,
        jobId: null,
        review: { id: "run-1", sha256: "b".repeat(64), kind: "proposal", approvable: true },
      },
    ],
    activePeriodId: "2026-05",
    uploads: [],
    artifacts: [],
  } as CompanySummary;
  assert.doesNotThrow(() =>
    validateWorkContextDomain(
      {
        companyId: "fiktiv-ab",
        area: "bookkeeping",
        periodId: "2026-05",
        activity: "review",
        object: { kind: "run", id: "run-1" },
      },
      summary,
    ),
  );
  assert.throws(
    () =>
      validateWorkContextDomain(
        {
          companyId: "other-company",
          area: "bookkeeping",
          periodId: "2026-05",
          activity: "documents",
        },
        summary,
      ),
    /companyId/,
  );
  assert.equal(
    isWorkContextValidForSummary(
      {
        companyId: "fiktiv-ab",
        area: "bookkeeping",
        periodId: "missing",
        activity: "documents",
      },
      summary,
    ),
    false,
  );
  assert.equal(
    isWorkContextValidForSummary(
      {
        companyId: "fiktiv-ab",
        area: "bookkeeping",
        periodId: "2026-05",
        activity: "review",
        object: { kind: "run", id: "old-run" },
      },
      summary,
    ),
    false,
  );
  assert.deepEqual(
    switchWorkContextPeriod(
      {
        companyId: "fiktiv-ab",
        area: "bookkeeping",
        periodId: "2026-05",
        activity: "review",
        object: { kind: "run", id: "run-1" },
      },
      "Uppstart",
    ),
    documentsContext("fiktiv-ab", "Uppstart"),
  );
});

test("new chat events retain the submitted WorkContext snapshot", () => {
  const database = createDatabase(":memory:");
  const context = documentsContext("fiktiv-ab", "2026-05");
  appendChatMessage("user", "message-1", "Visa underlagen", "owner-1", database, context);
  const event = conversationEvents(0, database).at(-1);
  assert.deepEqual(event?.payload.workContext, context);
  appendChatMessage("assistant", "message-2", "Här är underlagen.", "bergbok-chat", database);
  assert.equal(conversationEvents(0, database).at(-1)?.payload.workContext, undefined);
});

test("WorkContext restore falls back from invalid sessions to the active period", () => {
  const summary = {
    company: { id: "fiktiv-ab", name: "Fiktiv AB", language: "sv" },
    state: { sequence: 0, sha256: "a".repeat(64) },
    periods: [
      {
        id: "Uppstart",
        sequence: 1,
        kind: "start",
        start: null,
        end: "2026-05-11",
        status: "approved",
        uploadCount: 0,
        jobId: null,
        review: null,
      },
      {
        id: "2026-05",
        sequence: 2,
        kind: "ordinary",
        start: "2026-05-12",
        end: "2026-05-31",
        status: "working",
        uploadCount: 0,
        jobId: null,
        review: null,
      },
    ],
    activePeriodId: "2026-05",
    uploads: [],
    artifacts: [],
  } as CompanySummary;
  assert.deepEqual(defaultWorkContext(summary), documentsContext("fiktiv-ab", "2026-05"));
  assert.deepEqual(
    restoreWorkContext(
      {
        companyId: "fiktiv-ab",
        area: "bookkeeping",
        periodId: "missing",
        activity: "documents",
      },
      summary,
    ),
    documentsContext("fiktiv-ab", "2026-05"),
  );
  assert.deepEqual(
    restoreWorkContext(
      {
        companyId: "fiktiv-ab",
        area: "bookkeeping",
        periodId: "2026-05",
        activity: "documents",
        object: { kind: "document", id: "gone" },
      },
      summary,
      ["current"],
    ),
    documentsContext("fiktiv-ab", "2026-05"),
  );
});

test("database bootstraps Fiktiv AB with the fixture periods", () => {
  const database = createDatabase(":memory:");
  assert.deepEqual(periodValue("Uppstart", database), {
    id: "Uppstart",
    kind: "start",
    end: "2026-05-11",
  });
  assert.deepEqual(periodValue("2026-05", database), {
    id: "2026-05",
    kind: "ordinary",
    start: "2026-05-12",
    end: "2026-05-31",
  });
  assert.deepEqual(periodValue("2026-07", database), {
    id: "2026-07",
    kind: "ordinary",
    start: "2026-07-01",
    end: "2026-07-31",
  });
  assert.deepEqual(periodValue("2026-08", database), {
    id: "2026-08",
    kind: "ordinary",
    start: "2026-08-01",
    end: "2026-08-31",
  });
  assert.deepEqual(
    (
      database.prepare("SELECT id FROM company_periods ORDER BY sequence").all() as Array<{
        id: string;
      }>
    ).map(({ id }) => id),
    ["Uppstart", "2026-05", "2026-06", "2026-07", "2026-08"],
  );
  assert.equal(
    (database.prepare("SELECT COUNT(*) count FROM uploads").get() as { count: number }).count,
    0,
  );
});

test("a completed chat tool can navigate the work context only once", () => {
  const handled = new Set<string>();
  const periodResult = {
    workContext: {
      companyId: "fiktiv-ab",
      area: "bookkeeping",
      periodId: "Uppstart",
      activity: "documents",
    },
  };
  assert.deepEqual(claimWorkContextNavigation(handled, "call-1", periodResult), {
    companyId: "fiktiv-ab",
    area: "bookkeeping",
    periodId: "Uppstart",
    activity: "documents",
  });
  assert.equal(
    claimWorkContextNavigation(handled, "call-1", {
      workContext: { ...periodResult.workContext, periodId: "2026-05" },
    }),
    null,
  );
  assert.deepEqual(
    claimWorkContextNavigation(handled, "call-2", {
      workContext: {
        companyId: "fiktiv-ab",
        area: "bookkeeping",
        periodId: "Uppstart",
        activity: "review",
        object: { kind: "run", id: "run-1" },
      },
    }),
    {
      companyId: "fiktiv-ab",
      area: "bookkeeping",
      periodId: "Uppstart",
      activity: "review",
      object: { kind: "run", id: "run-1" },
    },
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
    assert.equal(assigned.periodId, "Uppstart");
    summary = await companySummary(database);
    assert.equal(summary.periods[0].uploadCount, 1);
    assert.equal(summary.periods[1].status, "locked");
    const job = enqueueRun(session, "Uppstart", database);
    assert.equal(job.status, "queued");
    assert.equal(claimJob(database)?.id, job.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an upload explicitly targeted at the selected period is assigned there", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-web-selected-upload-test-"));
  process.env.BERGBOK_DATA_ROOT = root;
  process.env.BERGBOK_OWNER_EMAIL = session.email;
  try {
    const database = createDatabase(":memory:");
    database
      .prepare(
        "INSERT INTO bookkeeping_jobs (id,company_id,period_id,status,created_by,created_at,finished_at,run_id) VALUES ('selected-job','fiktiv-ab','Uppstart','proposal','owner-1',1,1,'selected-run')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO bookkeeping_runs (id,company_id,period_id,job_id,outcome_kind,run_ref_json,run_sha256,decision,decided_at,created_at) VALUES ('selected-run','fiktiv-ab','Uppstart','selected-job','proposal','{}',?,'approved',2,1)",
      )
      .run("a".repeat(64));
    const uploaded = await receiveUpload(
      session,
      new File(["Vald period\n"], "vald-period.md", { type: "text/markdown" }),
      database,
      "2026-05",
    );
    assert.equal(uploaded.status, "assigned");
    const summary = await companySummary(database);
    assert.equal(summary.periods.find(({ id }) => id === "2026-05")?.uploadCount, 1);
    assert.equal(summary.periods.find(({ id }) => id === "Uppstart")?.uploadCount, 0);
    assert.equal((await periodDetail("2026-05", database)).pendingUploads.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pending uploads distinguish assignment progress from review", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-web-pending-upload-test-"));
  process.env.BERGBOK_DATA_ROOT = root;
  process.env.BERGBOK_OWNER_EMAIL = session.email;
  try {
    const database = createDatabase(":memory:");
    const now = Date.now();
    const insert = database.prepare(
      "INSERT INTO uploads (id,company_id,log_item_id,filename,media_type,sha256,byte_length,status,period_id,document_id,duplicate_of,created_by,created_at,updated_at,origin,parent_document_id,replaces_document_id,target_period_id) VALUES (?,?,?,?,?,?,?,'unassigned',NULL,NULL,?,?,?,?, 'upload',NULL,NULL,?)",
    );
    const add = (
      id: string,
      filename: string,
      createdAt: number,
      targetPeriodId: string | null,
      duplicateOf: string | null = null,
    ) =>
      insert.run(
        id,
        "fiktiv-ab",
        `log-${id}`,
        filename,
        "application/pdf",
        id.padEnd(64, "a").slice(0, 64),
        100,
        duplicateOf,
        "owner",
        createdAt,
        createdAt,
        targetPeriodId,
      );
    add("recent", "pågår.pdf", now, "2026-08");
    add("stale", "gammal.pdf", now - UPLOAD_ASSIGNMENT_PENDING_WINDOW_MS - 1, "2026-08");
    add("manual", "manuell.pdf", now, null);
    add("duplicate", "kopia.pdf", now, "2026-08", "existing-upload");

    const august = await periodDetail("2026-08", database);
    assert.equal(
      august.pendingUploads.find(({ id }) => id === "recent")?.assignmentState,
      "assigning",
    );
    assert.equal(
      august.pendingUploads.find(({ id }) => id === "stale")?.assignmentState,
      "needs_review",
    );
    assert.equal(
      august.pendingUploads.find(({ id }) => id === "duplicate")?.assignmentState,
      "needs_review",
    );
    const activePeriod = await periodDetail("Uppstart", database);
    assert.equal(
      activePeriod.pendingUploads.find(({ id }) => id === "manual")?.assignmentState,
      "needs_review",
    );
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
    INSERT INTO uploads VALUES ('source','fiktiv-ab','log','legacy.pdf','application/pdf','${"a".repeat(64)}',10,'assigned','Uppstart','doc-1',NULL,'owner',1,1);
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
      "Uppstart",
    );
    assert.equal(uploaded.status, "assigned");
    let detail = await periodDetail("Uppstart", database);
    assert.equal(detail.documents.length, 1);

    const duplicate = await receiveUpload(
      session,
      new File(["Originalt underlag\n"], "kopia.md", { type: "text/markdown" }),
      database,
      "Uppstart",
    );
    assert.equal(duplicate.status, "unassigned");
    assert.ok(duplicate.duplicateOf);
    detail = await periodDetail("Uppstart", database);
    assert.equal(detail.pendingUploads.length, 1);
    await assignUpload(session, duplicate.id, "ignore", database);

    const authored = await createTextDocument(
      session,
      "Uppstart",
      "egen-uppgift",
      "# Uppgift\n\nFaktureringsmetoden används.\n",
      database,
    );
    const note = await addDocumentNote(
      session,
      "Uppstart",
      String(uploaded.documentId),
      "Kontrollerad mot avtalet.",
      database,
    );
    const parent = await documentDetail("Uppstart", String(uploaded.documentId), database);
    assert.equal(parent.notes[0].id, note.documentId);

    const replaced = await replaceTextDocument(
      session,
      "Uppstart",
      String(authored.documentId),
      "# Uppdaterad uppgift\n",
      database,
    );
    detail = await periodDetail("Uppstart", database);
    assert.ok(!detail.documents.some((document) => document.id === authored.documentId));
    assert.ok(detail.documents.some((document) => document.id === replaced.documentId));
    await assert.rejects(
      replaceTextDocument(session, "Uppstart", String(uploaded.documentId), "försök", database),
      /Uppladdade original/,
    );

    await removePeriodDocument(session, "Uppstart", replaced.documentId, database);
    detail = await periodDetail("Uppstart", database);
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
        "INSERT INTO bookkeeping_jobs (id,company_id,period_id,status,created_by,created_at,finished_at,run_id) VALUES ('job','fiktiv-ab','Uppstart','proposal','owner',1,1,'run')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO bookkeeping_runs (id,company_id,period_id,job_id,outcome_kind,run_ref_json,run_sha256,created_at) VALUES ('run','fiktiv-ab','Uppstart','job','proposal','{}',?,1)",
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
    await createTextDocument(session, "Uppstart", "nytt.md", "Ny uppgift", database);
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
      "Uppstart",
    );
    enqueueRun(session, "Uppstart", database);
    const job = claimJob(database);
    assert.ok(job);
    const processed = await processJob(job, database, async (caseBundle) => {
      const documentId = caseBundle.payload.docset.payload.documents[0].document_id;
      return Bookkeeping.consolidateOffline(caseBundle, "offline-change-request-test-v1", {
        input: {
          schema_id: "se.bergbok.bookkeeping-input",
          schema_version: "3.0",
          company_id: "fiktiv-ab",
          period_id: "Uppstart",
          mode: "start",
          organization: { name: "Fiktiv AB", organization_number: "559999-9999" },
          transactions: [],
          open_item_changes: [],
          reconciliations: [],
        },
        core: {
          organization: { name: "Fiktiv AB", organization_number: "559999-9999" },
          evidence_document_ids: [documentId],
          policies: { bookkeeping: bookkeepingCorePolicy() },
        },
        assessment: { questions: [], warnings: [], reasons: [] },
      });
    });
    await requestProposalChanges(
      session,
      "Uppstart",
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
  const tools = createApplicationTools(session, {
    companyId: "fiktiv-ab",
    area: "bookkeeping",
    periodId: "Uppstart",
    activity: "documents",
  });
  assert.ok(MUTATION_TOOL_NAMES.every((name) => name in tools));
  assert.ok(READ_TOOL_NAMES.every((name) => name in tools));
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
    "get_result_report",
  ]);
});

test("clear bookkeeping chat commands select the trusted run tool", () => {
  assert.equal(isDirectBookkeepingCommand("Bokför 2026-05"), true);
  assert.equal(isDirectBookkeepingCommand("Kan du bokföra perioden Uppstart?"), true);
  // Databases seeded before the rename still hold "Start"; both must be recognised.
  assert.equal(isDirectBookkeepingCommand("Kan du bokföra perioden Start?"), true);
  assert.equal(isDirectBookkeepingCommand("Bokför den här perioden"), false);
  assert.equal(isDirectBookkeepingCommand("Hur bokför jag 2026-05?"), false);
});

test("only clear resultatrapport imperatives force the trusted report tool", () => {
  assert.equal(
    isDirectResultReportCommand("Skapa en resultatrapport för maj–september 2026, månadsvis"),
    true,
  );
  assert.equal(isDirectResultReportCommand("Visa augusti 2026 som resultatrapport"), true);
  assert.equal(isDirectResultReportCommand("Kan du ta fram en resultatrapport?"), true);
  assert.equal(isDirectResultReportCommand("Vad är en resultatrapport?"), false);
  assert.equal(isDirectResultReportCommand("Hur läser jag en resultatrapport?"), false);
});

test("chat context identifies the latest approved bookkeeping cutoff", () => {
  assert.deepEqual(
    approvedBookkeepingThrough([
      { id: "Uppstart", sequence: 1, status: "approved", end: "2026-05-11" },
      { id: "2026-05", sequence: 2, status: "approved", end: "2026-05-31" },
      { id: "2026-06", sequence: 3, status: "approved", end: "2026-06-30" },
      { id: "2026-07", sequence: 4, status: "working", end: "2026-07-31" },
    ]),
    { period_id: "2026-06", end: "2026-06-30" },
  );
  assert.equal(
    approvedBookkeepingThrough([
      { id: "Uppstart", sequence: 1, status: "preliminary", end: "2026-05-11" },
    ]),
    null,
  );
});

test("job recovery fails abandoned work without retrying it", () => {
  const database = createDatabase(":memory:");
  database
    .prepare(
      "INSERT INTO bookkeeping_jobs (id,company_id,period_id,status,created_by,created_at,heartbeat_at) VALUES ('job','fiktiv-ab','Uppstart','running','owner',1,1)",
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
    enqueueRun(session, "Uppstart", database);
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
          review: {
            schema_version: "1.0",
            language: "sv",
            narrative_source: "ai",
            summary: "En fråga måste besvaras",
            transaction_summaries: [],
          },
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
    const report = await reviewContent(result.runId, "html", database);
    assert.equal(report.mediaType, "text/html; charset=utf-8");
    assert.match(report.bytes.toString("utf8"), /Vilket belopp gäller\?/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Uppstart, May and June can be proposed, approved and rendered in order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-web-continuity-test-"));
  process.env.BERGBOK_DATA_ROOT = root;
  process.env.BERGBOK_OWNER_EMAIL = session.email;
  try {
    const database = createDatabase(":memory:");
    for (const periodId of ["Uppstart", "2026-05", "2026-06"]) {
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
            schema_version: "3.0",
            company_id: "fiktiv-ab",
            period_id: period.id,
            mode: period.kind,
            organization: {
              name: "Fiktiv AB",
              organization_number: "559999-9999",
            },
            transactions:
              period.id === "2026-05"
                ? [
                    {
                      source_id: "sale:2026-05",
                      date: "2026-05-15",
                      description: "Sale with output VAT",
                      evidence_document_ids: [documentId],
                      lines: [
                        {
                          account: "1930",
                          account_name: "Bank",
                          debit: "125.00 SEK",
                          credit: "0.00 SEK",
                        },
                        {
                          account: "3001",
                          account_name: "Sales",
                          debit: "0.00 SEK",
                          credit: "100.00 SEK",
                        },
                        {
                          account: "2611",
                          account_name: "Output VAT",
                          debit: "0.00 SEK",
                          credit: "25.00 SEK",
                        },
                      ],
                    },
                  ]
                : [],
            open_item_changes: [],
            reconciliations: [],
          },
          ...(period.kind === "start"
            ? {
                core: {
                  organization: {
                    name: "Fiktiv AB",
                    organization_number: "559999-9999",
                  },
                  evidence_document_ids: [documentId],
                  policies: { bookkeeping: bookkeepingCorePolicy() },
                },
              }
            : {}),
          assessment: { questions: [], warnings: [], reasons: [] },
        });
      });
      assert.equal(
        processed.outcome.kind,
        "proposal",
        `${periodId}: ${JSON.stringify(processed.outcome.questions ?? processed.outcome.reasons)}`,
      );
      if (periodId === "Uppstart") {
        const source = await reviewContent(processed.runId, "json", database);
        assert.equal(JSON.parse(source.bytes.toString("utf8")).payload.contract_version, "2.0");
        const html = await reviewContent(processed.runId, "html", database);
        const reportHtml = html.bytes.toString("utf8");
        assert.match(reportHtml, /Bokföringsrapport/);
        assert.match(reportHtml, /Ingen ingående eller utgående moms bokfördes i perioden/);
        // The VAT cadence is a company fact, so it appears once under Företagsuppgifter;
        // the Moms section stays a plain sentence for a period without VAT activity.
        assert.match(
          reportHtml,
          /<h2>Företagsuppgifter<\/h2>[\s\S]*<dt>Redovisningsintervall<\/dt><dd>Kvartalsvis<\/dd>/,
        );
        assert.doesNotMatch(reportHtml.slice(reportHtml.indexOf("<h2>Moms</h2>")), /Kvartalsvis/);
        const pdf = await reviewContent(processed.runId, "pdf", database);
        assert.match(pdf.bytes.subarray(0, 8).toString("latin1"), /^%PDF-/);
      }
      if (periodId === "2026-05") {
        assert.equal(
          processed.outcome.canonical_outputs.bookkeeping.vat_period.due_in_period,
          false,
        );
        assert.equal(
          processed.outcome.canonical_outputs.bookkeeping.vat_period.cycle_end,
          "2026-06-30",
        );
      }
      if (periodId === "2026-06") {
        assert.equal(
          processed.outcome.canonical_outputs.bookkeeping.vat_period.due_in_period,
          true,
        );
        assert.equal(
          processed.outcome.canonical_outputs.bookkeeping.vat_period.closing_transaction_source_id,
          "vat-closing",
        );
        assert.equal(
          processed.outcome.canonical_outputs.bookkeeping.vat_period.declaration_boxes["49"],
          "25.00 SEK",
        );
      }
      await decideRun(session, processed.runId, processed.stored.ref.sha256, "approved", database);
    }
    const summary = await companySummary(database);
    assert.deepEqual(
      summary.periods.map((period) => period.status),
      ["approved", "approved", "approved", "working", "locked"],
    );
    assert.equal(summary.activePeriodId, "2026-07");
    assert.equal(summary.artifacts.length, 12);

    const report = await getResultReport(
      { fromMonth: "2026-05", toMonth: "2026-07", layout: "monthly" },
      database,
    );
    assert.equal(report.payload.coverage.status, "partially_covered");
    assert.deepEqual(report.payload.coverage.uncovered_months, ["2026-07"]);
    assert.equal(
      report.payload.rows.find(({ id }: { id: string }) => id === "calculated_result").values[
        "2026-05"
      ],
      "100.00 SEK",
    );
    assert.equal(report.payload.source.approved_run_refs.length, 2);
    assert.equal(report.payload.source.state_ref.sha256, summary.state.sha256);

    const defaultReport = await getResultReport({ selectedPeriodId: "2026-06" }, database);
    assert.deepEqual(defaultReport.payload.requested_range, {
      from_month: "2026-05",
      to_month: "2026-06",
    });
    assert.equal(defaultReport.payload.layout, "monthly");

    const rawParts = [
      { type: "reasoning", text: "hidden" },
      { type: "text", text: "Här är rapporten." },
      {
        type: "tool-shell",
        toolCallId: "shell-1",
        state: "output-available",
        output: "secret",
      },
      {
        type: "tool-get_result_report",
        toolCallId: "report-1",
        state: "output-available",
        input: { fromMonth: "2026-05", toMonth: "2026-07", layout: "monthly" },
        output: { ok: true, report },
      },
    ];
    const saved = sanitizeAssistantParts(rawParts);
    assert.equal(saved.parts.length, 2);
    assert.equal(saved.text, "Här är rapporten.");
    appendChatMessage(
      "assistant",
      "report-message",
      saved.text,
      "bergbok-chat",
      database,
      null,
      saved.parts,
    );
    const stored = conversationEvents(0, database).at(-1);
    assert.ok(stored);
    assert.equal(stored.payload.parts[1].output.report.ref.sha256, report.ref.sha256);

    const safeForModel = messagesForNewClaims([
      {
        id: "report-message",
        role: "assistant",
        metadata: { responseId: "resp-provider-owned" },
        parts: [
          {
            type: "reasoning",
            text: "hidden",
            providerMetadata: {
              openai: {
                itemId: "rs-provider-owned",
              },
            },
          },
          {
            type: "text",
            text: "Här är rapporten.",
            providerMetadata: {
              openai: {
                itemId: "msg-provider-owned",
              },
            },
          },
          saved.parts[1],
        ] as never,
      },
    ]);
    assert.deepEqual(safeForModel, [
      {
        id: "report-message",
        role: "assistant",
        parts: [{ type: "text", text: "Här är rapporten." }],
      },
    ]);
    assert.doesNotMatch(JSON.stringify(safeForModel), /provider-owned/);
    assert.deepEqual(await convertToModelMessages(safeForModel), [
      {
        role: "assistant",
        content: [{ type: "text", text: "Här är rapporten." }],
      },
    ]);

    const tampered = structuredClone(stored.payload);
    tampered.parts[1].output.report.payload.rows[0].label = "Manipulerad";
    database
      .prepare("UPDATE conversation_events SET payload_json=? WHERE id=?")
      .run(JSON.stringify(tampered), stored.id);
    const unavailable = conversationEvents(0, database).at(-1)?.payload.parts[1].output;
    assert.equal(unavailable.unavailable, true);
    assert.equal(unavailable.report, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function bookkeepingCorePolicy() {
  return {
    chart_of_accounts: "BAS",
    vat_reporting: {
      frequency: "quarterly",
      chart: "BAS-2026",
      settlement_account: "2650",
      box_overrides: [],
    },
  };
}

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
  assert.equal(
    normalizeUploadMediaType("image/png", Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
    "image/jpeg",
  );
  assert.equal(
    normalizeUploadMediaType(
      "image/jpeg",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ),
    "image/png",
  );
  assert.throws(
    () => normalizeUploadMediaType("image/png", Buffer.from("not an image")),
    /giltig PNG/,
  );
});
