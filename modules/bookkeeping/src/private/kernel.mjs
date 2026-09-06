import {
  assignVerificationNumbers,
  combineBalances,
  isPlainObject,
  issue,
  movementsFromTransactions,
  netBalanceForAccount,
  normalizeAccount,
  normalizeBalances,
  normalizeTransactions,
  totalsForTransactions,
  validIsoDate,
} from "./ledger.mjs";
import { verifySealedContent } from "../../../../contracts/src/index.mjs";
import {
  BOOKKEEPING_SCHEMA_VERSION,
  adaptBookkeepingState,
  bookkeepingToPortable,
} from "./money-boundary.mjs";

export const BOOKKEEPING_STATE_SCHEMA_ID = "se.bergbok.bookkeeping.state";
export const PERIOD_DELTA_SCHEMA_ID = "se.bergbok.bookkeeping-period-delta";
export const CANONICAL_OUTPUT_SCHEMA_ID = "se.bergbok.bookkeeping-output";

export function evaluateBookkeeping({
  caseBundle,
  input,
  inputDocumentId,
  documentIds,
  payrollTransactions,
  payrollOpenItemChanges,
  bounds,
}) {
  const issues = [...bounds.issues];
  const warnings = [];
  const policy = caseBundle.payload.effective_policies;
  const previousPayload = caseBundle.payload.previous_state.payload;
  const storedPreviousDomain = previousPayload.domains?.bookkeeping ?? null;
  let previousDomain = storedPreviousDomain;
  if (storedPreviousDomain) {
    try {
      const previousPayloadValue = verifiedDomainPayload(storedPreviousDomain, "previous Bookkeeping state");
      previousDomain = adaptBookkeepingState(previousPayloadValue, policy.core.currency);
    } catch (error) {
      issues.push(issue(
        "PREVIOUS_BOOKKEEPING_MONEY_INVALID",
        error instanceof Error ? error.message : String(error),
        "previous_state.domains.bookkeeping",
      ));
      previousDomain = null;
    }
  }
  const organization = resolveOrganization({ caseBundle, input, previousPayload, issues });

  let openingBalances = [];
  let previousLastNumber = 0;
  let openingItems = [];
  if (["start", "import"].includes(input.mode)) {
    if (previousPayload.sequence !== 0 || storedPreviousDomain) {
      issues.push(issue("INITIAL_STATE_NOT_EMPTY", "Start and Import require empty predecessor State S0", "previous_state"));
    }
    if (input.mode === "start") {
      for (const field of ["imported_balances", "imported_open_items", "imported_verification_series"]) {
        if (hasContent(input[field])) issues.push(issue("START_DATA_NOT_ALLOWED", `Start must not contain ${field}`, `bookkeeping_input.${field}`));
      }
    } else {
      if (!Array.isArray(input.imported_balances)) {
        issues.push(issue("IMPORTED_BALANCES_REQUIRED", "Import requires imported_balances", "bookkeeping_input.imported_balances"));
      }
      if (!Array.isArray(input.imported_open_items)) {
        issues.push(issue("IMPORTED_OPEN_ITEMS_REQUIRED", "Import requires imported_open_items", "bookkeeping_input.imported_open_items"));
      }
      const normalized = normalizeBalances(input.imported_balances ?? [], "bookkeeping_input.imported_balances");
      openingBalances = normalized.balances;
      issues.push(...normalized.issues);
      openingItems = normalizeExistingOpenItems(input.imported_open_items ?? [], "bookkeeping_input.imported_open_items", issues);
      validateImportedOpenItemEvidence(openingItems, new Set(documentIds), issues);
      const importedSeries = input.imported_verification_series;
      if (!isPlainObject(importedSeries)
          || importedSeries.series !== policy.bookkeeping.verification_series
          || !Number.isSafeInteger(importedSeries.last_number)
          || importedSeries.last_number < 0) {
        issues.push(issue(
          "IMPORTED_VERIFICATION_SERIES_INVALID",
          `Import requires verification series ${policy.bookkeeping.verification_series} and a non-negative last_number`,
          "bookkeeping_input.imported_verification_series",
        ));
      } else {
        previousLastNumber = importedSeries.last_number;
      }
    }
  } else {
    for (const field of ["imported_balances", "imported_open_items", "imported_verification_series"]) {
      if (hasContent(input[field])) issues.push(issue("IMPORTED_DATA_NOT_ALLOWED", `Ordinary periods must not contain ${field}`, `bookkeeping_input.${field}`));
    }
    if (!previousDomain) {
      issues.push(issue("PREVIOUS_BOOKKEEPING_STATE_REQUIRED", "An ordinary Period requires preceding Bookkeeping State", "previous_state.domains.bookkeeping"));
    } else {
      validatePreviousDomain(previousDomain, caseBundle, policy, bounds, issues);
      const normalized = normalizeBalances(previousDomain.ledger?.balances, "previous_state.domains.bookkeeping.ledger.balances");
      openingBalances = normalized.balances;
      issues.push(...normalized.issues);
      const series = previousDomain.ledger?.verification_series;
      if (!isPlainObject(series) || series.series !== policy.bookkeeping.verification_series
          || !Number.isSafeInteger(series.last_number) || series.last_number < 0) {
        issues.push(issue("VERIFICATION_CONTINUITY_INVALID", "The preceding verification-series state is invalid", "previous_state.domains.bookkeeping.ledger.verification_series"));
      } else {
        previousLastNumber = series.last_number;
      }
      openingItems = normalizeExistingOpenItems(previousDomain.open_items?.items ?? [], "previous_state.domains.bookkeeping.open_items.items", issues);
    }
  }

  const direct = normalizeTransactions(input.transactions ?? [], {
    label: "bookkeeping_input.transactions",
    periodStart: bounds.start,
    periodEnd: bounds.end,
    origin: "bookkeeping_input",
    evidenceFallback: [inputDocumentId],
    sourcePrefix: inputDocumentId,
  });
  issues.push(...direct.issues);
  if (input.mode !== "ordinary" && direct.transactions.length > 0) {
    issues.push(issue("TRANSACTIONS_NOT_ALLOWED", `${input.mode} must not contain transactions`, "bookkeeping_input.transactions"));
  }
  validateEvidenceReferences(direct.transactions, new Set(documentIds), issues);

  const upstreamTransactions = payrollTransactions.map((transaction, index) => ({
    ...transaction,
    _source_order: direct.transactions.length + index,
  }));
  for (const transaction of upstreamTransactions) {
    if (!validIsoDate(transaction.date)
        || bounds.start && transaction.date < bounds.start
        || bounds.end && transaction.date > bounds.end) {
      issues.push(issue("PAYROLL_TRANSACTION_OUTSIDE_PERIOD", `Payroll transaction ${transaction.source_id} is outside the bookkeeping period`, "upstream_results"));
    }
  }
  const allUnnumbered = [...direct.transactions, ...upstreamTransactions];
  if (input.mode !== "ordinary" && upstreamTransactions.length > 0) {
    issues.push(issue("PAYROLL_POSTINGS_NOT_ALLOWED", `${input.mode} must not contain payroll postings`, "bookkeeping_input.payroll_postings"));
  }
  const scopeReasons = [];
  if (allUnnumbered.length > 100) {
    scopeReasons.push({ code: "TRANSACTION_LIMIT_EXCEEDED", message: "The Pilot supports at most 100 transactions per period" });
  }

  const series = policy.bookkeeping.verification_series;
  const transactions = assignVerificationNumbers(allUnnumbered, { series, previousLastNumber });
  const movements = movementsFromTransactions(transactions);
  const closingBalances = combineBalances(openingBalances, movements);
  const totals = totalsForTransactions(transactions);
  if (totals.debit_ore !== totals.credit_ore) {
    issues.push(issue("PERIOD_IMBALANCE", "The complete period delta is not balanced", "transactions"));
  }

  const rawOpenItemChanges = [
    ...(Array.isArray(input.open_item_changes) ? input.open_item_changes.map((row) => ({ ...row, origin: row.origin ?? "bookkeeping_input" })) : []),
    ...payrollOpenItemChanges,
  ];
  if (input.open_item_changes !== undefined && !Array.isArray(input.open_item_changes)) {
    issues.push(issue("OPEN_ITEM_CHANGES_INVALID", "open_item_changes must be an array", "bookkeeping_input.open_item_changes"));
  }
  if (input.mode !== "ordinary" && rawOpenItemChanges.length > 0) {
    issues.push(issue("OPEN_ITEM_CHANGES_NOT_ALLOWED", `${input.mode} must not contain open-item changes`, "bookkeeping_input.open_item_changes"));
  }
  const openItems = applyOpenItemChanges(openingItems, rawOpenItemChanges, new Set(documentIds), issues);
  if (input.mode === "start" && hasContent(input.reconciliations)) {
    issues.push(issue("START_RECONCILIATIONS_NOT_ALLOWED", "Start must not contain reconciliations", "bookkeeping_input.reconciliations"));
  }
  const reconciliations = calculateReconciliations(input.mode === "start" ? [] : (input.reconciliations ?? []), closingBalances, new Set(documentIds), issues, warnings);
  const vatPeriod = calculateVat({
    value: input.vat,
    policy: policy.bookkeeping.vat_reporting,
    bounds,
    mode: input.mode,
    openingBalances,
    transactions,
    closingBalances,
    issues,
  });
  const generatedDate = bounds.end ?? input.generated_date;
  if (!validIsoDate(generatedDate)) issues.push(issue("GENERATED_DATE_REQUIRED", "A valid Period end is required", "period.end"));

  const periodDelta = {
    schema_id: PERIOD_DELTA_SCHEMA_ID,
    schema_version: BOOKKEEPING_SCHEMA_VERSION,
    company_id: caseBundle.payload.company_id,
    period_id: caseBundle.payload.period.id,
    mode: input.mode,
    currency: policy.core.currency,
    opening_balances: input.mode === "import" ? openingBalances : [],
    ...(input.mode === "import" ? { imported_verification_series: { series, last_number: previousLastNumber } } : {}),
    transactions,
    totals,
    open_item_changes: openItems.changes,
    reconciliations,
    vat_period: vatPeriod,
  };
  const domainState = {
    contract_version: "1.0",
    status: "projected",
    schema_id: BOOKKEEPING_STATE_SCHEMA_ID,
    schema_version: BOOKKEEPING_SCHEMA_VERSION,
    company_id: caseBundle.payload.company_id,
    through_period_id: caseBundle.payload.period.id,
    through_date: bounds.end ?? null,
    currency: policy.core.currency,
    ledger: {
      balances: closingBalances,
      verification_series: { series, last_number: previousLastNumber + transactions.length },
    },
    open_items: { items: openItems.closing, totals: openItems.totals },
    reconciliation: { period_id: caseBundle.payload.period.id, accounts: reconciliations },
    vat: vatPeriod,
  };
  const canonicalOutput = {
    schema_id: CANONICAL_OUTPUT_SCHEMA_ID,
    schema_version: BOOKKEEPING_SCHEMA_VERSION,
    company_id: caseBundle.payload.company_id,
    period_id: caseBundle.payload.period.id,
    generated_date: generatedDate,
    organization,
    ledger: {
      currency: policy.core.currency,
      opening_balances: openingBalances,
      transactions,
      totals,
      closing_balances: closingBalances,
      verification_series: domainState.ledger.verification_series,
    },
    open_items: {
      opening: openingItems,
      changes: openItems.changes,
      closing: openItems.closing,
      totals: openItems.totals,
    },
    reconciliations,
    vat_period: vatPeriod,
  };

  return {
    issues,
    warnings,
    scopeReasons,
    periodDelta: bookkeepingToPortable(periodDelta, policy.core.currency),
    domainState: bookkeepingToPortable(domainState, policy.core.currency),
    canonicalOutput: bookkeepingToPortable(canonicalOutput, policy.core.currency),
  };
}

function verifiedDomainPayload(value, label) {
  if (!value?.ref || !Object.hasOwn(value, "payload")) return value;
  verifySealedContent(value, label);
  if (value.payload?.schema_version !== undefined && value.payload.schema_version !== value.ref.schema_version) {
    throw new TypeError(`${label} payload and ContentRef schema versions disagree`);
  }
  return value.payload;
}

function hasContent(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function resolveOrganization({ caseBundle, input, previousPayload, issues }) {
  const source = previousPayload.core?.organization ?? caseBundle.payload.organization ?? input.organization ?? {};
  const organization = {
    name: cleanText(source.name ?? source.legal_name),
    organization_number: cleanText(source.organization_number ?? source.organisationsnummer),
  };
  if (!organization.name) issues.push(issue("ORGANIZATION_NAME_REQUIRED", "Organization name is required", "organization.name"));
  if (!/^\d{6}-\d{4}$/.test(organization.organization_number ?? "")) {
    issues.push(issue("ORGANIZATION_NUMBER_INVALID", "Organization number must use xxxxxx-xxxx", "organization.organization_number"));
  }
  const duplicate = input.organization;
  if (duplicate?.name && organization.name && duplicate.name !== organization.name) {
    issues.push(issue("ORGANIZATION_MISMATCH", "Input organization name differs from trusted case data", "bookkeeping_input.organization.name"));
  }
  if (duplicate?.organization_number && organization.organization_number
      && duplicate.organization_number !== organization.organization_number) {
    issues.push(issue("ORGANIZATION_MISMATCH", "Input organization number differs from trusted case data", "bookkeeping_input.organization.organization_number"));
  }
  return organization;
}

function validatePreviousDomain(previousDomain, caseBundle, policy, bounds, issues) {
  if (previousDomain.contract_version !== "1.0"
      || previousDomain.schema_id !== BOOKKEEPING_STATE_SCHEMA_ID
      || !["1.0", BOOKKEEPING_SCHEMA_VERSION].includes(previousDomain.schema_version)
      || previousDomain.company_id !== caseBundle.payload.company_id
      || previousDomain.currency !== policy.core.currency) {
    issues.push(issue(
      "PREVIOUS_BOOKKEEPING_STATE_INCOMPATIBLE",
      "The preceding bookkeeping State has an incompatible schema, company, or currency",
      "previous_state.domains.bookkeeping",
    ));
  }
  const previousThroughDate = previousDomain.through_date;
  const expectedThroughDate = previousDate(bounds.start);
  if (expectedThroughDate && previousThroughDate !== expectedThroughDate) {
    issues.push(issue(
      "BOOKKEEPING_PERIOD_CONTINUITY_INVALID",
      `The preceding bookkeeping State must end at ${expectedThroughDate}`,
      "previous_state.domains.bookkeeping.through_date",
    ));
  }
}

function previousDate(value) {
  if (!validIsoDate(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function validateEvidenceReferences(transactions, documentIds, issues) {
  for (const transaction of transactions) {
    for (const documentId of transaction.evidence_document_ids) {
      if (!documentIds.has(documentId)) {
        issues.push(issue("EVIDENCE_NOT_IN_DOCSET", `Transaction ${transaction.source_id} cites ${documentId}, which is not in the fixed Docset`, "transactions.evidence_document_ids"));
      }
    }
  }
}

function validateImportedOpenItemEvidence(items, documentIds, issues) {
  for (const item of items) {
    for (const documentId of item.evidence_document_ids) {
      if (!documentIds.has(documentId)) {
        issues.push(issue("EVIDENCE_NOT_IN_DOCSET", `Imported open item ${item.item_id} cites ${documentId}, which is not in the fixed Docset`, "bookkeeping_input.imported_open_items"));
      }
    }
  }
}

function normalizeExistingOpenItems(rows, label, issues) {
  if (!Array.isArray(rows)) {
    issues.push(issue("OPEN_ITEMS_INVALID", `${label} must be an array`, label));
    return [];
  }
  const ids = new Set();
  const result = [];
  rows.forEach((row, index) => {
    const path = `${label}[${index}]`;
    if (!isPlainObject(row) || typeof row.item_id !== "string" || !row.item_id
        || typeof row.kind !== "string" || !row.kind || typeof row.party !== "string" || !row.party
        || typeof (row.remaining_ore ?? row.amount_ore) !== "bigint" || (row.remaining_ore ?? row.amount_ore) <= 0n) {
      issues.push(issue("OPEN_ITEM_INVALID", `${path} is not a valid open item`, path));
      return;
    }
    if (ids.has(row.item_id)) {
      issues.push(issue("OPEN_ITEM_DUPLICATE", `${path}.item_id is duplicated`, `${path}.item_id`));
      return;
    }
    ids.add(row.item_id);
    const remaining = row.remaining_ore ?? row.amount_ore;
    result.push({
      item_id: row.item_id,
      kind: row.kind,
      party: row.party,
      original_amount_ore: row.original_amount_ore ?? remaining,
      remaining_ore: remaining,
      ...(row.due_date ? { due_date: row.due_date } : {}),
      evidence_document_ids: Array.isArray(row.evidence_document_ids) ? [...row.evidence_document_ids] : [],
      origin: row.origin ?? "previous_state",
    });
  });
  return result.sort((left, right) => left.item_id.localeCompare(right.item_id));
}

function applyOpenItemChanges(opening, rows, documentIds, issues) {
  const items = new Map(opening.map((item) => [item.item_id, { ...item }]));
  const changes = [];
  for (const [index, row] of rows.entries()) {
    const path = `open_item_changes[${index}]`;
    if (!isPlainObject(row) || !["open", "settle"].includes(row.action)) {
      issues.push(issue("OPEN_ITEM_CHANGE_INVALID", `${path}.action must be open or settle`, path));
      continue;
    }
    if (typeof row.item_id !== "string" || !row.item_id) {
      issues.push(issue("OPEN_ITEM_ID_REQUIRED", `${path}.item_id is required`, `${path}.item_id`));
      continue;
    }
    const evidence = Array.isArray(row.evidence_document_ids) ? row.evidence_document_ids : [];
    if (row.origin !== "approved_payroll") {
      for (const documentId of evidence) {
        if (!documentIds.has(documentId)) issues.push(issue("EVIDENCE_NOT_IN_DOCSET", `${path} cites ${documentId}, which is not in the fixed Docset`, path));
      }
    }
    if (row.action === "open") {
      if (items.has(row.item_id)) {
        issues.push(issue("OPEN_ITEM_ALREADY_EXISTS", `${row.item_id} is already open`, path));
        continue;
      }
      if (typeof row.kind !== "string" || !row.kind || typeof row.party !== "string" || !row.party
          || typeof row.amount_ore !== "bigint" || row.amount_ore <= 0n) {
        issues.push(issue("OPEN_ITEM_INVALID", `${path} has invalid open-item fields`, path));
        continue;
      }
      const item = {
        item_id: row.item_id,
        kind: row.kind,
        party: row.party,
        original_amount_ore: row.amount_ore,
        remaining_ore: row.amount_ore,
        ...(row.due_date ? { due_date: row.due_date } : {}),
        evidence_document_ids: [...evidence],
        origin: row.origin ?? "bookkeeping_input",
      };
      items.set(row.item_id, item);
      changes.push({ ...row, evidence_document_ids: [...evidence] });
    } else {
      const current = items.get(row.item_id);
      if (!current) {
        issues.push(issue("OPEN_ITEM_NOT_FOUND", `${row.item_id} is not open`, path));
        continue;
      }
      const amount = row.amount_ore ?? current.remaining_ore;
      if (typeof amount !== "bigint" || amount <= 0n || amount > current.remaining_ore) {
        issues.push(issue("SETTLEMENT_AMOUNT_INVALID", `${path}.amount exceeds the remaining open amount`, `${path}.amount`));
        continue;
      }
      current.remaining_ore -= amount;
      if (current.remaining_ore === 0n) items.delete(row.item_id);
      changes.push({ action: "settle", item_id: row.item_id, amount_ore: amount, evidence_document_ids: [...evidence], origin: row.origin ?? "bookkeeping_input" });
    }
  }
  const closing = [...items.values()].sort((left, right) => left.item_id.localeCompare(right.item_id));
  const byKind = {};
  for (const item of closing) byKind[item.kind] = (byKind[item.kind] ?? 0n) + item.remaining_ore;
  return { changes, closing, totals: { count: closing.length, by_kind_ore: byKind } };
}

function calculateReconciliations(rows, closingBalances, documentIds, issues, warnings) {
  if (!Array.isArray(rows)) {
    issues.push(issue("RECONCILIATIONS_INVALID", "reconciliations must be an array", "bookkeeping_input.reconciliations"));
    return [];
  }
  const accounts = new Set();
  return rows.map((row, index) => {
    const path = `bookkeeping_input.reconciliations[${index}]`;
    const account = normalizeAccount(row?.account);
    if (!account) issues.push(issue("ACCOUNT_INVALID", `${path}.account must be a four-digit BAS account`, `${path}.account`));
    if (account && accounts.has(account)) issues.push(issue("RECONCILIATION_DUPLICATE", `Account ${account} is reconciled more than once`, path));
    accounts.add(account);
    const ledgerClosing = account ? netBalanceForAccount(closingBalances, account) : 0n;
    const evidence = Array.isArray(row?.evidence_document_ids) ? row.evidence_document_ids : [];
    for (const documentId of evidence) if (!documentIds.has(documentId)) issues.push(issue("EVIDENCE_NOT_IN_DOCSET", `${path} cites unknown document ${documentId}`, path));
    if (typeof row?.external_closing_balance_ore !== "bigint") {
      warnings.push({ code: "RECONCILIATION_EVIDENCE_MISSING", message: `Account ${account ?? "?"} has no external closing balance` });
      return { account: account ?? String(row?.account ?? ""), status: "missing_evidence", ledger_closing_balance_ore: ledgerClosing, external_closing_balance_ore: null, evidence_document_ids: evidence };
    }
    const matched = row.external_closing_balance_ore === ledgerClosing;
    if (!matched) issues.push(issue("RECONCILIATION_MISMATCH", `Account ${account} ledger balance does not match external evidence`, path));
    return { account, status: matched ? "reconciled" : "mismatched", ledger_closing_balance_ore: ledgerClosing, external_closing_balance_ore: row.external_closing_balance_ore, evidence_document_ids: evidence };
  });
}

function calculateVat({ value, policy, bounds, mode, openingBalances, transactions, closingBalances, issues }) {
  const cycle = quarterlyCycle(bounds, mode, issues);
  const base = {
    frequency: policy.frequency,
    cycle_start: cycle.start,
    cycle_end: cycle.end,
    due_in_period: cycle.due,
    input_accounts: [...policy.input_accounts],
    output_accounts: [...policy.output_accounts],
    settlement_account: policy.settlement_account,
  };
  if (value && (Object.hasOwn(value, "reporting_period_start") || Object.hasOwn(value, "reporting_period_end"))) {
    issues.push(issue("VAT_PERIOD_DATES_DETERMINISTIC", "VAT cycle dates must not be supplied by the candidate", "bookkeeping_input.vat"));
  }
  if (mode === "start") {
    if (value !== undefined && value !== null
        && (value.status !== "not_due" || value.closing_transaction_source_id || value.declaration_boxes_sek)) {
      issues.push(issue("START_VAT_NOT_ALLOWED", "Start cannot establish VAT output", "bookkeeping_input.vat"));
    }
    return { ...base, due_in_period: false, status: "not_due", closing_transaction_source_id: null, declaration_boxes_sek: {} };
  }
  if (!isPlainObject(value) || !["not_due", "due"].includes(value.status)) {
    issues.push(issue("VAT_INVALID", "vat.status must be not_due or due", "bookkeeping_input.vat"));
    return { ...base, status: cycle.due ? "due" : "not_due", closing_transaction_source_id: null, declaration_boxes_sek: {} };
  }
  if (!cycle.due) {
    if (value.status !== "not_due") issues.push(issue("VAT_DUE_MISMATCH", "VAT cannot be due outside the company reporting-cycle end", "bookkeeping_input.vat.status"));
    if (value.closing_transaction_source_id !== undefined && value.closing_transaction_source_id !== null) {
      issues.push(issue("VAT_CLOSING_NOT_DUE", "A VAT closing transaction is not allowed before quarter end", "bookkeeping_input.vat.closing_transaction_source_id"));
    }
    if (value.declaration_boxes_sek !== undefined && value.declaration_boxes_sek !== null) {
      issues.push(issue("VAT_BOXES_NOT_DUE", "VAT declaration boxes are not allowed before quarter end", "bookkeeping_input.vat.declaration_boxes"));
    }
    return { ...base, status: "not_due", closing_transaction_source_id: null, declaration_boxes_sek: {} };
  }
  if (value.status !== "due") {
    issues.push(issue("VAT_DUE_MISMATCH", "Quarterly VAT is due in this Period", "bookkeeping_input.vat.status"));
  }
  const boxes = normalizeVatBoxes(value.declaration_boxes_sek, issues);
  const closingSourceId = typeof value.closing_transaction_source_id === "string" && value.closing_transaction_source_id
    ? value.closing_transaction_source_id
    : null;
  if (!closingSourceId) {
    issues.push(issue("VAT_CLOSING_REQUIRED", "Quarter-end VAT requires a referenced closing transaction", "bookkeeping_input.vat.closing_transaction_source_id"));
  } else {
    validateVatClosing({
      sourceId: closingSourceId,
      cycle,
      policy,
      boxes,
      openingBalances,
      transactions,
      closingBalances,
      issues,
    });
  }
  return { ...base, status: "due", closing_transaction_source_id: closingSourceId, declaration_boxes_sek: boxes };
}

function quarterlyCycle(bounds, mode, issues) {
  const containing = quarterForDate(bounds.end);
  if (mode !== "ordinary" || !bounds.start) return { ...containing, due: false };
  const deadlines = [];
  for (let year = Number(bounds.start.slice(0, 4)); year <= Number(bounds.end.slice(0, 4)); year += 1) {
    for (const suffix of ["03-31", "06-30", "09-30", "12-31"]) {
      const date = `${year}-${suffix}`;
      if (date >= bounds.start && date <= bounds.end) deadlines.push(date);
    }
  }
  if (deadlines.length > 1) {
    issues.push(issue("VAT_PERIOD_SPANS_MULTIPLE_DEADLINES", "A Bookkeeping Period cannot contain more than one quarterly VAT deadline", "period"));
  }
  return deadlines.length ? { ...quarterForDate(deadlines[0]), due: true } : { ...containing, due: false };
}

function quarterForDate(value) {
  const year = value.slice(0, 4);
  const month = Number(value.slice(5, 7));
  const quarter = Math.floor((month - 1) / 3);
  const starts = ["01-01", "04-01", "07-01", "10-01"];
  const ends = ["03-31", "06-30", "09-30", "12-31"];
  return { start: `${year}-${starts[quarter]}`, end: `${year}-${ends[quarter]}` };
}

function normalizeVatBoxes(value, issues) {
  if (!isPlainObject(value)) {
    issues.push(issue("VAT_BOXES_REQUIRED", "Quarter-end VAT declaration boxes are required", "bookkeeping_input.vat.declaration_boxes"));
  }
  const boxes = {};
  for (const box of ["10", "11", "12", "48", "49"]) {
    const amount = value?.[box] ?? 0n;
    if (typeof amount !== "bigint") issues.push(issue("VAT_BOX_INVALID", `VAT box ${box} must be whole-krona canonical Money`, `bookkeeping_input.vat.declaration_boxes.${box}`));
    boxes[box] = typeof amount === "bigint" ? amount : 0n;
  }
  const expected49 = boxes["10"] + boxes["11"] + boxes["12"] - boxes["48"];
  if (boxes["49"] !== expected49) {
    issues.push(issue("VAT_BOX_49_MISMATCH", "VAT box 49 must equal boxes 10–12 less box 48", "bookkeeping_input.vat.declaration_boxes.49"));
  }
  return boxes;
}

function validateVatClosing({ sourceId, cycle, policy, boxes, openingBalances, transactions, closingBalances, issues }) {
  const index = transactions.findIndex((transaction) => transaction.source_id === sourceId);
  if (index < 0) {
    issues.push(issue("VAT_CLOSING_UNKNOWN", `VAT closing transaction ${sourceId} does not exist`, "bookkeeping_input.vat.closing_transaction_source_id"));
    return;
  }
  const transaction = transactions[index];
  if (index !== transactions.length - 1) issues.push(issue("VAT_CLOSING_NOT_LAST", "The VAT closing transaction must be the final transaction", "bookkeeping_input.vat.closing_transaction_source_id"));
  if (transaction.date !== cycle.end) issues.push(issue("VAT_CLOSING_DATE_MISMATCH", `The VAT closing transaction must be dated ${cycle.end}`, "bookkeeping_input.vat.closing_transaction_source_id"));
  const allowed = new Set([...policy.input_accounts, ...policy.output_accounts, policy.settlement_account]);
  if (transaction.lines.some((line) => !allowed.has(line.account))) {
    issues.push(issue("VAT_CLOSING_ACCOUNT_INVALID", "The VAT closing transaction contains an account outside the configured VAT policy", "bookkeeping_input.vat.closing_transaction_source_id"));
  }
  const configuredVat = new Set([...policy.input_accounts, ...policy.output_accounts]);
  for (const row of transactions) {
    for (const line of row.lines) {
      if (/^(261|262|263|264)\d$/.test(line.account) && !configuredVat.has(line.account)) {
        issues.push(issue("VAT_ACCOUNT_NOT_CONFIGURED", `VAT account ${line.account} is not configured in company policy`, "bookkeeping_input.transactions"));
      }
    }
  }
  const before = combineBalances(openingBalances, movementsFromTransactions(transactions.slice(0, index)));
  let outputVat = 0n;
  let inputVat = 0n;
  for (const account of policy.output_accounts) {
    const net = netBalanceForAccount(before, account);
    if (net > 0n) issues.push(issue("VAT_OUTPUT_ACCOUNT_SIDE_INVALID", `Output VAT account ${account} has a debit balance before closing`, "bookkeeping_input.vat"));
    outputVat += net < 0n ? -net : 0n;
  }
  for (const account of policy.input_accounts) {
    const net = netBalanceForAccount(before, account);
    if (net < 0n) issues.push(issue("VAT_INPUT_ACCOUNT_SIDE_INVALID", `Input VAT account ${account} has a credit balance before closing`, "bookkeeping_input.vat"));
    inputVat += net > 0n ? net : 0n;
  }
  if (outputVat !== (boxes["10"] + boxes["11"] + boxes["12"]) * 100n) {
    issues.push(issue("VAT_OUTPUT_BOXES_MISMATCH", "VAT boxes 10–12 do not match configured output VAT balances", "bookkeeping_input.vat.declaration_boxes"));
  }
  if (inputVat !== boxes["48"] * 100n) {
    issues.push(issue("VAT_INPUT_BOX_MISMATCH", "VAT box 48 does not match configured input VAT balances", "bookkeeping_input.vat.declaration_boxes.48"));
  }
  for (const account of configuredVat) {
    if (netBalanceForAccount(closingBalances, account) !== 0n) {
      issues.push(issue("VAT_ACCOUNT_NOT_CLOSED", `VAT account ${account} is not zero after closing`, "bookkeeping_input.vat.closing_transaction_source_id"));
    }
  }
  const settlementMovement = transaction.lines
    .filter((line) => line.account === policy.settlement_account)
    .reduce((sum, line) => sum + line.credit_ore - line.debit_ore, 0n);
  if (settlementMovement !== boxes["49"] * 100n) {
    issues.push(issue("VAT_SETTLEMENT_MISMATCH", `VAT settlement account ${policy.settlement_account} does not receive box 49`, "bookkeeping_input.vat.closing_transaction_source_id"));
  }
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
