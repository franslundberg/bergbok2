import { cloneJson } from "../../../../contracts/src/canonical.mjs";

const REVIEW_SCHEMA_VERSION = "1.0";
const TRANSACTION_SUMMARY_MAX_LENGTH = 240;
const SUMMARY_MAX_LENGTH = 2000;

export function proposalReview({ caseBundle, output, assessment = null }) {
  const language = caseBundle.payload.language ?? "sv";
  const supplied = assessment?.review;
  const summary = supplied?.summary ?? (language === "sv"
    ? `${output.ledger.transactions.length} balanserade transaktioner föreslås för ${caseBundle.payload.period.id}.`
    : `${output.ledger.transactions.length} balanced transactions are proposed for ${caseBundle.payload.period.id}.`);
  const transactionSummaries = supplied?.transaction_summaries ?? output.ledger.transactions.map((transaction) => ({
    source_id: transaction.source_id,
    summary: fallbackTransactionSummary(transaction.description),
  }));
  const review = {
    schema_version: REVIEW_SCHEMA_VERSION,
    language,
    narrative_source: supplied ? "ai" : "deterministic",
    summary,
    transaction_summaries: cloneJson(transactionSummaries),
  };
  assertBookkeepingReview(review, output.ledger.transactions);
  return review;
}

export function classifiedReview({ caseBundle, kind, count, assessment = null }) {
  const language = caseBundle.payload.language ?? "sv";
  const supplied = assessment?.review;
  const fallback = kind === "needs_input"
    ? language === "sv"
      ? `${count} fråga${count === 1 ? "" : "or"} måste lösas innan ett förslag kan skapas.`
      : `${count} issue${count === 1 ? "" : "s"} must be resolved before a proposal can be made.`
    : language === "sv"
      ? "Ärendet ligger utanför den stödda bokföringsprofilen."
      : "The case is outside the supported Bookkeeping profile.";
  const review = {
    schema_version: REVIEW_SCHEMA_VERSION,
    language,
    narrative_source: supplied ? "ai" : "deterministic",
    summary: supplied?.summary ?? fallback,
    transaction_summaries: cloneJson(supplied?.transaction_summaries ?? []),
  };
  assertBookkeepingReview(review, []);
  return review;
}

export function assertBookkeepingReview(review, transactions) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw new TypeError("Bookkeeping review must be an object");
  }
  assertExactKeys(
    review,
    ["schema_version", "language", "narrative_source", "summary", "transaction_summaries"],
    "Bookkeeping review",
  );
  if (review.schema_version !== REVIEW_SCHEMA_VERSION) {
    throw new TypeError(`Bookkeeping review must use schema version ${REVIEW_SCHEMA_VERSION}`);
  }
  if (!["sv", "en"].includes(review.language)) throw new TypeError("Bookkeeping review language must be sv or en");
  if (!["ai", "deterministic"].includes(review.narrative_source)) {
    throw new TypeError("Bookkeeping review narrative_source must be ai or deterministic");
  }
  assertPlainText(review.summary, "Bookkeeping review summary", SUMMARY_MAX_LENGTH, { singleLine: false });
  if (!Array.isArray(review.transaction_summaries)) {
    throw new TypeError("Bookkeeping review transaction_summaries must be an array");
  }
  const expected = new Set(transactions.map((transaction) => transaction.source_id));
  const actual = new Set();
  for (const [index, item] of review.transaction_summaries.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`Bookkeeping review transaction_summaries[${index}] must be an object`);
    }
    assertExactKeys(item, ["source_id", "summary"], `Bookkeeping review transaction_summaries[${index}]`);
    if (typeof item.source_id !== "string" || !item.source_id) {
      throw new TypeError(`Bookkeeping review transaction_summaries[${index}].source_id is required`);
    }
    if (actual.has(item.source_id)) throw new TypeError(`Duplicate transaction summary for ${item.source_id}`);
    if (!expected.has(item.source_id)) throw new TypeError(`Unknown transaction summary source_id ${item.source_id}`);
    actual.add(item.source_id);
    assertPlainText(
      item.summary,
      `Bookkeeping review transaction summary ${item.source_id}`,
      TRANSACTION_SUMMARY_MAX_LENGTH,
      { singleLine: true },
    );
  }
  for (const sourceId of expected) {
    if (!actual.has(sourceId)) throw new TypeError(`Missing transaction summary for ${sourceId}`);
  }
  return true;
}

function fallbackTransactionSummary(value) {
  const singleLine = String(value).replace(/\s+/g, " ").trim();
  if (singleLine.length <= TRANSACTION_SUMMARY_MAX_LENGTH) return singleLine;
  return `${singleLine.slice(0, TRANSACTION_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new TypeError(`${label} must contain exactly ${allowed.join(", ")}`);
  }
}

function assertPlainText(value, label, maxLength, { singleLine }) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be non-empty plain text`);
  if (value.length > maxLength) throw new TypeError(`${label} exceeds ${maxLength} characters`);
  if (/\r/.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} contains control characters`);
  }
  if (/[<>]/.test(value)) throw new TypeError(`${label} must not contain markup`);
  if (singleLine && /\n/.test(value)) throw new TypeError(`${label} must be one line`);
}
