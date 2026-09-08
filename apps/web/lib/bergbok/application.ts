import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CompanyRecord, Artifacts } from "@bergbok/modular-system";
import type { AuthenticatedSession } from "./auth-types.ts";
import { appConfig } from "./config.ts";
import { getDatabase, type BergbokDatabase } from "./database.ts";
import {
  validateBookkeepingJob,
  validateCompanySummary,
  validateConversationEvent,
  validatePeriodDetail,
  validateUploadRecord,
  type WorkContext,
  type DocumentDetail,
  type DocumentOrigin,
  type PeriodDetail,
  type PeriodDocumentSummary,
  type UploadRecord,
} from "./types.ts";

export const COMPANY_ID = "fiktiv-ab";
export const CONVERSATION_ID = "fiktiv-ab-main";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const ALLOWED_MEDIA_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/markdown",
  "text/plain",
]);

export type PeriodValue = { id: string; kind: "start" | "ordinary"; start?: string; end: string };
export type PeriodStatus = "locked" | "working" | "running" | "preliminary" | "approved";

export const actorFor = (session: AuthenticatedSession) => ({
  id: session.userId,
  role: "owner",
  email: session.email,
});

export async function companyRecord() {
  const rootDir = appConfig().recordRoot;
  try {
    await access(path.join(rootDir, "control", "catalog.json"));
    return await CompanyRecord.open({ rootDir, companyId: COMPANY_ID });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path.dirname(rootDir), { recursive: true });
    return await CompanyRecord.create({
      rootDir,
      companyId: COMPANY_ID,
      language: "sv",
      initialState: { core: {}, domains: {} },
      actor: { id: "bergbok-bootstrap", role: "system" },
    });
  }
}

export function periodValue(id: string, database = getDatabase()): PeriodValue {
  const row = database
    .prepare("SELECT id,kind,start_date,end_date FROM company_periods WHERE company_id=? AND id=?")
    .get(COMPANY_ID, id) as
    | { id: string; kind: "start" | "ordinary"; start_date: string | null; end_date: string }
    | undefined;
  if (!row) throw httpError(404, `Perioden ${id} finns inte.`);
  return {
    id: row.id,
    kind: row.kind,
    ...(row.start_date ? { start: row.start_date } : {}),
    end: row.end_date,
  };
}

export function appendEvent(
  type: string,
  actorId: string | null,
  payload: unknown,
  database = getDatabase(),
) {
  const now = Date.now();
  const result = database
    .prepare(
      "INSERT INTO conversation_events (conversation_id,company_id,type,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(CONVERSATION_ID, COMPANY_ID, type, actorId, JSON.stringify(payload), now);
  database.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, CONVERSATION_ID);
  return Number(result.lastInsertRowid);
}

export function conversationEvents(after = 0, database = getDatabase()) {
  const events = (
    database
      .prepare(
        "SELECT id,type,actor_id,payload_json,created_at FROM conversation_events WHERE conversation_id=? AND id>? ORDER BY id LIMIT 500",
      )
      .all(CONVERSATION_ID, after) as Array<{
      id: number;
      type: string;
      actor_id: string | null;
      payload_json: string;
      created_at: number;
    }>
  ).map((row) => ({
    id: row.id,
    type: row.type,
    actorId: row.actor_id,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  }));
  events.forEach(validateConversationEvent);
  return events;
}

export function appendChatMessage(
  role: "user" | "assistant",
  messageId: string,
  text: string,
  actorId: string | null,
  database = getDatabase(),
  workContext: WorkContext | null = null,
) {
  if (!text.trim()) return null;
  const previous = database
    .prepare(
      "SELECT payload_json FROM conversation_events WHERE conversation_id=? AND type=? ORDER BY id DESC LIMIT 1",
    )
    .get(CONVERSATION_ID, `chat_${role}`) as { payload_json: string } | undefined;
  if (previous && JSON.parse(previous.payload_json).messageId === messageId) return null;
  return appendEvent(
    `chat_${role}`,
    actorId,
    { messageId, text: text.trim(), ...(workContext ? { workContext } : {}) },
    database,
  );
}

export async function companySummary(database = getDatabase()) {
  const record = await companyRecord();
  const state = await record.read({ kind: "state" });
  const rows = database
    .prepare(
      "SELECT id,sequence,kind,start_date,end_date FROM company_periods WHERE company_id=? ORDER BY sequence",
    )
    .all(COMPANY_ID) as Array<{
    id: string;
    sequence: number;
    kind: string;
    start_date: string | null;
    end_date: string;
  }>;
  const approved = new Set(
    (
      database
        .prepare(
          "SELECT period_id FROM bookkeeping_runs WHERE company_id=? AND decision='approved'",
        )
        .all(COMPANY_ID) as Array<{ period_id: string }>
    ).map((row) => row.period_id),
  );
  const periods = [];
  for (const row of rows) {
    const prior = rows.find((candidate) => candidate.sequence === row.sequence - 1);
    const locked = Boolean(prior && !approved.has(prior.id));
    const running = database
      .prepare(
        "SELECT id,status FROM bookkeeping_jobs WHERE company_id=? AND period_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
      )
      .get(COMPANY_ID, row.id) as { id: string; status: string } | undefined;
    const review = database
      .prepare(
        "SELECT id,run_sha256,outcome_kind FROM bookkeeping_runs WHERE company_id=? AND period_id=? AND decision IS NULL AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(COMPANY_ID, row.id) as
      | {
          id: string;
          run_sha256: string;
          outcome_kind: "proposal" | "needs_input" | "out_of_scope";
        }
      | undefined;
    const uploadCount = (
      database
        .prepare(
          "SELECT COUNT(*) count FROM docset_entries WHERE company_id=? AND period_id=? AND status='active'",
        )
        .get(COMPANY_ID, row.id) as { count: number }
    ).count;
    const status: PeriodStatus = approved.has(row.id)
      ? "approved"
      : locked
        ? "locked"
        : running
          ? "running"
          : review?.outcome_kind === "proposal"
            ? "preliminary"
            : "working";
    periods.push({
      id: row.id,
      sequence: row.sequence,
      kind: row.kind,
      start: row.start_date,
      end: row.end_date,
      status,
      uploadCount,
      jobId: running?.id ?? null,
      review: review
        ? {
            id: review.id,
            sha256: review.run_sha256,
            kind: review.outcome_kind,
            approvable: review.outcome_kind === "proposal",
          }
        : null,
    });
  }
  const active =
    periods.find((period) => period.status !== "approved" && period.status !== "locked") ?? null;
  const uploads = database
    .prepare(
      "SELECT id,filename,media_type,sha256,byte_length,status,period_id,document_id,duplicate_of,created_at FROM uploads WHERE company_id=? ORDER BY created_at,id",
    )
    .all(COMPANY_ID);
  const artifacts = database
    .prepare(
      "SELECT id,run_id,profile,filename,media_type,sha256,byte_length,created_at FROM artifacts WHERE company_id=? ORDER BY created_at,id",
    )
    .all(COMPANY_ID);
  const summary = {
    company: { id: COMPANY_ID, name: "Fiktiv AB", language: "sv" },
    state: { sequence: state.payload.sequence, sha256: state.ref.sha256 },
    periods,
    activePeriodId: active?.id ?? null,
    uploads,
    artifacts,
  };
  validateCompanySummary(summary);
  return summary;
}

type SourceInput = {
  filename: string;
  mediaType: string;
  bytes: Buffer;
  origin: DocumentOrigin;
  targetPeriodId?: string | null;
  parentDocumentId?: string | null;
  replacesDocumentId?: string | null;
  metadata?: Record<string, unknown>;
};

async function ingestSource(
  session: AuthenticatedSession,
  input: SourceInput,
  database: BergbokDatabase,
) {
  const record = await companyRecord();
  const logRef = await record.ingest(
    {
      filename: input.filename,
      media_type: input.mediaType,
      bytes: input.bytes,
      suggested_period: input.targetPeriodId ?? null,
      metadata: {
        ...input.metadata,
        origin: input.origin,
        ...(input.parentDocumentId ? { parent_document_id: input.parentDocumentId } : {}),
        ...(input.replacesDocumentId ? { replaces_document_id: input.replacesDocumentId } : {}),
      },
    },
    actorFor(session),
  );
  const logItem = await record.read(logRef);
  const id = randomUUID();
  const now = Date.now();
  database
    .prepare(
      "INSERT INTO uploads (id,company_id,log_item_id,filename,media_type,sha256,byte_length,status,created_by,created_at,updated_at,origin,parent_document_id,replaces_document_id,target_period_id) VALUES (?,?,?,?,?,?,?,'unassigned',?,?,?,?,?,?,?)",
    )
    .run(
      id,
      COMPANY_ID,
      logRef.stable_id,
      input.filename,
      input.mediaType,
      logItem.payload.sha256,
      input.bytes.length,
      session.userId,
      now,
      now,
      input.origin,
      input.parentDocumentId ?? null,
      input.replacesDocumentId ?? null,
      input.targetPeriodId ?? null,
    );
  return { id, logRef, logItem };
}

const sourceRowForDocument = (documentId: string, database: BergbokDatabase) =>
  database
    .prepare(
      "SELECT u.* FROM uploads u JOIN docset_entries d ON d.upload_id=u.id WHERE d.company_id=? AND d.document_id=? ORDER BY d.created_at DESC LIMIT 1",
    )
    .get(COMPANY_ID, documentId) as Record<string, unknown> | undefined;

const mapPeriodDocument = (
  document: Record<string, unknown>,
  source: Record<string, unknown>,
): PeriodDocumentSummary => ({
  id: String(document.document_id),
  sourceId: String(source.id),
  filename: String(document.filename ?? source.filename),
  mediaType: String(document.media_type ?? source.media_type),
  sha256: String(document.sha256 ?? source.sha256),
  byteLength: Number(document.byte_length ?? source.byte_length),
  role: String(document.role ?? "evidence"),
  origin: String(source.origin ?? "upload") as DocumentOrigin,
  parentDocumentId:
    typeof source.parent_document_id === "string" ? source.parent_document_id : null,
  replacesDocumentId:
    typeof source.replaces_document_id === "string" ? source.replaces_document_id : null,
  contentUrl: `/api/documents/${String(source.id)}`,
});

export async function periodDocuments(periodId: string, database = getDatabase()) {
  const period = periodValue(periodId, database);
  const current = await (await companyRecord()).read({ kind: "docset", period });
  const raw = (current?.payload?.documents ?? []) as Array<Record<string, unknown>>;
  return raw.map((document) => {
    const source = sourceRowForDocument(String(document.document_id), database);
    if (!source) throw httpError(500, `Dokumentindex saknas för ${String(document.document_id)}.`);
    return mapPeriodDocument(document, source);
  });
}

export async function periodDetail(
  periodId: string,
  database = getDatabase(),
): Promise<PeriodDetail> {
  const summary = await companySummary(database);
  const period = summary.periods.find((candidate) => candidate.id === periodId);
  if (!period) throw httpError(404, `Perioden ${periodId} finns inte.`);
  const documents = await periodDocuments(periodId, database);
  const pendingUploads = database
    .prepare(
      "SELECT id,filename,media_type,sha256,byte_length,status,period_id,document_id,duplicate_of,origin,target_period_id FROM uploads WHERE company_id=? AND status='unassigned' AND (target_period_id=? OR (target_period_id IS NULL AND ?=1)) ORDER BY created_at,id",
    )
    .all(
      COMPANY_ID,
      periodId,
      summary.activePeriodId === periodId ? 1 : 0,
    ) as PeriodDetail["pendingUploads"];
  const artifacts = database
    .prepare(
      "SELECT a.id,a.run_id,a.profile,a.filename,a.media_type,a.sha256,a.byte_length,a.created_at FROM artifacts a JOIN bookkeeping_runs r ON r.id=a.run_id WHERE a.company_id=? AND r.period_id=? ORDER BY a.created_at,a.id",
    )
    .all(COMPANY_ID, periodId) as PeriodDetail["artifacts"];
  const latestJobRow = database
    .prepare(
      "SELECT j.id,j.status,j.phase,j.created_at,j.started_at,j.heartbeat_at,j.phase_changed_at,j.finished_at,j.error_message FROM bookkeeping_jobs j WHERE j.company_id=? AND j.period_id=? ORDER BY j.created_at DESC LIMIT 1",
    )
    .get(COMPANY_ID, periodId) as
    | {
        id: string;
        status: NonNullable<PeriodDetail["latestJob"]>["status"];
        phase: NonNullable<PeriodDetail["latestJob"]>["phase"];
        created_at: number;
        started_at: number | null;
        heartbeat_at: number | null;
        phase_changed_at: number | null;
        finished_at: number | null;
        error_message: string | null;
      }
    | undefined;
  const detail = {
    period,
    editable:
      summary.activePeriodId === periodId &&
      (period.status === "working" || period.status === "preliminary"),
    documents,
    pendingUploads,
    artifacts,
    latestJob: latestJobRow
      ? {
          id: latestJobRow.id,
          status: latestJobRow.status,
          phase: latestJobRow.phase,
          createdAt: latestJobRow.created_at,
          startedAt: latestJobRow.started_at,
          heartbeatAt: latestJobRow.heartbeat_at,
          phaseChangedAt: latestJobRow.phase_changed_at,
          finishedAt: latestJobRow.finished_at,
          errorMessage: latestJobRow.error_message,
        }
      : null,
  };
  validatePeriodDetail(detail);
  return detail;
}

export async function documentDetail(
  periodId: string,
  documentId: string,
  database = getDatabase(),
): Promise<DocumentDetail> {
  const documents = await periodDocuments(periodId, database);
  const document = documents.find((candidate) => candidate.id === documentId);
  if (!document) throw httpError(404, "Dokumentet finns inte i periodens aktuella underlag.");
  const content = await uploadedContent(document.sourceId, database);
  const isText = document.mediaType === "text/plain" || document.mediaType === "text/markdown";
  return {
    ...document,
    periodId,
    text: isText ? content.bytes.toString("utf8") : null,
    notes: documents.filter((candidate) => candidate.parentDocumentId === documentId),
  };
}

async function assertEditablePeriod(
  periodId: string,
  database: BergbokDatabase,
  knownSummary?: Awaited<ReturnType<typeof companySummary>>,
) {
  const summary = knownSummary ?? (await companySummary(database));
  const period = summary.periods.find((candidate) => candidate.id === periodId);
  if (!period) throw httpError(404, `Perioden ${periodId} finns inte.`);
  if (summary.activePeriodId !== periodId)
    throw httpError(409, "Endast den aktuella öppna perioden kan ändras.");
  if (period.status === "running")
    throw httpError(409, "Vänta tills den pågående bokföringen är klar.");
  if (period.status !== "working" && period.status !== "preliminary")
    throw httpError(409, "Perioden kan inte ändras.");
  return period;
}

function supersedeReview(
  periodId: string,
  actorId: string,
  reason: string,
  database: BergbokDatabase,
) {
  const now = Date.now();
  const result = database
    .prepare(
      "UPDATE bookkeeping_runs SET superseded_at=? WHERE company_id=? AND period_id=? AND decision IS NULL AND superseded_at IS NULL",
    )
    .run(now, COMPANY_ID, periodId);
  if (result.changes) appendEvent("review_superseded", actorId, { reason, periodId }, database);
}

const markdownFilename = (value: string) => {
  const safe = safeFilename(value.trim());
  return safe.toLowerCase().endsWith(".md") ? safe : `${safe}.md`;
};

export async function createTextDocument(
  session: AuthenticatedSession,
  periodId: string,
  filename: string,
  markdown: string,
  database = getDatabase(),
  options: { origin?: "text" | "note"; parentDocumentId?: string | null } = {},
) {
  await assertEditablePeriod(periodId, database);
  if (!markdown.trim() || markdown.length > 100_000)
    throw httpError(400, "Textunderlaget måste innehålla 1–100000 tecken.");
  if (options.parentDocumentId) await documentDetail(periodId, options.parentDocumentId, database);
  const normalizedFilename = markdownFilename(filename);
  const source = await ingestSource(
    session,
    {
      filename: normalizedFilename,
      mediaType: "text/markdown",
      bytes: Buffer.from(markdown, "utf8"),
      origin: options.origin ?? "text",
      targetPeriodId: periodId,
      parentDocumentId: options.parentDocumentId ?? null,
    },
    database,
  );
  const assigned = await assignUpload(session, source.id, "assign", database, periodId);
  appendEvent(
    options.origin === "note" ? "document_note_added" : "text_document_created",
    session.userId,
    { periodId, documentId: assigned.documentId, filename: normalizedFilename },
    database,
  );
  return { ...assigned, filename: normalizedFilename };
}

export async function addDocumentNote(
  session: AuthenticatedSession,
  periodId: string,
  documentId: string,
  markdown: string,
  database = getDatabase(),
) {
  const parent = await documentDetail(periodId, documentId, database);
  const stem = parent.filename.replace(/\.[^.]+$/, "").slice(0, 80);
  const suffix = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
  return createTextDocument(
    session,
    periodId,
    `${stem}-anteckning-${suffix}.md`,
    markdown,
    database,
    {
      origin: "note",
      parentDocumentId: documentId,
    },
  );
}

export async function replaceTextDocument(
  session: AuthenticatedSession,
  periodId: string,
  documentId: string,
  markdown: string,
  database = getDatabase(),
) {
  await assertEditablePeriod(periodId, database);
  const previous = await documentDetail(periodId, documentId, database);
  if (previous.origin === "upload" || previous.text === null)
    throw httpError(
      409,
      "Uppladdade original kan inte skrivas över. Lägg till en anteckning i stället.",
    );
  if (!markdown.trim() || markdown.length > 100_000)
    throw httpError(400, "Textunderlaget måste innehålla 1–100000 tecken.");
  const source = await ingestSource(
    session,
    {
      filename: previous.filename,
      mediaType: "text/markdown",
      bytes: Buffer.from(markdown, "utf8"),
      origin: previous.origin,
      targetPeriodId: periodId,
      parentDocumentId: previous.parentDocumentId,
      replacesDocumentId: documentId,
    },
    database,
  );
  const period = periodValue(periodId, database);
  const record = await companyRecord();
  const current = await record.read({ kind: "docset", period });
  const logItem = await record.read({ kind: "log_item", id: source.logRef.stable_id });
  const revision = await record.reviseDocset(period, current?.ref ?? null, {
    remove: [documentId],
    add: [
      {
        log_item_ref: logItem.ref,
        filename: previous.filename,
        media_type: "text/markdown",
        role: previous.role,
        metadata: {
          origin: previous.origin,
          parent_document_id: previous.parentDocumentId,
          replaces_document_id: documentId,
        },
      },
    ],
    actor: actorFor(session),
  });
  const added = revision.added_documents[0];
  const nextDocumentId = String(added.payload.document_id);
  const now = Date.now();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        "UPDATE docset_entries SET status='replaced',ended_at=? WHERE company_id=? AND period_id=? AND document_id=? AND status='active'",
      )
      .run(now, COMPANY_ID, periodId, documentId);
    database
      .prepare(
        "UPDATE uploads SET status='assigned',period_id=?,document_id=?,updated_at=? WHERE id=?",
      )
      .run(periodId, nextDocumentId, now, source.id);
    database
      .prepare(
        "INSERT INTO docset_entries (company_id,period_id,document_id,upload_id,status,parent_document_id,replaces_document_id,created_at) VALUES (?,?,?,?, 'active',?,?,?)",
      )
      .run(
        COMPANY_ID,
        periodId,
        nextDocumentId,
        source.id,
        previous.parentDocumentId,
        documentId,
        now,
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  supersedeReview(periodId, session.userId, "document_replaced", database);
  appendEvent(
    "text_document_replaced",
    session.userId,
    { periodId, previousDocumentId: documentId, documentId: nextDocumentId },
    database,
  );
  return { periodId, documentId: nextDocumentId, status: "assigned" };
}

export async function removePeriodDocument(
  session: AuthenticatedSession,
  periodId: string,
  documentId: string,
  database = getDatabase(),
) {
  await assertEditablePeriod(periodId, database);
  await documentDetail(periodId, documentId, database);
  const period = periodValue(periodId, database);
  const record = await companyRecord();
  const current = await record.read({ kind: "docset", period });
  await record.reviseDocset(period, current?.ref ?? null, {
    remove: [documentId],
    actor: actorFor(session),
  });
  const now = Date.now();
  database
    .prepare(
      "UPDATE docset_entries SET status='removed',ended_at=? WHERE company_id=? AND period_id=? AND document_id=? AND status='active'",
    )
    .run(now, COMPANY_ID, periodId, documentId);
  supersedeReview(periodId, session.userId, "document_removed", database);
  appendEvent("document_removed", session.userId, { periodId, documentId }, database);
  return { periodId, documentId, status: "removed" as const };
}

export async function receiveUpload(
  session: AuthenticatedSession,
  file: File,
  database = getDatabase(),
  targetPeriodId?: string | null,
): Promise<UploadRecord & { periodId?: string; documentId?: string }> {
  if (!ALLOWED_MEDIA_TYPES.has(file.type)) throw httpError(415, "Filtypen stöds inte.");
  if (file.size < 1 || file.size > MAX_UPLOAD_BYTES)
    throw httpError(413, "Filen måste vara mellan 1 byte och 25 MiB.");
  const filename = safeFilename(file.name);
  const bytes = Buffer.from(await file.arrayBuffer());
  validateUploadContent(file.type, bytes);
  if (targetPeriodId) await assertEditablePeriod(targetPeriodId, database);
  const { id, logItem } = await ingestSource(
    session,
    {
      filename,
      mediaType: file.type,
      bytes,
      origin: "upload",
      targetPeriodId: targetPeriodId ?? null,
      metadata: { original_filename: file.name },
    },
    database,
  );
  const duplicate = database
    .prepare(
      "SELECT id,filename,status FROM uploads WHERE company_id=? AND sha256=? AND id<>? ORDER BY created_at LIMIT 1",
    )
    .get(COMPANY_ID, logItem.payload.sha256, id) as
    | { id: string; filename: string; status: string }
    | undefined;
  if (duplicate)
    database
      .prepare("UPDATE uploads SET duplicate_of=?,updated_at=? WHERE id=?")
      .run(duplicate.id, Date.now(), id);
  const value = {
    id,
    filename,
    mediaType: file.type,
    sha256: logItem.payload.sha256,
    byteLength: bytes.length,
    status: "unassigned",
    duplicateOf: duplicate?.id ?? null,
    origin: "upload" as const,
  };
  validateUploadRecord(value);
  appendEvent("document_uploaded", session.userId, value, database);
  if (!duplicate && targetPeriodId) {
    const assigned = await assignUpload(session, id, "assign", database, targetPeriodId);
    return { ...value, ...assigned, duplicateOf: null };
  }
  return value;
}

export function assignUpload(
  session: AuthenticatedSession,
  uploadId: string,
  target: "assign",
  database?: BergbokDatabase,
  periodId?: string,
): Promise<{ status: "assigned"; periodId: string; documentId: string }>;
export function assignUpload(
  session: AuthenticatedSession,
  uploadId: string,
  target: "ignore",
  database?: BergbokDatabase,
  periodId?: string,
): Promise<{ status: "ignored" }>;
export function assignUpload(
  session: AuthenticatedSession,
  uploadId: string,
  target: "assign" | "ignore",
  database?: BergbokDatabase,
  periodId?: string,
): Promise<{ status: "ignored" } | { status: "assigned"; periodId: string; documentId: string }>;
export async function assignUpload(
  session: AuthenticatedSession,
  uploadId: string,
  target: "assign" | "ignore",
  database = getDatabase(),
  periodId?: string,
): Promise<{ status: "ignored" } | { status: "assigned"; periodId: string; documentId: string }> {
  const upload = database
    .prepare("SELECT * FROM uploads WHERE id=? AND company_id=?")
    .get(uploadId, COMPANY_ID) as Record<string, unknown> | undefined;
  if (!upload) throw httpError(404, "Uppladdningen finns inte.");
  if (upload.status !== "unassigned") throw httpError(409, "Uppladdningen är redan hanterad.");
  if (target === "ignore") {
    database
      .prepare("UPDATE uploads SET status='ignored',updated_at=? WHERE id=?")
      .run(Date.now(), uploadId);
    appendEvent("document_ignored", session.userId, { uploadId }, database);
    return { status: "ignored" as const };
  }
  const summary = await companySummary(database);
  const resolvedPeriodId = periodId ?? summary.activePeriodId;
  if (!resolvedPeriodId) throw httpError(409, "Alla perioder är redan godkända.");
  await assertEditablePeriod(resolvedPeriodId, database, summary);
  const period = periodValue(resolvedPeriodId, database);
  const record = await companyRecord();
  const current = await record.read({ kind: "docset", period });
  const logItem = await record.read({ kind: "log_item", id: String(upload.log_item_id) });
  const revision = await record.reviseDocset(period, current?.ref ?? null, {
    add: [
      {
        log_item_ref: logItem.ref,
        filename: upload.filename,
        media_type: upload.media_type,
        role: "evidence",
      },
    ],
    actor: actorFor(session),
  });
  const added = revision.added_documents?.[0] ?? revision.documents?.[0] ?? null;
  const documentIdValue =
    added?.payload?.document_id ??
    added?.document_id ??
    revision.docset.payload.documents.at(-1)?.document_id;
  if (typeof documentIdValue !== "string")
    throw httpError(500, "Company Record returnerade inget dokument-ID.");
  const documentId = documentIdValue;
  const now = Date.now();
  database
    .prepare(
      "UPDATE uploads SET status='assigned',period_id=?,document_id=?,target_period_id=?,updated_at=? WHERE id=?",
    )
    .run(period.id, documentId, period.id, now, uploadId);
  database
    .prepare(
      "INSERT INTO docset_entries (company_id,period_id,document_id,upload_id,status,parent_document_id,replaces_document_id,created_at) VALUES (?,?,?,?, 'active',?,?,?)",
    )
    .run(
      COMPANY_ID,
      period.id,
      documentId,
      uploadId,
      typeof upload.parent_document_id === "string" ? upload.parent_document_id : null,
      typeof upload.replaces_document_id === "string" ? upload.replaces_document_id : null,
      now,
    );
  supersedeReview(period.id, session.userId, "docset_changed", database);
  appendEvent(
    "document_assigned",
    session.userId,
    { uploadId, documentId, periodId: period.id, filename: upload.filename },
    database,
  );
  return { status: "assigned" as const, periodId: period.id, documentId };
}

export async function uploadedContent(id: string, database = getDatabase()) {
  const row = database
    .prepare("SELECT log_item_id,filename,media_type FROM uploads WHERE id=? AND company_id=?")
    .get(id, COMPANY_ID) as
    | { log_item_id: string; filename: string; media_type: string }
    | undefined;
  if (!row) throw httpError(404, "Dokumentet finns inte.");
  const item = await (await companyRecord()).read({ kind: "log_item", id: row.log_item_id });
  return {
    filename: row.filename,
    mediaType: row.media_type,
    bytes: Buffer.from(item.payload.content_base64, "base64"),
  };
}

export function enqueueRun(
  session: AuthenticatedSession,
  periodId: string,
  database = getDatabase(),
) {
  const period = periodValue(periodId, database);
  if (
    database
      .prepare(
        "SELECT 1 ok FROM bookkeeping_runs WHERE company_id=? AND period_id=? AND decision='approved'",
      )
      .get(COMPANY_ID, periodId)
  )
    throw httpError(409, "Perioden är redan godkänd.");
  if (
    database
      .prepare(
        "SELECT 1 ok FROM bookkeeping_runs WHERE company_id=? AND period_id=? AND decision IS NULL AND superseded_at IS NULL AND outcome_kind='proposal'",
      )
      .get(COMPANY_ID, periodId)
  )
    throw httpError(409, "Perioden har redan ett aktuellt förslag.");
  const previous = database
    .prepare(
      "SELECT id FROM company_periods WHERE company_id=? AND sequence=(SELECT sequence-1 FROM company_periods WHERE company_id=? AND id=?)",
    )
    .get(COMPANY_ID, COMPANY_ID, periodId) as { id: string } | undefined;
  if (
    previous &&
    !database
      .prepare(
        "SELECT 1 ok FROM bookkeeping_runs WHERE company_id=? AND period_id=? AND decision='approved'",
      )
      .get(COMPANY_ID, previous.id)
  )
    throw httpError(409, "Föregående period måste godkännas först.");
  const count = (
    database
      .prepare(
        "SELECT COUNT(*) count FROM docset_entries WHERE company_id=? AND period_id=? AND status='active'",
      )
      .get(COMPANY_ID, periodId) as { count: number }
  ).count;
  if (!count) throw httpError(409, "Perioden saknar uppladdade dokument.");
  const id = randomUUID();
  const now = Date.now();
  try {
    database
      .prepare(
        "INSERT INTO bookkeeping_jobs (id,company_id,period_id,status,created_by,created_at,phase,phase_changed_at) VALUES (?,?,?,'queued',?,?, 'queued', ?)",
      )
      .run(id, COMPANY_ID, periodId, session.userId, now, now);
  } catch (error) {
    throw httpError(409, "En bokföringskörning pågår redan.", error);
  }
  appendEvent("bookkeeping_queued", session.userId, { jobId: id, periodId: period.id }, database);
  return { id, status: "queued", periodId };
}

export function jobStatus(id: string, database = getDatabase()) {
  const row = database
    .prepare("SELECT * FROM bookkeeping_jobs WHERE id=? AND company_id=?")
    .get(id, COMPANY_ID);
  if (!row) throw httpError(404, "Jobbet finns inte.");
  validateBookkeepingJob(row);
  return row;
}

export async function decideRun(
  session: AuthenticatedSession,
  runId: string,
  expectedSha256: string,
  decision: "approved" | "rejected",
  database = getDatabase(),
  note = "",
) {
  const row = database
    .prepare("SELECT * FROM bookkeeping_runs WHERE id=? AND company_id=?")
    .get(runId, COMPANY_ID) as Record<string, unknown> | undefined;
  if (!row) throw httpError(404, "Förslaget finns inte.");
  if (row.decision) throw httpError(409, "Förslaget är redan beslutat.");
  if (row.superseded_at) throw httpError(409, "Förslaget är inaktuellt och måste köras om.");
  if (row.run_sha256 !== expectedSha256)
    throw httpError(409, "Förslagets kontrollsumma stämmer inte.");
  const runRef = JSON.parse(String(row.run_ref_json));
  const record = await companyRecord();
  const result = await record.approve(runRef, {
    decision,
    actor: { ...actorFor(session), role: "approver" },
    authority: { kind: "role", role: "approver" },
    expectedRunSha256: expectedSha256,
    note,
  });
  const now = Date.now();
  database
    .prepare("UPDATE bookkeeping_runs SET decision=?,decided_at=? WHERE id=?")
    .run(decision, now, runId);
  appendEvent(
    "bookkeeping_decided",
    session.userId,
    { runId, periodId: String(row.period_id), decision, sha256: expectedSha256, note },
    database,
  );
  if (decision === "approved") await persistArtifacts(runId, result.output_snapshot, database);
  return { runId, decision, state: result.state?.ref ?? null };
}

export async function requestProposalChanges(
  session: AuthenticatedSession,
  periodId: string,
  note: string,
  database = getDatabase(),
) {
  if (!note.trim() || note.length > 10_000) throw httpError(400, "Beskriv vad som ska ändras.");
  const row = database
    .prepare(
      "SELECT id,run_sha256 FROM bookkeeping_runs WHERE company_id=? AND period_id=? AND decision IS NULL AND superseded_at IS NULL AND outcome_kind='proposal' ORDER BY created_at DESC LIMIT 1",
    )
    .get(COMPANY_ID, periodId) as { id: string; run_sha256: string } | undefined;
  if (!row) throw httpError(409, "Perioden har inget aktuellt förslag att ändra.");
  return decideRun(session, row.id, row.run_sha256, "rejected", database, note.trim());
}

async function persistArtifacts(runId: string, snapshot: unknown, database: BergbokDatabase) {
  for (const profile of ["report-source-json-v1", "report-html-v1", "report-pdf-v1", "sie4-v1"]) {
    const bundle = await Artifacts.render(snapshot, profile);
    for (const file of bundle.payload.artifacts) {
      const directory = path.join(appConfig().artifactRoot, runId, profile);
      await mkdir(directory, { recursive: true });
      const target = path.join(directory, safeFilename(file.filename));
      await writeFile(target, Buffer.from(file.content_base64, "base64"));
      const id = randomUUID();
      database
        .prepare(
          "INSERT OR REPLACE INTO artifacts (id,company_id,run_id,profile,filename,media_type,sha256,byte_length,relative_path,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          COMPANY_ID,
          runId,
          profile,
          file.filename,
          file.media_type,
          file.sha256,
          file.byte_length,
          path.relative(appConfig().artifactRoot, target),
          Date.now(),
        );
    }
  }
}

export async function reviewContent(
  runId: string,
  format: "html" | "pdf" | "json",
  database = getDatabase(),
) {
  const row = database
    .prepare("SELECT run_ref_json FROM bookkeeping_runs WHERE id=? AND company_id=?")
    .get(runId, COMPANY_ID) as { run_ref_json: string } | undefined;
  if (!row) throw httpError(404, "Körningen finns inte.");
  const snapshot = await (
    await companyRecord()
  ).read({
    kind: "output_snapshot",
    runRef: JSON.parse(row.run_ref_json),
  });
  const profile = {
    html: "report-html-v1",
    pdf: "report-pdf-v1",
    json: "report-source-json-v1",
  }[format];
  if (!profile) throw httpError(400, "Ogiltigt rapportformat.");
  const bundle = await Artifacts.render(snapshot, profile);
  const file = bundle.payload.artifacts[0];
  return {
    filename: file.filename,
    mediaType: file.media_type,
    bytes: Buffer.from(file.content_base64, "base64"),
  };
}

export async function artifactContent(id: string, database = getDatabase()) {
  const row = database
    .prepare("SELECT filename,media_type,relative_path FROM artifacts WHERE id=? AND company_id=?")
    .get(id, COMPANY_ID) as
    | { filename: string; media_type: string; relative_path: string }
    | undefined;
  if (!row) throw httpError(404, "Artefakten finns inte.");
  const target = path.resolve(appConfig().artifactRoot, row.relative_path);
  if (!target.startsWith(`${path.resolve(appConfig().artifactRoot)}${path.sep}`))
    throw httpError(500, "Ogiltig artefaktsökväg.");
  return { filename: row.filename, mediaType: row.media_type, bytes: await readFile(target) };
}

export const httpError = (status: number, message: string, cause?: unknown) =>
  Object.assign(new Error(message, { cause }), { status });

export function safeFilename(value: string) {
  const base = [...path.basename(value.normalize("NFC"))]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  if (!base || base === "." || base === ".." || base.length > 180)
    throw httpError(400, "Filnamnet är ogiltigt.");
  return base;
}

export function validateUploadContent(mediaType: string, bytes: Buffer) {
  const startsWith = (signature: number[]) =>
    signature.every((value, index) => bytes[index] === value);
  if (mediaType === "application/pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-")
    throw httpError(415, "Filen är inte en giltig PDF.");
  if (mediaType === "image/png" && !startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    throw httpError(415, "Filen är inte en giltig PNG-bild.");
  if (mediaType === "image/jpeg" && !startsWith([0xff, 0xd8, 0xff]))
    throw httpError(415, "Filen är inte en giltig JPEG-bild.");
  if (mediaType === "text/plain" || mediaType === "text/markdown") {
    if (bytes.includes(0)) throw httpError(415, "Textfilen innehåller binärdata.");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw httpError(415, "Textfilen måste vara giltig UTF-8.");
    }
  }
}
