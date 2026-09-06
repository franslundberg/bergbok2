export type PeriodStatus = "locked" | "working" | "running" | "preliminary" | "approved";
export type DocumentOrigin = "upload" | "text" | "note";

export type WorkContext =
  | {
      companyId: string;
      area: "bookkeeping";
      periodId: string;
      activity: "documents";
      object?: { kind: "document"; id: string };
    }
  | {
      companyId: string;
      area: "bookkeeping";
      periodId: string;
      activity: "review";
      object: { kind: "run"; id: string };
    }
  | {
      companyId: string;
      area: "bookkeeping";
      periodId: string;
      activity: "artifacts";
    };

export type RunSummary = {
  id: string;
  sha256: string;
  kind: "proposal" | "needs_input" | "out_of_scope";
  approvable: boolean;
};

export type BookkeepingJobPhase = "queued" | "preparing" | "analyzing" | "recording";

export type PeriodSummary = {
  id: string;
  sequence: number;
  kind: string;
  start: string | null;
  end: string;
  status: PeriodStatus;
  uploadCount: number;
  jobId: string | null;
  review: RunSummary | null;
};

export type UploadRecord = {
  id: string;
  filename: string;
  media_type?: string;
  mediaType?: string;
  sha256: string;
  byte_length?: number;
  byteLength?: number;
  status: "unassigned" | "assigned" | "ignored";
  period_id?: string | null;
  duplicate_of?: string | null;
  duplicateOf?: string | null;
  origin?: DocumentOrigin;
  target_period_id?: string | null;
};

export type DocsetEntry = {
  documentId: string;
  uploadId: string;
  periodId: string;
  status: "active" | "removed" | "replaced";
  parentDocumentId: string | null;
  replacesDocumentId: string | null;
};

export type PeriodDocumentSummary = {
  id: string;
  sourceId: string;
  filename: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
  role: string;
  origin: DocumentOrigin;
  parentDocumentId: string | null;
  replacesDocumentId: string | null;
  contentUrl: string;
};

export type DocumentDetail = PeriodDocumentSummary & {
  periodId: string;
  text: string | null;
  notes: PeriodDocumentSummary[];
};

export type PeriodDetail = {
  period: PeriodSummary;
  editable: boolean;
  documents: PeriodDocumentSummary[];
  pendingUploads: UploadRecord[];
  artifacts: Array<Record<string, unknown> & { id: string; filename: string }>;
  latestJob: null | {
    id: string;
    status: BookkeepingJob["status"];
    phase: BookkeepingJobPhase;
    createdAt: number;
    startedAt: number | null;
    heartbeatAt: number | null;
    phaseChangedAt: number | null;
    finishedAt: number | null;
    errorMessage: string | null;
  };
};

export type ConversationEvent = {
  id: number;
  type: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
};

export type BookkeepingJob = {
  id: string;
  company_id: string;
  period_id: string;
  status: "queued" | "running" | "proposal" | "needs_input" | "out_of_scope" | "failed";
  phase: BookkeepingJobPhase;
  created_at: number;
  started_at: number | null;
  heartbeat_at: number | null;
  phase_changed_at: number | null;
  finished_at: number | null;
};

export type CompanySummary = {
  company: { id: string; name: string; language: string };
  state: { sequence: number; sha256: string };
  periods: PeriodSummary[];
  activePeriodId: string | null;
  uploads: UploadRecord[];
  artifacts: Array<Record<string, unknown> & { id: string; filename: string }>;
};

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} måste vara ett objekt.`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} måste vara text.`);
  return value;
};

export function validateConversationEvent(value: unknown): asserts value is ConversationEvent {
  const event = object(value, "ConversationEvent");
  if (!Number.isSafeInteger(event.id)) throw new TypeError("ConversationEvent.id är ogiltigt.");
  text(event.type, "ConversationEvent.type");
  object(event.payload, "ConversationEvent.payload");
  if (!Number.isSafeInteger(event.createdAt))
    throw new TypeError("ConversationEvent.createdAt är ogiltigt.");
}

export function validateUploadRecord(value: unknown): asserts value is UploadRecord {
  const upload = object(value, "UploadRecord");
  text(upload.id, "UploadRecord.id");
  text(upload.filename, "UploadRecord.filename");
  text(upload.sha256, "UploadRecord.sha256");
  if (!["unassigned", "assigned", "ignored"].includes(String(upload.status)))
    throw new TypeError("UploadRecord.status är ogiltig.");
}

export function validateWorkContext(value: unknown): asserts value is WorkContext {
  const context = object(value, "WorkContext");
  text(context.companyId, "WorkContext.companyId");
  if (context.area !== "bookkeeping") throw new TypeError("WorkContext.area är ogiltigt.");
  text(context.periodId, "WorkContext.periodId");
  if (!["documents", "review", "artifacts"].includes(String(context.activity)))
    throw new TypeError("WorkContext.activity är ogiltig.");
  if (context.activity === "documents") {
    if (context.object !== undefined) {
      const selected = object(context.object, "WorkContext.object");
      if (selected.kind !== "document") throw new TypeError("WorkContext.object är ogiltigt.");
      text(selected.id, "WorkContext.object.id");
    }
    return;
  }
  if (context.activity === "review") {
    const selected = object(context.object, "WorkContext.object");
    if (selected.kind !== "run") throw new TypeError("WorkContext.object är ogiltigt.");
    text(selected.id, "WorkContext.object.id");
    return;
  }
  if (context.object !== undefined) throw new TypeError("WorkContext.object är ogiltigt.");
}

export function parseWorkContext(value: unknown): WorkContext | null {
  if (value === undefined || value === null) return null;
  validateWorkContext(value);
  return value;
}

export function validatePeriodDocumentSummary(
  value: unknown,
): asserts value is PeriodDocumentSummary {
  const document = object(value, "PeriodDocumentSummary");
  text(document.id, "PeriodDocumentSummary.id");
  text(document.sourceId, "PeriodDocumentSummary.sourceId");
  text(document.filename, "PeriodDocumentSummary.filename");
  text(document.mediaType, "PeriodDocumentSummary.mediaType");
  text(document.sha256, "PeriodDocumentSummary.sha256");
  if (!Number.isSafeInteger(document.byteLength))
    throw new TypeError("PeriodDocumentSummary.byteLength är ogiltigt.");
  if (!["upload", "text", "note"].includes(String(document.origin)))
    throw new TypeError("PeriodDocumentSummary.origin är ogiltigt.");
}

export function validatePeriodDetail(value: unknown): asserts value is PeriodDetail {
  const detail = object(value, "PeriodDetail");
  validatePeriodSummary(detail.period);
  if (typeof detail.editable !== "boolean")
    throw new TypeError("PeriodDetail.editable är ogiltigt.");
  if (!Array.isArray(detail.documents) || !Array.isArray(detail.pendingUploads))
    throw new TypeError("PeriodDetail saknar listor.");
  detail.documents.forEach(validatePeriodDocumentSummary);
  detail.pendingUploads.forEach(validateUploadRecord);
  if (detail.latestJob !== null) {
    const job = object(detail.latestJob, "PeriodDetail.latestJob");
    text(job.id, "PeriodDetail.latestJob.id");
    if (
      !["queued", "running", "proposal", "needs_input", "out_of_scope", "failed"].includes(
        String(job.status),
      )
    )
      throw new TypeError("PeriodDetail.latestJob.status är ogiltig.");
    if (!["queued", "preparing", "analyzing", "recording"].includes(String(job.phase)))
      throw new TypeError("PeriodDetail.latestJob.phase är ogiltig.");
    for (const key of [
      "createdAt",
      "startedAt",
      "heartbeatAt",
      "phaseChangedAt",
      "finishedAt",
    ] as const) {
      if (job[key] !== null && !Number.isSafeInteger(job[key]))
        throw new TypeError(`PeriodDetail.latestJob.${key} är ogiltigt.`);
    }
  }
}

export function validatePeriodSummary(value: unknown): asserts value is PeriodSummary {
  const period = object(value, "PeriodSummary");
  text(period.id, "PeriodSummary.id");
  text(period.end, "PeriodSummary.end");
  if (!["locked", "working", "running", "preliminary", "approved"].includes(String(period.status)))
    throw new TypeError("PeriodSummary.status är ogiltig.");
  if (!Number.isSafeInteger(period.sequence) || !Number.isSafeInteger(period.uploadCount))
    throw new TypeError("PeriodSummary innehåller ogiltiga heltal.");
  if (period.review !== null) validateRunSummary(period.review);
}

export function validateBookkeepingJob(value: unknown): asserts value is BookkeepingJob {
  const job = object(value, "BookkeepingJob");
  text(job.id, "BookkeepingJob.id");
  text(job.company_id, "BookkeepingJob.company_id");
  text(job.period_id, "BookkeepingJob.period_id");
  if (
    !["queued", "running", "proposal", "needs_input", "out_of_scope", "failed"].includes(
      String(job.status),
    )
  )
    throw new TypeError("BookkeepingJob.status är ogiltig.");
  if (!["queued", "preparing", "analyzing", "recording"].includes(String(job.phase)))
    throw new TypeError("BookkeepingJob.phase är ogiltig.");
}

export function validateRunSummary(value: unknown): asserts value is RunSummary {
  const run = object(value, "RunSummary");
  text(run.id, "RunSummary.id");
  text(run.sha256, "RunSummary.sha256");
  if (!["proposal", "needs_input", "out_of_scope"].includes(String(run.kind)))
    throw new TypeError("RunSummary.kind är ogiltig.");
  if (typeof run.approvable !== "boolean") throw new TypeError("RunSummary.approvable är ogiltig.");
}

export function validateCompanySummary(value: unknown): asserts value is CompanySummary {
  const summary = object(value, "CompanySummary");
  const company = object(summary.company, "CompanySummary.company");
  text(company.id, "CompanySummary.company.id");
  text(company.name, "CompanySummary.company.name");
  if (!Array.isArray(summary.periods) || !Array.isArray(summary.uploads))
    throw new TypeError("CompanySummary saknar listor.");
  summary.periods.forEach(validatePeriodSummary);
  summary.uploads.forEach(validateUploadRecord);
}

export function parseUploadAction(value: unknown) {
  const body = object(value, "UploadAction");
  if (body.action !== "assign" && body.action !== "ignore")
    throw Object.assign(new Error("Ogiltig uppladdningsåtgärd."), { status: 400 });
  if (body.periodId !== undefined && typeof body.periodId !== "string")
    throw Object.assign(new Error("Perioden är ogiltig."), { status: 400 });
  return {
    action: body.action as "assign" | "ignore",
    periodId: body.periodId as string | undefined,
  };
}

export function parseTextDocument(value: unknown) {
  const body = object(value, "TextDocument");
  const filename = text(body.filename, "TextDocument.filename");
  const markdown = text(body.markdown, "TextDocument.markdown");
  if (filename.length > 180 || markdown.length > 100_000)
    throw Object.assign(new Error("Textunderlaget är för stort."), { status: 400 });
  return { filename, markdown };
}

export function parseDocumentNote(value: unknown) {
  const body = object(value, "DocumentNote");
  const markdown = text(body.markdown, "DocumentNote.markdown");
  if (markdown.length > 100_000)
    throw Object.assign(new Error("Anteckningen är för stor."), { status: 400 });
  return { markdown };
}

export function parseRunDecision(value: unknown): {
  decision: "approved" | "rejected";
  expectedRunSha256: string;
} {
  const body = object(value, "RunDecision");
  if (body.decision !== "approved" && body.decision !== "rejected")
    throw Object.assign(new Error("Ogiltigt beslut."), { status: 400 });
  if (typeof body.expectedRunSha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedRunSha256))
    throw Object.assign(new Error("Förslagets kontrollsumma är ogiltig."), { status: 400 });
  return {
    decision: body.decision,
    expectedRunSha256: body.expectedRunSha256,
  };
}

export function parseConfirmedInformation(value: unknown) {
  const body = object(value, "ConfirmedInformation");
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 10_000)
    throw Object.assign(new Error("Svaret måste innehålla 1–10000 tecken."), { status: 400 });
  return body.text.trim();
}
