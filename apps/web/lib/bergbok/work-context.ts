import type { CompanySummary, PeriodDetail, WorkContext } from "./types.ts";
import { validateWorkContext } from "./types.ts";

export const documentsContext = (companyId: string, periodId: string): WorkContext => ({
  companyId,
  area: "bookkeeping",
  periodId,
  activity: "documents",
});

export const documentContext = (
  companyId: string,
  periodId: string,
  documentId: string,
): WorkContext => ({
  companyId,
  area: "bookkeeping",
  periodId,
  activity: "documents",
  object: { kind: "document", id: documentId },
});

export const reviewContext = (companyId: string, periodId: string, runId: string): WorkContext => ({
  companyId,
  area: "bookkeeping",
  periodId,
  activity: "review",
  object: { kind: "run", id: runId },
});

export const artifactsContext = (companyId: string, periodId: string): WorkContext => ({
  companyId,
  area: "bookkeeping",
  periodId,
  activity: "artifacts",
});

export const switchWorkContextPeriod = (_context: WorkContext, periodId: string): WorkContext =>
  documentsContext(_context.companyId, periodId);

export function validateWorkContextDomain(
  context: WorkContext,
  summary: CompanySummary,
  detail?: PeriodDetail,
) {
  validateWorkContext(context);
  if (context.companyId !== summary.company.id)
    throw new TypeError("WorkContext.companyId hör inte till den inloggade arbetsytan.");
  const period = summary.periods.find(({ id }) => id === context.periodId);
  if (!period) throw new TypeError("WorkContext.periodId finns inte.");
  if (context.activity === "documents" && context.object) {
    if (!detail) throw new TypeError("WorkContext-dokumentet kunde inte kontrolleras.");
    if (!detail.documents.some(({ id }) => id === context.object?.id))
      throw new TypeError("WorkContext-dokumentet finns inte i perioden.");
  }
  if (context.activity === "review" && period.review?.id !== context.object.id)
    throw new TypeError("WorkContext-granskningen är inte aktuell för perioden.");
  return context;
}

export function isWorkContextValidForSummary(context: unknown, summary: CompanySummary) {
  try {
    validateWorkContext(context);
    const period = summary.periods.find(({ id }) => id === context.periodId);
    if (!period || context.companyId !== summary.company.id) return false;
    if (context.activity === "documents" && context.object) {
      return Boolean(summary.periods.some(({ id }) => id === context.periodId));
    }
    if (context.activity === "review") return period.review?.id === context.object.id;
    return true;
  } catch {
    return false;
  }
}

export function defaultWorkContext(summary: CompanySummary): WorkContext | undefined {
  const periodId = summary.activePeriodId ?? summary.periods.at(-1)?.id;
  return periodId ? documentsContext(summary.company.id, periodId) : undefined;
}

export function restoreWorkContext(
  candidate: unknown,
  summary: CompanySummary,
  documentIds?: ReadonlyArray<string>,
): WorkContext | undefined {
  if (!isWorkContextValidForSummary(candidate, summary)) return defaultWorkContext(summary);
  const context = candidate as WorkContext;
  if (
    context.activity === "documents" &&
    context.object &&
    documentIds &&
    !documentIds.includes(context.object.id)
  )
    return defaultWorkContext(summary);
  return context;
}
