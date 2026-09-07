import { canonicalStringify, prettyCanonicalJson } from "../../../../../contracts/src/canonical.mjs";
import {
  assertContentRef,
  assertPeriod,
  formatMoney,
  parseMoney,
  proposalDigest,
  verifySealedContent,
} from "../../../../../contracts/src/index.mjs";

const SNAPSHOT_SCHEMA = "se.bergbok.output-snapshot";
const SNAPSHOT_VERSION = "2.0";
const BOOKKEEPING_SCHEMA = "3.0";

const LABELS = Object.freeze({
  sv: Object.freeze({
    title: "Bokföringsrapport",
    proposal: "Förslag",
    needs_input: "Behöver svar",
    out_of_scope: "Utanför stöd",
    preliminary: "Förhandsvisning – inte godkänd",
    approved: "Godkänd",
    company: "Företag",
    period: "Period",
    run: "Körning",
    recorded: "Registrerad",
    created: "Skapad",
    version: "version",
    through: "Till och med",
    summary: "Sammanfattning",
    notices: "Frågor, varningar och orsaker",
    questions: "Frågor",
    warnings: "Varningar",
    reasons: "Orsaker",
    core: "Företagsuppgifter",
    coreChanges: "Ändrade företagsuppgifter",
    transactions: "Bokföringstransaktioner",
    openItems: "Öppna poster",
    openItemChanges: "Förändringar",
    closingOpenItems: "Kvarstående poster",
    noOpenItemsAtPeriodEnd: "Inga öppna poster vid periodens slut.",
    balances: "Kontosaldon",
    verification: "Verifikationsserie",
    verificationSingular: "verifikation",
    verificationPlural: "verifikationer",
    reconciliations: "Avstämningar",
    vat: "Moms",
    evidence: "Underlag",
    provenance: "Debug",
    showDebug: "Visa",
    none: "Inga.",
    sourceId: "Käll-ID",
    account: "Konto",
    accountName: "Kontonamn",
    debit: "Debet",
    credit: "Kredit",
    total: "Belopp",
    date: "Datum",
    evidenceIds: "Underlag",
    opening: "Ingående",
    movementDebit: "Period debet",
    movementCredit: "Period kredit",
    closing: "Utgående",
    action: "Åtgärd",
    itemId: "Post-ID",
    kind: "Typ",
    party: "Part",
    remaining: "Kvar",
    dueDate: "Förfallodatum",
    status: "Status",
    external: "Externt saldo",
    ledger: "Bokfört saldo",
    reportingPeriod: "Redovisningsperiod",
    reportingFrequency: "Redovisningsintervall",
    dueInPeriod: "Ska redovisas i perioden",
    inputVatAccounts: "Konton för ingående moms",
    outputVatAccounts: "Konton för utgående moms",
    vatSettlementAccount: "Momsredovisningskonto",
    vatClosingTransaction: "Momsombokning",
    yes: "Ja",
    no: "Nej",
    quarterly: "Kvartalsvis",
    declarationBoxes: "Deklarationsrutor",
    noVatActivity: "Ingen ingående eller utgående moms bokfördes i perioden.",
    vatPeriodMembership: "Perioden ingår i momsperioden",
    noVatReturnDue: "ingen momsredovisning förfaller i",
    series: "Serie",
    lastNumberOpening: "Föregående nummer",
    lastNumberClosing: "Sista nummer",
    path: "Fält",
    value: "Värde",
    previewNotice: "Detta är ett förslag. Ingenting har godkänts, bokförts, betalats, deklarerats eller skickats in.",
  }),
  en: Object.freeze({
    title: "Bookkeeping report",
    proposal: "Proposal",
    needs_input: "Needs input",
    out_of_scope: "Out of scope",
    preliminary: "Preview – not approved",
    approved: "Approved",
    company: "Company",
    period: "Period",
    run: "Run",
    recorded: "Recorded",
    created: "Created",
    version: "version",
    through: "Through",
    summary: "Summary",
    notices: "Questions, warnings, and reasons",
    questions: "Questions",
    warnings: "Warnings",
    reasons: "Reasons",
    core: "Company facts",
    coreChanges: "Company information changes",
    transactions: "Bookkeeping transactions",
    openItems: "Open items",
    openItemChanges: "Changes",
    closingOpenItems: "Closing items",
    noOpenItemsAtPeriodEnd: "No open items at the end of the period.",
    balances: "Account balances",
    verification: "Verification series",
    verificationSingular: "entry",
    verificationPlural: "entries",
    reconciliations: "Reconciliations",
    vat: "VAT",
    evidence: "Evidence",
    provenance: "Debug",
    showDebug: "Show",
    none: "None.",
    sourceId: "Source ID",
    account: "Account",
    accountName: "Account name",
    debit: "Debit",
    credit: "Credit",
    total: "Amount",
    date: "Date",
    evidenceIds: "Evidence",
    opening: "Opening",
    movementDebit: "Period debit",
    movementCredit: "Period credit",
    closing: "Closing",
    action: "Action",
    itemId: "Item ID",
    kind: "Kind",
    party: "Party",
    remaining: "Remaining",
    dueDate: "Due date",
    status: "Status",
    external: "External balance",
    ledger: "Ledger balance",
    reportingPeriod: "Reporting period",
    reportingFrequency: "Reporting frequency",
    dueInPeriod: "Due in this period",
    inputVatAccounts: "Input VAT accounts",
    outputVatAccounts: "Output VAT accounts",
    vatSettlementAccount: "VAT settlement account",
    vatClosingTransaction: "VAT closing transaction",
    yes: "Yes",
    no: "No",
    quarterly: "Quarterly",
    declarationBoxes: "Declaration boxes",
    noVatActivity: "No input or output VAT was posted in the period.",
    vatPeriodMembership: "The period is part of the VAT period",
    noVatReturnDue: "no VAT return is due in",
    series: "Series",
    lastNumberOpening: "Previous number",
    lastNumberClosing: "Last number",
    path: "Field",
    value: "Value",
    previewNotice: "This is a proposal. Nothing has been approved, posted, paid, filed, or submitted.",
  }),
});

export function buildReviewModel(snapshot) {
  verifySealedContent(snapshot, "review OutputSnapshot");
  if (snapshot.ref.schema_id !== SNAPSHOT_SCHEMA || snapshot.ref.schema_version !== SNAPSHOT_VERSION) {
    throw new TypeError(`Review requires ${SNAPSHOT_SCHEMA} ${SNAPSHOT_VERSION}`);
  }
  const source = snapshot.payload;
  assertOnlyKeys(source, [
    "contract_version", "approval_status", "language", "run_ref",
    "approval_receipt_ref", "proposal_digest", "recorded_at", "context", "outcome",
  ], "OutputSnapshot payload");
  if (source.contract_version !== SNAPSHOT_VERSION) throw new TypeError("OutputSnapshot payload must use contract version 2.0");
  if (!["preliminary", "approved"].includes(source.approval_status)) throw new TypeError("OutputSnapshot approval_status is invalid");
  if (!["sv", "en"].includes(source.language)) throw new TypeError("OutputSnapshot language is invalid");
  if (!source.context || source.context.domain !== "bookkeeping") throw new TypeError("Review v1 supports Bookkeeping only");
  assertOnlyKeys(source.context, ["company_id", "domain", "period", "docset_ref", "previous_state_ref"], "OutputSnapshot context");
  if (typeof source.context.company_id !== "string" || !source.context.company_id) throw new TypeError("OutputSnapshot company_id is invalid");
  assertPeriod(source.context.period, "OutputSnapshot Period");
  assertContentRef(source.run_ref, "OutputSnapshot run_ref");
  assertContentRef(source.context.docset_ref, "OutputSnapshot docset_ref");
  assertContentRef(source.context.previous_state_ref, "OutputSnapshot previous_state_ref");
  if (source.run_ref.schema_id !== "se.bergbok.consolidation-run"
      || source.context.docset_ref.schema_id !== "se.bergbok.docset"
      || source.context.previous_state_ref.schema_id !== "se.bergbok.state-envelope") {
    throw new TypeError("OutputSnapshot context references are invalid");
  }
  if (source.approval_status === "preliminary" && source.approval_receipt_ref !== null) throw new TypeError("Preliminary OutputSnapshot cannot have an approval receipt");
  if (source.approval_status === "approved") {
    assertContentRef(source.approval_receipt_ref, "OutputSnapshot approval_receipt_ref");
    if (source.approval_receipt_ref.schema_id !== "se.bergbok.approval-receipt") throw new TypeError("Approved OutputSnapshot requires an approval receipt");
  }
  if (!Number.isFinite(new Date(source.recorded_at).valueOf())) throw new TypeError("OutputSnapshot recorded_at is invalid");
  const outcome = source.outcome;
  if (!outcome || outcome.domain !== "bookkeeping" || outcome.review?.language !== source.language) {
    throw new TypeError("OutputSnapshot outcome and frozen language are inconsistent");
  }
  assertContentRef(outcome.case_ref, "OutputSnapshot outcome.case_ref");
  const labels = LABELS[source.language];
  const review = outcome.review;
  assertReview(review);

  const proposal = outcome.kind === "proposal";
  if (proposal && source.proposal_digest !== proposalDigest(outcome)) throw new TypeError("OutputSnapshot proposal digest is inconsistent");
  if (!proposal && source.proposal_digest !== null) throw new TypeError("Only a proposal may have a proposal digest");
  const bookkeeping = proposal ? outcome.canonical_outputs?.bookkeeping : null;
  const delta = proposal ? outcome.canonical_outputs?.period_delta : null;
  const projected = proposal ? outcome.projected_state : null;
  let core = null;
  if (proposal) core = validateProposal(outcome, bookkeeping, delta, projected, source.context);
  else if (!['needs_input', 'out_of_scope'].includes(outcome.kind)) throw new TypeError(`Unsupported outcome kind ${outcome.kind}`);

  const transactions = proposal ? buildTransactions(bookkeeping, review) : [];
  const balances = proposal ? buildBalances(bookkeeping, labels) : [];
  const verification = proposal ? buildVerification(bookkeeping, delta) : null;
  const organization = bookkeeping?.organization ?? core?.organization ?? {};
  const questions = normalizeNotices(outcome.questions, "prompt", labels);
  const warnings = normalizeNotices(outcome.warnings, "message", labels);
  const reasons = normalizeNotices(outcome.reasons, "message", labels);
  const coreChanges = core ? flattenValues(core) : [];
  const openItemChanges = proposal ? (bookkeeping.open_items?.changes ?? []).map(normalizeOpenItemChange) : [];
  const closingOpenItems = proposal ? (bookkeeping.open_items?.closing ?? []).map(normalizeOpenItem) : [];
  const reconciliations = proposal ? (bookkeeping.reconciliations ?? []).map((item) => ({ ...item })) : [];
  const vat = proposal ? {
    ...bookkeeping.vat_period,
    hasActivity: hasVatActivity(bookkeeping),
    frequencyDisplay: labels[bookkeeping.vat_period.frequency],
    reportingPeriod: bookkeeping.vat_period.cycle_start && bookkeeping.vat_period.cycle_end
      ? `${bookkeeping.vat_period.cycle_start} – ${bookkeeping.vat_period.cycle_end}`
      : labels.none,
    reportingPeriodDisplay: bookkeeping.vat_period.cycle_start && bookkeeping.vat_period.cycle_end
      ? formatPeriodCoverage({ start: bookkeeping.vat_period.cycle_start, end: bookkeeping.vat_period.cycle_end }, source.language, labels)
      : labels.none,
    reportMonthDisplay: formatMonthYear(source.context.period.end, source.language),
    dueDisplay: bookkeeping.vat_period.due_in_period ? labels.yes : labels.no,
    inputAccountsDisplay: bookkeeping.vat_period.input_accounts.join(", "),
    outputAccountsDisplay: bookkeeping.vat_period.output_accounts.join(", "),
    closingTransactionDisplay: bookkeeping.vat_period.closing_transaction_source_id ?? labels.none,
  } : null;
  const evidence = (outcome.evidence ?? []).map((item) => ({ label: evidenceLabel(item), value: stableDisplay(item) }));
  const provenance = flattenValues(outcome.provenance ?? {});
  const company = {
    id: source.context.company_id,
    name: organization.name ?? source.context.company_id,
    organizationNumber: organization.organization_number ?? null,
    display: organization.organization_number
      ? `${organization.name ?? source.context.company_id} (${organization.organization_number})`
      : organization.name ?? source.context.company_id,
  };
  const period = {
    ...source.context.period,
    display: source.context.period.start
      ? `${source.context.period.id}: ${source.context.period.start} – ${source.context.period.end}`
      : `${source.context.period.id}: – ${source.context.period.end}`,
    coverageDisplay: formatPeriodCoverage(source.context.period, source.language, labels),
  };
  const createdDisplay = formatDisplayDate(new Date(source.recorded_at).toISOString().slice(0, 10), source.language);
  const statusDisplay = reportStatusDisplay(source, outcome, labels);
  const header = {
    identity: [company.name, company.organizationNumber, `${labels.created} ${createdDisplay}`].filter(Boolean).join(" · "),
    context: `${period.coverageDisplay} · ${statusDisplay}`,
  };
  const noticeGroups = [
    { id: "questions", title: labels.questions, items: questions },
    { id: "warnings", title: labels.warnings, items: warnings },
    { id: "reasons", title: labels.reasons, items: reasons },
  ].filter((group) => group.items.length);
  const sections = [
    { id: "summary", kind: "paragraph", title: labels.summary, value: review.summary, emptyText: labels.none },
    ...(noticeGroups.length ? [{
      id: "notices",
      kind: "notices",
      title: labels.notices,
      groups: noticeGroups,
      emptyText: labels.none,
    }] : []),
    { id: "core", kind: "key_values", title: labels.core, rows: coreChanges, emptyText: labels.none },
    { id: "transactions", kind: "transactions", title: labels.transactions, items: transactions, emptyText: labels.none },
    {
      id: "open_items",
      kind: "open_items",
      title: labels.openItems,
      groups: [
        { id: "changes", title: labels.openItemChanges, items: openItemChanges },
        { id: "closing", title: labels.closingOpenItems, items: closingOpenItems },
      ],
      emptyText: labels.none,
    },
    { id: "balances", kind: "balances", title: labels.balances, items: balances, emptyText: labels.none },
    { id: "verification", kind: "verification", title: labels.verification, value: verification, emptyText: labels.none },
    { id: "reconciliations", kind: "reconciliations", title: labels.reconciliations, items: reconciliations, emptyText: labels.none },
    { id: "vat", kind: "vat", title: labels.vat, value: vat, emptyText: labels.none },
    { id: "evidence", kind: "simple_rows", title: labels.evidence, rows: evidence, emptyText: labels.none },
    { id: "provenance", kind: "preformatted", title: labels.provenance, value: prettyCanonicalJson(outcome.provenance ?? {}) },
  ];

  return Object.freeze({
    language: source.language,
    labels,
    title: `${labels.title} – ${source.context.period.id}`,
    outcomeKind: outcome.kind,
    outcomeLabel: labels[outcome.kind],
    approvalStatus: source.approval_status,
    approvalLabel: labels[source.approval_status],
    previewNotice: source.approval_status === "preliminary" ? labels.previewNotice : null,
    statusDisplay,
    header,
    company,
    period,
    run: { ref: source.run_ref, digest: source.run_ref.sha256, recordedAt: source.recorded_at },
    summary: review.summary,
    narrativeSource: review.narrative_source,
    questions,
    warnings,
    reasons,
    coreChanges,
    transactions,
    openItemChanges,
    closingOpenItems,
    balances,
    verification,
    reconciliations,
    vat,
    evidence,
    provenance,
    sections,
    sourceDigest: snapshot.ref.sha256,
  });
}

const MONTHS = Object.freeze({
  sv: Object.freeze(["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"]),
  en: Object.freeze(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]),
});

function formatPeriodCoverage(period, language, labels) {
  const end = dateParts(period.end);
  if (!period.start) return `${labels.through} ${formatDateParts(end, language)}`;
  const start = dateParts(period.start);
  if (start.year === end.year && start.month === end.month) {
    return `${start.day}–${end.day} ${MONTHS[language][end.month - 1]} ${end.year}`;
  }
  if (start.year === end.year) {
    return `${start.day} ${MONTHS[language][start.month - 1]}–${formatDateParts(end, language)}`;
  }
  return `${formatDateParts(start, language)}–${formatDateParts(end, language)}`;
}

function formatDisplayDate(value, language) {
  return formatDateParts(dateParts(value), language);
}

function formatMonthYear(value, language) {
  const parts = dateParts(value);
  return `${MONTHS[language][parts.month - 1]} ${parts.year}`;
}

function formatDateParts(value, language) {
  return `${value.day} ${MONTHS[language][value.month - 1]} ${value.year}`;
}

function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`Invalid report date ${String(value)}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError(`Invalid report date ${value}`);
  }
  return { year, month, day };
}

function reportStatusDisplay(source, outcome, labels) {
  if (source.approval_status !== "approved") return labels[outcome.kind];
  const version = source.run_ref.version;
  return Number.isInteger(version) && version > 0
    ? `${labels.approved} ${labels.version} ${version}`
    : labels.approved;
}

function validateProposal(outcome, bookkeeping, delta, projected, context) {
  if (bookkeeping?.schema_version !== BOOKKEEPING_SCHEMA || delta?.schema_version !== BOOKKEEPING_SCHEMA) {
    throw new TypeError("Review v1 requires Bookkeeping output and period delta schema 3.0");
  }
  verifySealedContent(projected, "projected Bookkeeping State");
  if (projected.ref.schema_id !== "se.bergbok.bookkeeping.state" || projected.ref.schema_version !== BOOKKEEPING_SCHEMA) {
    throw new TypeError("Proposal has an unsupported projected Bookkeeping State");
  }
  assertKnownReportStructures(bookkeeping, delta, projected.payload);
  let core = null;
  let replaced = false;
  for (const change of outcome.proposed_changes) {
    if (change.action === "initialize_core_state") {
      if (core !== null || !change.core || typeof change.core !== "object") throw new TypeError("Invalid core-State initialization");
      core = change.core;
    } else if (change.action === "replace_domain_state") {
      if (replaced || change.domain !== "bookkeeping" || canonicalStringify(change.state_ref) !== canonicalStringify(projected.ref)) {
        throw new TypeError("Invalid Bookkeeping domain-State replacement");
      }
      replaced = true;
    } else {
      throw new TypeError(`Unsupported proposed change action ${String(change.action)}`);
    }
  }
  if (!replaced) throw new TypeError("Proposal does not replace the Bookkeeping domain State");
  assertSame(delta.transactions, bookkeeping.ledger?.transactions, "period-delta transactions");
  assertSame(delta.totals, bookkeeping.ledger?.totals, "period-delta totals");
  assertSame(delta.open_item_changes, bookkeeping.open_items?.changes, "period-delta open-item changes");
  assertSame(delta.reconciliations, bookkeeping.reconciliations, "period-delta reconciliations");
  assertSame(delta.vat_period, bookkeeping.vat_period, "period-delta VAT");
  if (
    bookkeeping.company_id !== context.company_id || delta.company_id !== context.company_id ||
    projected.payload.company_id !== context.company_id || bookkeeping.period_id !== context.period.id ||
    delta.period_id !== context.period.id || projected.payload.through_period_id !== context.period.id ||
    projected.payload.through_date !== context.period.end || delta.currency !== bookkeeping.ledger.currency ||
    projected.payload.currency !== bookkeeping.ledger.currency
  ) {
    throw new TypeError("Bookkeeping output, period delta, projected State, and snapshot context are inconsistent");
  }
  if (delta.mode === "import") assertSame(delta.opening_balances, bookkeeping.ledger.opening_balances, "import opening balances");
  assertSame(projected.payload.ledger?.balances, bookkeeping.ledger?.closing_balances, "projected closing balances");
  assertSame(projected.payload.ledger?.verification_series, bookkeeping.ledger?.verification_series, "projected verification series");
  assertSame(projected.payload.open_items?.items, bookkeeping.open_items?.closing, "projected closing open items");
  assertSame(projected.payload.open_items?.totals, bookkeeping.open_items?.totals, "projected open-item totals");
  assertSame(projected.payload.reconciliation?.accounts, bookkeeping.reconciliations, "projected reconciliations");
  assertSame(projected.payload.vat, bookkeeping.vat_period, "projected VAT");
  return core;
}

function assertReview(review) {
  if (!review || review.schema_version !== "1.0" || !["ai", "deterministic"].includes(review.narrative_source)) {
    throw new TypeError("OutputSnapshot contains an invalid Bookkeeping review");
  }
  assertOnlyKeys(review, ["schema_version", "language", "narrative_source", "summary", "transaction_summaries"], "Bookkeeping review");
  assertPlainText(review.summary, "Bookkeeping review summary", 2000, false);
  if (!Array.isArray(review.transaction_summaries)) throw new TypeError("Bookkeeping transaction summaries are required");
}

function buildTransactions(bookkeeping, review) {
  const source = bookkeeping.ledger?.transactions;
  if (!Array.isArray(source)) throw new TypeError("Bookkeeping output is missing transactions");
  const summaries = new Map();
  for (const item of review.transaction_summaries) {
    if (!item || typeof item.source_id !== "string" || typeof item.summary !== "string") throw new TypeError("Invalid transaction summary");
    assertOnlyKeys(item, ["source_id", "summary"], `Transaction summary ${item.source_id}`);
    assertPlainText(item.summary, `Transaction summary ${item.source_id}`, 240, true);
    if (summaries.has(item.source_id)) throw new TypeError(`Duplicate transaction summary for ${item.source_id}`);
    summaries.set(item.source_id, item.summary);
  }
  const ids = new Set(source.map((item) => item.source_id));
  if (ids.size !== source.length) throw new TypeError("Canonical transactions contain duplicate source_id values");
  for (const id of summaries.keys()) if (!ids.has(id)) throw new TypeError(`Unknown transaction summary source_id ${id}`);
  return source.map((transaction) => {
    if (!summaries.has(transaction.source_id)) throw new TypeError(`Missing transaction summary for ${transaction.source_id}`);
    const total = sumMoney(transaction.lines.map((line) => line.debit), bookkeeping.ledger.currency);
    return {
      sourceId: transaction.source_id,
      verificationId: transaction.verification_id,
      date: transaction.date,
      summary: summaries.get(transaction.source_id),
      total,
      evidenceDocumentIds: [...(transaction.evidence_document_ids ?? [])],
      lines: transaction.lines.map((line) => ({
        account: line.account,
        accountName: line.account_name,
        debit: line.debit,
        credit: line.credit,
      })),
    };
  });
}

function assertKnownReportStructures(bookkeeping, delta, projected) {
  assertOnlyKeys(bookkeeping, [
    "schema_id", "schema_version", "company_id", "period_id", "generated_date",
    "organization", "ledger", "open_items", "reconciliations", "vat_period",
  ], "Bookkeeping output");
  assertOnlyKeys(bookkeeping.ledger, [
    "currency", "opening_balances", "transactions", "totals", "closing_balances",
    "verification_series",
  ], "Bookkeeping ledger");
  assertOnlyKeys(bookkeeping.open_items, ["opening", "changes", "closing", "totals"], "Bookkeeping open items");
  assertOnlyKeys(bookkeeping.vat_period, [
    "frequency", "cycle_start", "cycle_end", "due_in_period", "input_accounts",
    "output_accounts", "settlement_account", "status",
    "closing_transaction_source_id", "declaration_boxes",
  ], "Bookkeeping VAT period");
  const vat = bookkeeping.vat_period;
  if (vat.frequency !== "quarterly"
      || !/^\d{4}-\d{2}-\d{2}$/.test(vat.cycle_start ?? "")
      || !/^\d{4}-\d{2}-\d{2}$/.test(vat.cycle_end ?? "")
      || !Array.isArray(vat.input_accounts) || vat.input_accounts.length === 0
      || !Array.isArray(vat.output_accounts) || vat.output_accounts.length === 0
      || !vat.input_accounts.every(validAccount)
      || !vat.output_accounts.every(validAccount)
      || !validAccount(vat.settlement_account)
      || typeof vat.due_in_period !== "boolean"
      || !["due", "not_due"].includes(vat.status)
      || vat.status === "due" !== vat.due_in_period
      || (vat.due_in_period
        ? typeof vat.closing_transaction_source_id !== "string" || !vat.closing_transaction_source_id
        : vat.closing_transaction_source_id !== null)
      || !vat.declaration_boxes || typeof vat.declaration_boxes !== "object" || Array.isArray(vat.declaration_boxes)) {
    throw new TypeError("Bookkeeping VAT period has an unsupported cadence or account policy");
  }
  const boxKeys = Object.keys(vat.declaration_boxes).sort();
  if ((vat.due_in_period && boxKeys.join(",") !== "10,11,12,48,49")
      || (!vat.due_in_period && boxKeys.length !== 0)) {
    throw new TypeError("Bookkeeping VAT declaration boxes do not match the due state");
  }
  assertOnlyKeys(delta, [
    "schema_id", "schema_version", "company_id", "period_id", "mode", "currency",
    "opening_balances", "imported_verification_series", "transactions", "totals",
    "open_item_changes", "reconciliations", "vat_period",
  ], "Bookkeeping period delta");
  assertOnlyKeys(projected, [
    "contract_version", "status", "schema_id", "schema_version", "company_id",
    "through_period_id", "through_date", "currency", "ledger", "open_items",
    "reconciliation", "vat",
  ], "projected Bookkeeping State");
  assertOnlyKeys(projected.ledger, ["balances", "verification_series"], "projected Bookkeeping ledger");
  assertOnlyKeys(projected.open_items, ["items", "totals"], "projected Bookkeeping open items");
  assertOnlyKeys(projected.reconciliation, ["period_id", "accounts"], "projected Bookkeeping reconciliation");
}

function validAccount(value) {
  return typeof value === "string" && /^\d{4}$/.test(value);
}

function assertOnlyKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unreported fields: ${unknown.join(", ")}`);
}

function assertPlainText(value, label, maxLength, singleLine) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
  if (value.length > maxLength) throw new TypeError(`${label} exceeds ${maxLength} characters`);
  if (/\r/.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} contains control characters`);
  }
  if (/[<>]/.test(value)) throw new TypeError(`${label} must not contain markup`);
  if (singleLine && /\n/.test(value)) throw new TypeError(`${label} must be one line`);
}

function buildBalances(bookkeeping, labels) {
  const currency = bookkeeping.ledger.currency;
  const opening = balanceMap(bookkeeping.ledger.opening_balances ?? [], currency);
  const closing = balanceMap(bookkeeping.ledger.closing_balances ?? [], currency);
  const movement = new Map();
  for (const transaction of bookkeeping.ledger.transactions ?? []) {
    for (const line of transaction.lines ?? []) {
      const current = movement.get(line.account) ?? { name: line.account_name, net: 0n };
      current.name = line.account_name;
      current.net += money(line.debit, currency) - money(line.credit, currency);
      movement.set(line.account, current);
    }
  }
  const accounts = [...new Set([...opening.keys(), ...movement.keys(), ...closing.keys()])].sort((a, b) => a.localeCompare(b));
  return accounts.map((account) => {
    const openingRow = opening.get(account) ?? { name: null, net: 0n };
    const movementRow = movement.get(account) ?? { name: null, net: 0n };
    const closingRow = closing.get(account) ?? { name: null, net: 0n };
    if (openingRow.net + movementRow.net !== closingRow.net) throw new TypeError(`Account ${account} closing balance disagrees with its movement`);
    return {
      account,
      accountName: closingRow.name ?? movementRow.name ?? openingRow.name ?? "",
      opening: signedMoney(openingRow.net, currency),
      openingDisplay: sideMoneyDisplay(signedMoney(openingRow.net, currency), labels),
      movementDebit: formatMoney(movementRow.net > 0n ? movementRow.net : 0n, currency),
      movementCredit: formatMoney(movementRow.net < 0n ? -movementRow.net : 0n, currency),
      closing: signedMoney(closingRow.net, currency),
      closingDisplay: sideMoneyDisplay(signedMoney(closingRow.net, currency), labels),
    };
  });
}

function buildVerification(bookkeeping, delta) {
  const closing = bookkeeping.ledger.verification_series;
  const count = bookkeeping.ledger.transactions.length;
  const opening = delta.mode === "import"
    ? delta.imported_verification_series?.last_number ?? closing.last_number
    : closing.last_number - count;
  return { series: closing.series, openingLastNumber: opening, closingLastNumber: closing.last_number };
}

function hasVatActivity(bookkeeping) {
  const vat = bookkeeping.vat_period;
  const accounts = new Set([...vat.input_accounts, ...vat.output_accounts]);
  return bookkeeping.ledger.transactions.some((transaction) => transaction.lines.some((line) =>
    accounts.has(line.account)
      && (money(line.debit, bookkeeping.ledger.currency) !== 0n || money(line.credit, bookkeeping.ledger.currency) !== 0n)));
}

function normalizeNotices(items, textKey, labels) {
  return (items ?? []).map((item) => {
    const code = item.code ?? "";
    const text = item[textKey] ?? item.prompt ?? item.message ?? "";
    const evidenceDocumentIds = [...(item.evidence_document_ids ?? [])];
    return {
      code,
      text,
      evidenceDocumentIds,
      display: `${code}: ${text}${evidenceDocumentIds.length ? ` (${labels.evidenceIds}: ${evidenceDocumentIds.join(", ")})` : ""}`,
    };
  });
}

function normalizeOpenItemChange(item) {
  return {
    action: item.action,
    itemId: item.item_id,
    kind: item.kind ?? null,
    party: item.party ?? null,
    amount: item.amount ?? null,
    dueDate: item.due_date ?? null,
    evidenceDocumentIds: [...(item.evidence_document_ids ?? [])],
  };
}

function normalizeOpenItem(item) {
  return {
    itemId: item.item_id,
    kind: item.kind,
    party: item.party,
    remaining: item.remaining,
    dueDate: item.due_date ?? null,
    evidenceDocumentIds: [...(item.evidence_document_ids ?? [])],
  };
}

function balanceMap(rows, currency) {
  const result = new Map();
  for (const row of rows) {
    if (result.has(row.account)) throw new TypeError(`Duplicate balance account ${row.account}`);
    result.set(row.account, { name: row.account_name, net: money(row.debit, currency) - money(row.credit, currency) });
  }
  return result;
}

function signedMoney(value, currency) {
  return value >= 0n
    ? { side: "debit", amount: formatMoney(value, currency) }
    : { side: "credit", amount: formatMoney(-value, currency) };
}

function sideMoneyDisplay(value, labels) {
  return `${value.amount} ${value.side === "debit" ? labels.debit : labels.credit}`;
}

function sumMoney(values, currency) {
  return formatMoney(values.reduce((sum, value) => sum + money(value, currency), 0n), currency);
}

function money(value, currency) {
  return parseMoney(value, { expectedCurrency: currency }).minorUnits;
}

function assertSame(left, right, label) {
  if (canonicalStringify(left) !== canonicalStringify(right)) throw new TypeError(`${label} are inconsistent`);
}

function flattenValues(value, prefix = "") {
  if (value === null || typeof value !== "object") return [{ path: prefix || "$", value: stableDisplay(value) }];
  if (Array.isArray(value)) return value.length
    ? value.flatMap((child, index) => flattenValues(child, `${prefix}[${index}]`))
    : [{ path: prefix || "$", value: "[]" }];
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return entries.length
    ? entries.flatMap(([key, child]) => flattenValues(child, prefix ? `${prefix}.${key}` : key))
    : [{ path: prefix || "$", value: "{}" }];
}

function evidenceLabel(item) {
  return item.document_id ?? item.facts_ref?.stable_id ?? item.result_ref?.stable_id ?? item.kind ?? "evidence";
}

function stableDisplay(value) {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value !== "object") return String(value);
  return canonicalStringify(value);
}
