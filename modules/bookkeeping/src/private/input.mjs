import { issue, isPlainObject, validIsoDate } from "./ledger.mjs";
import {
  BOOKKEEPING_SCHEMA_VERSION,
  LEGACY_BOOKKEEPING_SCHEMA_VERSION,
} from "./money-boundary.mjs";

export const BOOKKEEPING_INPUT_SCHEMA_ID = "se.bergbok.bookkeeping-input";
export const BOOKKEEPING_INPUT_SCHEMA_VERSION = BOOKKEEPING_SCHEMA_VERSION;
export const SUPPORTED_PROFILE = "se-private-ab-invoice-calendar-demo-v1";

export function extractBookkeepingInput(caseBundle) {
  const documents = caseBundle.payload.docset?.payload?.documents;
  if (!Array.isArray(documents)) {
    return failure(issue("DOCSET_DOCUMENTS_REQUIRED", "The Docset must contain a documents array", "docset.payload.documents"));
  }
  const candidates = documents.filter((document) => documentValue(document)?.role === "bookkeeping-input");
  if (candidates.length === 0) {
    return failure(issue("BOOKKEEPING_INPUT_REQUIRED", "Add one JSON document with role bookkeeping-input", "docset.payload.documents"));
  }
  if (candidates.length > 1) {
    return failure(issue("BOOKKEEPING_INPUT_AMBIGUOUS", "The Docset contains more than one bookkeeping-input document", "docset.payload.documents"));
  }
  const document = candidates[0];
  const value = documentValue(document);
  const documentId = documentIdentifier(document);
  const decoded = decodeJsonBase64(value.content_base64);
  if (!decoded.ok) return failure(issue("BOOKKEEPING_INPUT_INVALID", decoded.message, `document:${documentId}`));
  if (!isPlainObject(decoded.value)) {
    return failure(issue("BOOKKEEPING_INPUT_INVALID", "The bookkeeping-input JSON must contain an object", `document:${documentId}`));
  }
  return { ok: true, input: decoded.value, document_id: documentId, documents: documents.map(documentIdentifier) };
}

export function scopeReasons(input, caseBundle) {
  const reasons = [];
  const policies = caseBundle.payload.effective_policies;
  const core = policies?.core;
  const bookkeeping = policies?.bookkeeping;
  if (input.schema_id !== BOOKKEEPING_INPUT_SCHEMA_ID
      || ![LEGACY_BOOKKEEPING_SCHEMA_VERSION, BOOKKEEPING_INPUT_SCHEMA_VERSION].includes(input.schema_version)) {
    reasons.push({
      code: "UNSUPPORTED_INPUT_SCHEMA",
      message: `Supported bookkeeping input is ${BOOKKEEPING_INPUT_SCHEMA_ID} schema 1.0 or ${BOOKKEEPING_INPUT_SCHEMA_VERSION}`,
    });
  }
  if (bookkeeping?.profile !== SUPPORTED_PROFILE) {
    reasons.push({ code: "UNSUPPORTED_PROFILE", message: `Supported profile is ${SUPPORTED_PROFILE}` });
  }
  if (!["start", "import", "ordinary"].includes(input.mode)) {
    reasons.push({ code: "UNSUPPORTED_MODE", message: "Supported modes are start, import, and ordinary" });
  } else if (input.mode !== caseBundle.payload.period.kind) {
    reasons.push({ code: "PERIOD_MODE_MISMATCH", message: "Bookkeeping input mode must equal the fixed Period kind" });
  }
  if (core?.country !== "SE") reasons.push({ code: "UNSUPPORTED_COUNTRY", message: "Only Sweden is supported" });
  if (core?.currency !== "SEK") reasons.push({ code: "UNSUPPORTED_CURRENCY", message: "Only SEK is supported" });
  if (core?.accounting_method !== "invoice") reasons.push({ code: "UNSUPPORTED_ACCOUNTING_METHOD", message: "Only the invoicing method is supported" });
  if (!calendarFiscalYear(core?.fiscal_year)) reasons.push({ code: "UNSUPPORTED_FISCAL_YEAR", message: "Only a calendar financial year is supported" });
  if (bookkeeping?.verification_series !== "A") reasons.push({ code: "UNSUPPORTED_VERIFICATION_SERIES", message: "The prototype supports verification series A" });
  if (bookkeeping?.chart_of_accounts !== "BAS") reasons.push({ code: "UNSUPPORTED_CHART_OF_ACCOUNTS", message: "The prototype supports the BAS chart of accounts" });
  const vatPolicy = bookkeeping?.vat_reporting;
  if (vatPolicy?.frequency !== "quarterly") {
    reasons.push({ code: "UNSUPPORTED_VAT_FREQUENCY", message: "The prototype supports quarterly VAT reporting" });
  } else if (!validVatAccountPolicy(vatPolicy)) {
    reasons.push({ code: "INVALID_VAT_ACCOUNT_POLICY", message: "VAT reporting requires configured input, output, and settlement accounts" });
  }
  if (input.profile !== undefined && input.profile !== bookkeeping?.profile) reasons.push({ code: "POLICY_MISMATCH", message: "Input profile differs from the fixed effective policy" });
  if (input.currency !== undefined && input.currency !== core?.currency) reasons.push({ code: "POLICY_MISMATCH", message: "Input currency differs from the fixed effective policy" });
  if (input.organization?.country !== undefined && input.organization.country !== core?.country) reasons.push({ code: "POLICY_MISMATCH", message: "Input country differs from the fixed effective policy" });
  if (input.organization?.accounting_method !== undefined && input.organization.accounting_method !== core?.accounting_method) reasons.push({ code: "POLICY_MISMATCH", message: "Input accounting method differs from the fixed effective policy" });
  if (input.company_id !== caseBundle.payload.company_id) {
    reasons.push({ code: "COMPANY_MISMATCH", message: "The bookkeeping input names a different company" });
  }
  if (input.period_id !== caseBundle.payload.period.id) {
    reasons.push({ code: "PERIOD_MISMATCH", message: "The bookkeeping input names a different period" });
  }
  return reasons;
}

function validVatAccountPolicy(value) {
  if (!isPlainObject(value)
      || !Array.isArray(value.input_accounts) || !value.input_accounts.length
      || !Array.isArray(value.output_accounts) || !value.output_accounts.length
      || !/^\d{4}$/.test(value.settlement_account ?? "")) return false;
  const inputs = value.input_accounts;
  const outputs = value.output_accounts;
  const all = [...inputs, ...outputs, value.settlement_account];
  return all.every((account) => typeof account === "string" && /^\d{4}$/.test(account))
    && new Set(all).size === all.length;
}

function calendarFiscalYear(value) {
  if (!value || !validIsoDate(value.start) || !validIsoDate(value.end)) return false;
  return value.start.slice(0, 4) === value.end.slice(0, 4)
    && value.start.endsWith("-01-01")
    && value.end.endsWith("-12-31");
}

export function periodBounds(caseBundle, input) {
  const period = caseBundle.payload.period;
  const start = period.start ?? null;
  const end = period.end;
  const issues = [];
  if (start !== null && !validIsoDate(start)) issues.push(issue("PERIOD_START_INVALID", "Period start must be an ISO calendar date", "period.start"));
  if (end !== null && !validIsoDate(end)) issues.push(issue("PERIOD_END_INVALID", "Period end must be an ISO calendar date", "period.end"));
  if (start && end && start > end) issues.push(issue("PERIOD_RANGE_INVALID", "Period start is after period end", "period"));
  if (input.mode === "ordinary" && (!start || !end)) {
    issues.push(issue("PERIOD_BOUNDS_REQUIRED", "An ordinary period needs start and end dates", "period"));
  }
  if (input.period_start !== undefined && input.period_start !== start) {
    issues.push(issue("PERIOD_BOUNDS_MISMATCH", "Input period_start differs from the fixed ConsolidationCase period", "bookkeeping_input.period_start"));
  }
  if (input.period_end !== undefined && input.period_end !== end) {
    issues.push(issue("PERIOD_BOUNDS_MISMATCH", "Input period_end differs from the fixed ConsolidationCase period", "bookkeeping_input.period_end"));
  }
  return { start, end, issues };
}

function documentValue(document) {
  return document?.payload && typeof document.payload === "object" ? document.payload : document;
}

function documentIdentifier(document) {
  const value = documentValue(document);
  return String(value?.document_id ?? value?.id ?? document?.ref?.stable_id ?? "unknown-document");
}

function decodeJsonBase64(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) return { ok: false, message: "content_base64 is required" };
  const compact = encoded.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return { ok: false, message: "content_base64 is not valid base64" };
  }
  try {
    const bytes = Buffer.from(compact, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
      return { ok: false, message: "content_base64 is not canonical base64" };
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, message: `Cannot decode bookkeeping-input JSON: ${error.message}` };
  }
}

function failure(value) {
  return { ok: false, issues: [value] };
}
