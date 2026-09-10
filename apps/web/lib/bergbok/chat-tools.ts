import { jsonSchema, tool, type ToolSet } from "ai";
import type { AuthenticatedSession } from "./auth-types.ts";
import {
  addDocumentNote,
  assignUpload,
  companySummary,
  createTextDocument,
  documentDetail,
  enqueueRun,
  getResultReport,
  periodDetail,
  removePeriodDocument,
  replaceTextDocument,
  requestProposalChanges,
  COMPANY_ID,
} from "./application.ts";
import type { WorkContext } from "./types.ts";
import {
  artifactsContext,
  documentContext,
  documentsContext,
  reviewContext,
} from "./work-context.ts";

type Input = Record<string, unknown>;
type ToolResult = {
  ok: true;
  message: string;
  workContext?: WorkContext;
  data?: unknown;
};

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) =>
  jsonSchema<Input>({
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  });

const stringProperty = (description: string, maxLength = 180) => ({
  type: "string",
  minLength: 1,
  maxLength,
  description,
});

const result = (message: string, workContext?: WorkContext, data?: unknown): ToolResult => ({
  ok: true,
  message,
  ...(workContext ? { workContext } : {}),
  ...(data === undefined ? {} : { data }),
});

export const NAVIGATION_TOOL_NAMES = [
  "show_period",
  "list_documents",
  "show_document",
  "show_proposal",
  "show_artifacts",
  "prepare_upload",
] as const;

export const MUTATION_TOOL_NAMES = [
  "create_text_document",
  "add_document_note",
  "replace_text_document",
  "remove_document",
  "keep_duplicate",
  "ignore_upload",
  "start_bookkeeping",
  "request_changes",
] as const;

export const READ_TOOL_NAMES = ["get_result_report"] as const;

export const activeToolsForStep = (stepNumber: number) =>
  stepNumber === 0
    ? (["shell", ...NAVIGATION_TOOL_NAMES, ...READ_TOOL_NAMES, ...MUTATION_TOOL_NAMES] as const)
    : (["shell", ...NAVIGATION_TOOL_NAMES, ...READ_TOOL_NAMES] as const);

export const isDirectBookkeepingCommand = (text: string) =>
  /^(?:(?:kan|skulle) du\s+bokföra|(?:vänligen\s+)?bokför)(?:\s+bokföringen\s+för|\s+perioden)?\s+(?:(?:upp)?start|\d{4}-(?:0[1-9]|1[0-2]))[.!?]*$/iu.test(
    text.trim(),
  );

export const isDirectResultReportCommand = (text: string) =>
  /^(?:(?:kan|skulle) du\s+)?(?:visa|skapa|ta fram|gör)\b[^\n]{0,180}\bresultatrapport\b/iu.test(
    text.trim(),
  );

export const approvedBookkeepingThrough = (
  periods: ReadonlyArray<{
    id: string;
    sequence: number;
    status: string;
    end: string;
  }>,
) => {
  const latest = periods
    .filter((period) => period.status === "approved")
    .reduce<{ id: string; end: string; sequence: number } | null>(
      (current, period) =>
        !current || period.sequence > current.sequence
          ? { id: period.id, end: period.end, sequence: period.sequence }
          : current,
      null,
    );
  return latest ? { period_id: latest.id, end: latest.end } : null;
};

export async function resolveToolPeriod(requested: unknown, workContext: WorkContext | null) {
  const summary = await companySummary();
  const id =
    (typeof requested === "string" && requested) ||
    workContext?.periodId ||
    summary.activePeriodId ||
    summary.periods.at(-1)?.id;
  if (!id || !summary.periods.some((period) => period.id === id))
    throw Object.assign(new Error("Perioden finns inte."), { status: 404 });
  return id;
}

export async function buildChatApplicationContext(workContext: WorkContext | null) {
  const summary = await companySummary();
  const selectedPeriodId =
    workContext?.periodId ?? summary.activePeriodId ?? summary.periods.at(-1)?.id ?? null;
  const detail = selectedPeriodId ? await periodDetail(selectedPeriodId) : null;
  const latestApproved = approvedBookkeepingThrough(summary.periods);
  return JSON.stringify({
    work_context: workContext,
    active_period_id: summary.activePeriodId,
    approved_bookkeeping_through: latestApproved,
    periods: summary.periods.map(({ id, status, end, uploadCount, review }) => ({
      id,
      status,
      end,
      document_count: uploadCount,
      review: review ? { id: review.id, sha256: review.sha256, kind: review.kind } : null,
    })),
    selected_period_documents:
      detail?.documents.map(({ id, filename, mediaType, origin, parentDocumentId }) => ({
        id,
        filename,
        media_type: mediaType,
        origin,
        parent_document_id: parentDocumentId,
      })) ?? [],
    pending_uploads:
      detail?.pendingUploads.map(({ id, filename, duplicate_of, duplicateOf }) => ({
        id,
        filename,
        duplicate_of: duplicate_of ?? duplicateOf ?? null,
      })) ?? [],
  });
}

export function createApplicationTools(
  session: AuthenticatedSession,
  workContext: WorkContext | null,
): ToolSet {
  const period = (value: unknown) => resolveToolPeriod(value, workContext);
  const context = (periodId: string) => documentsContext(COMPANY_ID, periodId);
  return {
    get_result_report: tool({
      description:
        "Skapa en deterministiskt beräknad svensk resultatrapport enbart från Company Records godkända bokföringssnapshotar. Använd alltid detta verktyg för finansiella resultatrapporter; beräkna dem aldrig med shell.",
      inputSchema: objectSchema({
        fromMonth: {
          type: "string",
          pattern: "^\\d{4}-(?:0[1-9]|1[0-2])$",
          description: "Första rapportmånaden som YYYY-MM. Utelämna för bokföringsstarten.",
        },
        toMonth: {
          type: "string",
          pattern: "^\\d{4}-(?:0[1-9]|1[0-2])$",
          description:
            "Sista rapportmånaden som YYYY-MM. Utelämna för vald eller senast godkänd månad.",
        },
        layout: {
          type: "string",
          enum: ["monthly", "period_accumulated"],
          description:
            "monthly ger en kolumn per månad; period_accumulated ger period och ackumulerat.",
        },
      }),
      execute: async (input) => {
        const report = await getResultReport({
          ...(typeof input.fromMonth === "string" ? { fromMonth: input.fromMonth } : {}),
          ...(typeof input.toMonth === "string" ? { toMonth: input.toMonth } : {}),
          ...(input.layout === "monthly" || input.layout === "period_accumulated"
            ? { layout: input.layout }
            : {}),
          selectedPeriodId: workContext?.periodId,
        });
        return {
          ok: true as const,
          message: "Resultatrapporten är beräknad från godkänd bokföring.",
          report,
        };
      },
    }),
    show_period: tool({
      description: "Visa en periods underlag i arbetsytan till höger.",
      inputSchema: objectSchema({ periodId: stringProperty("Period-ID, till exempel 2026-05") }),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        await periodDetail(periodId);
        return result(`Visar underlag för ${periodId}.`, context(periodId));
      },
    }),
    list_documents: tool({
      description: "Lista dokumenten i en period och visa listan till höger.",
      inputSchema: objectSchema({ periodId: stringProperty("Period-ID") }),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        const detail = await periodDetail(periodId);
        return result(
          `Visar ${detail.documents.length} dokument för ${periodId}.`,
          context(periodId),
          detail.documents.map(({ id, filename, mediaType, origin }) => ({
            id,
            filename,
            mediaType,
            origin,
          })),
        );
      },
    }),
    show_document: tool({
      description: "Öppna ett bestämt dokument i arbetsytan till höger.",
      inputSchema: objectSchema(
        {
          periodId: stringProperty("Period-ID"),
          documentId: stringProperty("Exakt dokument-ID"),
        },
        ["documentId"],
      ),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        const documentId = String(input.documentId);
        const document = await documentDetail(periodId, documentId);
        return result(
          `Visar ${document.filename}.`,
          documentContext(COMPANY_ID, periodId, documentId),
        );
      },
    }),
    show_proposal: tool({
      description: "Visa det aktuella bokföringsförslaget för en period.",
      inputSchema: objectSchema({ periodId: stringProperty("Period-ID") }),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        const detail = await periodDetail(periodId);
        if (!detail.period.review)
          throw Object.assign(new Error("Perioden har inget aktuellt granskningsresultat."), {
            status: 409,
          });
        return result(
          `Visar granskningen för ${periodId}.`,
          reviewContext(COMPANY_ID, periodId, detail.period.review.id),
        );
      },
    }),
    show_artifacts: tool({
      description: "Visa godkända rapporter och filer för en period.",
      inputSchema: objectSchema({ periodId: stringProperty("Period-ID") }),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        await periodDetail(periodId);
        return result(`Visar filer för ${periodId}.`, artifactsContext(COMPANY_ID, periodId));
      },
    }),
    prepare_upload: tool({
      description: "Öppna vald periods uppladdningsyta. Själva filvalet görs alltid av användaren.",
      inputSchema: objectSchema({ periodId: stringProperty("Period-ID") }),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        const detail = await periodDetail(periodId);
        if (!detail.editable)
          throw Object.assign(new Error("Perioden kan inte ta emot nya underlag."), {
            status: 409,
          });
        return result(`Uppladdningsytan för ${periodId} är öppen.`, context(periodId));
      },
    }),
    create_text_document: tool({
      description: "Skapa ett nytt Markdown-underlag när användaren tydligt har angett innehållet.",
      inputSchema: objectSchema(
        {
          periodId: stringProperty("Period-ID"),
          filename: stringProperty("Filnamn för Markdown-underlaget"),
          markdown: stringProperty("Exakt innehåll från användaren", 100_000),
        },
        ["filename", "markdown"],
      ),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        const created = await createTextDocument(
          session,
          periodId,
          String(input.filename),
          String(input.markdown),
        );
        return result(
          `Textunderlaget ${created.filename} har lagts till i ${periodId}.`,
          documentContext(COMPANY_ID, periodId, String(created.documentId)),
        );
      },
    }),
    add_document_note: tool({
      description: "Lägg till en separat anteckning till ett bestämt dokument.",
      inputSchema: objectSchema(
        {
          periodId: stringProperty("Period-ID"),
          documentId: stringProperty("Exakt dokument-ID"),
          markdown: stringProperty("Anteckningens innehåll", 100_000),
        },
        ["documentId", "markdown"],
      ),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        const created = await addDocumentNote(
          session,
          periodId,
          String(input.documentId),
          String(input.markdown),
        );
        return result(
          "Anteckningen har lagts till.",
          documentContext(COMPANY_ID, periodId, String(created.documentId)),
        );
      },
    }),
    replace_text_document: tool({
      description: "Ersätt ett tidigare skapat textunderlag med en ny immutable version.",
      inputSchema: objectSchema(
        {
          periodId: stringProperty("Period-ID"),
          documentId: stringProperty("Exakt dokument-ID"),
          markdown: stringProperty("Hela det nya Markdown-innehållet", 100_000),
        },
        ["documentId", "markdown"],
      ),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        const replaced = await replaceTextDocument(
          session,
          periodId,
          String(input.documentId),
          String(input.markdown),
        );
        return result(
          "Textunderlaget har fått en ny version.",
          documentContext(COMPANY_ID, periodId, replaced.documentId),
        );
      },
    }),
    remove_document: tool({
      description:
        "Ta direkt bort ett entydigt dokument ur aktuell periods underlag. Originalet bevaras.",
      inputSchema: objectSchema(
        {
          periodId: stringProperty("Period-ID"),
          documentId: stringProperty("Exakt dokument-ID"),
        },
        ["documentId"],
      ),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        await removePeriodDocument(session, periodId, String(input.documentId));
        return result(
          "Dokumentet har tagits bort från periodens aktuella underlag.",
          context(periodId),
        );
      },
    }),
    keep_duplicate: tool({
      description: "Behåll och tilldela en uppladdning som markerats som dubblett.",
      inputSchema: objectSchema(
        { uploadId: stringProperty("Uppladdnings-ID"), periodId: stringProperty("Period-ID") },
        ["uploadId"],
      ),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        const assigned = await assignUpload(
          session,
          String(input.uploadId),
          "assign",
          undefined,
          periodId,
        );
        return result(
          "Dubbletten har behållits och lagts till.",
          documentContext(COMPANY_ID, periodId, String(assigned.documentId)),
        );
      },
    }),
    ignore_upload: tool({
      description: "Ignorera en otilldelad uppladdning.",
      inputSchema: objectSchema({ uploadId: stringProperty("Uppladdnings-ID") }, ["uploadId"]),
      execute: async (input) => {
        await assignUpload(session, String(input.uploadId), "ignore");
        const periodId = await period(undefined);
        return result("Uppladdningen används inte.", context(periodId));
      },
    }),
    start_bookkeeping: tool({
      description: "Starta bokföringen direkt för en entydigt angiven eller vald period.",
      inputSchema: objectSchema({ periodId: stringProperty("Period-ID") }),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        enqueueRun(session, periodId);
        return result(`Bokföringen för ${periodId} har startats.`, context(periodId));
      },
    }),
    request_changes: tool({
      description: "Avvisa aktuellt förslag och registrera användarens tydliga ändringsbegäran.",
      inputSchema: objectSchema(
        {
          periodId: stringProperty("Period-ID"),
          note: stringProperty("Vad användaren uttryckligen vill ändra", 10_000),
        },
        ["note"],
      ),
      execute: async (input) => {
        const periodId = await period(input.periodId);
        await requestProposalChanges(session, periodId, String(input.note));
        return result(`Ändringen har begärts för ${periodId}.`, context(periodId));
      },
    }),
  };
}
