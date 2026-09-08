import { cloneJson } from "../../../../contracts/src/canonical.mjs";
import { formatMoney, parseMoney } from "../../../../contracts/src/money.mjs";

const REVIEW_SCHEMA_VERSION = "1.0";
const TRANSACTION_SUMMARY_MAX_LENGTH = 240;
const SUMMARY_MAX_LENGTH = 2000;

export function proposalReview({ caseBundle, output, assessment = null }) {
  const language = caseBundle.payload.language ?? "sv";
  const supplied = assessment?.review;
  const summary = supplied?.summary ?? (language === "sv"
    ? `${output.ledger.transactions.length} balanserade transaktioner föreslås för ${caseBundle.payload.period.id}.`
    : `${output.ledger.transactions.length} balanced transactions are proposed for ${caseBundle.payload.period.id}.`);
  // Merged, not all-or-nothing: a candidate only ever narrates the
  // transactions it authored itself (e.g. never a kernel-constructed VAT
  // closing row), so any transaction it left uncovered falls back to the
  // same deterministic summary used when there's no candidate narrative
  // at all.
  const suppliedSummaries = new Map((supplied?.transaction_summaries ?? []).map((item) => [item.source_id, item.summary]));
  const transactionSummaries = output.ledger.transactions.map((transaction) => ({
    source_id: transaction.source_id,
    summary: suppliedSummaries.get(transaction.source_id) ?? fallbackTransactionSummary(transaction, language),
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

function fallbackTransactionSummary(transaction, language) {
  const event = sentence(String(transaction.description).replace(/\s+/g, " ").trim());
  const debits = postingSide(transaction.lines, "debit", language);
  const credits = postingSide(transaction.lines, "credit", language);
  const treatment = debits && credits
    ? language === "sv"
      ? `Bokförs i debet på ${debits} mot kredit på ${credits}.`
      : `Booked as a debit to ${debits} against a credit to ${credits}.`
    : "";
  const full = [event, treatment].filter(Boolean).join(" ");
  if (full.length <= TRANSACTION_SUMMARY_MAX_LENGTH) return full;
  const compactTreatment = compactPostingTreatment(transaction.lines, language);
  return boundedSummary(event, compactTreatment);
}

function postingSide(lines, field, language) {
  return postingLines(lines, field)
    .map((line) => `${line.account_name} (${line.account}), ${displayMoney(line[field], language)}`)
    .join("; ");
}

function compactPostingTreatment(lines, language) {
  const debits = postingLines(lines, "debit");
  const credits = postingLines(lines, "credit");
  if (!debits.length || !credits.length) return "";
  const total = debits.reduce((sum, line) => sum + parseMoney(line.debit).minorUnits, 0n);
  const currency = parseMoney(debits[0].debit).currency;
  const amount = displayMoney(formatMoney(total, currency), language);
  const debitAccounts = compactAccounts(debits, language);
  const creditAccounts = compactAccounts(credits, language);
  return language === "sv"
    ? `Bokförs med ${amount} i debet på ${debitAccounts} mot kredit på ${creditAccounts}.`
    : `Booked with ${amount} debited to ${debitAccounts} against credits to ${creditAccounts}.`;
}

function postingLines(lines, field) {
  return (lines ?? []).filter((line) => parseMoney(line[field]).minorUnits !== 0n);
}

function compactAccounts(lines, language) {
  const accounts = [...new Set(lines.map((line) => line.account))];
  const shown = accounts.slice(0, 3).join(", ");
  if (accounts.length <= 3) return shown;
  return `${shown} + ${accounts.length - 3} ${language === "sv" ? "konton" : "accounts"}`;
}

function boundedSummary(event, treatment) {
  if (!treatment) return truncate(event, TRANSACTION_SUMMARY_MAX_LENGTH);
  const eventLimit = Math.max(1, TRANSACTION_SUMMARY_MAX_LENGTH - treatment.length - 1);
  return `${truncate(event, eventLimit)} ${treatment}`;
}

function truncate(value, limit) {
  if (value.length <= limit) return value;
  if (limit === 1) return "…";
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function displayMoney(value, language) {
  const parsed = parseMoney(value);
  const [number] = value.split(" ");
  if (language === "sv") return `${number.replace(".", ",")} ${parsed.currency === "SEK" ? "kr" : parsed.currency}`;
  return `${parsed.currency} ${number}`;
}

function sentence(value) {
  if (!value || /[.!?]$/.test(value)) return value;
  return `${value}.`;
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
