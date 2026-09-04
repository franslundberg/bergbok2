import { cloneJson, deepFreeze } from "../../../../contracts/src/canonical.mjs";
import {
  CONTRACT_VERSION,
  ContractError,
  assertContentRef,
  contentRefKey,
  verifySealedContent,
  parseMoney,
} from "../../../../contracts/src/index.mjs";
import {
  isPlainObject,
  issue,
  normalizeAccount,
  normalizeTransactions,
  validIsoDate,
} from "./ledger.mjs";

export const UPSTREAM_RESULT_SCHEMA_ID = "se.bergbok.upstream-result";
export const PAYROLL_ACCOUNTING_FACTS_SCHEMA_ID = "se.bergbok.bookkeeping.payroll-accounting-facts";
const ALLOWED_TRUST = new Set(["approved_internal", "trusted_external", "sealed_same_aggregate"]);
const EXPENSE_KINDS = new Set(["gross_cash_salary", "employer_contribution"]);
const LIABILITY_KINDS = new Set([
  "withholding_tax_payable",
  "employer_contribution_payable",
  "net_salary_payable",
]);

export function normalizePayrollAccountingFacts(upstreamResult, {
  companyId = null,
  periodId = null,
  expectedGroupDigest = null,
} = {}) {
  verifySealedContent(upstreamResult, "Payroll upstream result");
  if (upstreamResult.ref.schema_id === PAYROLL_ACCOUNTING_FACTS_SCHEMA_ID) {
    throw new ContractError("Bare proposed Payroll accounting facts are not authoritative upstream results");
  }
  if (upstreamResult.ref.schema_id !== UPSTREAM_RESULT_SCHEMA_ID) {
    throw new ContractError(`Payroll upstream result must use schema ${UPSTREAM_RESULT_SCHEMA_ID}`);
  }
  const wrapper = upstreamResult.payload;
  if (!isPlainObject(wrapper) || wrapper.contract_version !== CONTRACT_VERSION) {
    throw new ContractError("Payroll upstream result has an unsupported contract version");
  }
  if (wrapper.status !== "approved" || wrapper.source_domain !== "payroll") {
    throw new ContractError("Payroll upstream result must be an approved Payroll result");
  }
  if (!ALLOWED_TRUST.has(wrapper.trust)) {
    throw new ContractError("Payroll upstream result has no accepted authority classification");
  }
  requireMatch(wrapper.company_id, companyId, "company_id");
  requireMatch(wrapper.period_id, periodId, "period_id");
  assertAuthority(wrapper, expectedGroupDigest);

  const facts = nestedFacts(wrapper);
  verifySealedContent(facts, "Payroll accounting facts");
  if (facts.ref.schema_id !== PAYROLL_ACCOUNTING_FACTS_SCHEMA_ID) {
    throw new ContractError(`Nested Payroll facts must use schema ${PAYROLL_ACCOUNTING_FACTS_SCHEMA_ID}`);
  }
  if (!["1.0", "2.0"].includes(facts.ref.schema_version)) {
    throw new ContractError("Payroll accounting facts must use schema version 1.0 or 2.0");
  }
  const value = facts.payload;
  if (!isPlainObject(value) || value.contract_version !== CONTRACT_VERSION || value.status !== "proposed") {
    throw new ContractError("Payroll accounting facts must be a proposed result");
  }
  if (value.schema_version !== undefined && value.schema_version !== facts.ref.schema_version) {
    throw new ContractError("Payroll accounting facts payload and ContentRef schema versions disagree");
  }
  requireMatch(value.company_id, wrapper.company_id, "nested company_id");
  requireMatch(value.period_id, wrapper.period_id, "nested period_id");
  if (value.currency !== "SEK") throw new ContractError("Payroll accounting facts currency must be SEK");
  assertContentRef(value.source_payroll_result_ref, "Payroll facts source_payroll_result_ref");

  const ids = new Set();
  const expenseFacts = normalizeEconomicFacts(value.expense_facts, "expense", EXPENSE_KINDS, ids, facts.ref.schema_version, value.currency);
  const liabilityFacts = normalizeEconomicFacts(value.liability_facts, "liability", LIABILITY_KINDS, ids, facts.ref.schema_version, value.currency);
  const expenseTotal = total(expenseFacts);
  const liabilityTotal = total(liabilityFacts);
  if (expenseTotal !== liabilityTotal) {
    throw new ContractError("Payroll economic facts do not reconcile");
  }

  return deepFreeze({
    trust: wrapper.trust,
    upstream_ref: cloneJson(upstreamResult.ref),
    facts_ref: cloneJson(facts.ref),
    source_payroll_result_ref: cloneJson(value.source_payroll_result_ref),
    company_id: value.company_id,
    period_id: value.period_id,
    currency: value.currency,
    expense_facts: expenseFacts,
    liability_facts: liabilityFacts,
  });
}

export function mapPayrollFactsToPostings(payrollFacts, postingAssessments) {
  const issues = [];
  const rows = postingAssessments === undefined ? [] : postingAssessments;
  if (!Array.isArray(rows)) {
    return { transactions: [], open_item_changes: [], issues: [issue(
      "PAYROLL_POSTINGS_INVALID",
      "bookkeeping_input.payroll_postings must be an array",
      "bookkeeping_input.payroll_postings",
    )] };
  }
  const factsByKey = new Map(payrollFacts.map((facts) => [contentRefKey(facts.facts_ref), facts]));
  const used = new Set();
  const transactions = [];
  const openItemChanges = [];

  rows.forEach((row, index) => {
    const root = `bookkeeping_input.payroll_postings[${index}]`;
    if (!isPlainObject(row)) {
      issues.push(issue("PAYROLL_POSTING_INVALID", `${root} must be an object`, root));
      return;
    }
    let key;
    try {
      assertContentRef(row.payroll_facts_ref, `${root}.payroll_facts_ref`);
      key = contentRefKey(row.payroll_facts_ref);
    } catch (error) {
      issues.push(issue("PAYROLL_FACTS_REF_INVALID", error.message, `${root}.payroll_facts_ref`));
      return;
    }
    const facts = factsByKey.get(key);
    if (!facts) {
      issues.push(issue("PAYROLL_FACTS_REF_UNKNOWN", `${root} does not reference an upstream PayrollAccountingFacts result`, `${root}.payroll_facts_ref`));
      return;
    }
    if (used.has(key)) {
      issues.push(issue("PAYROLL_POSTING_DUPLICATE", `${root} maps the same PayrollAccountingFacts more than once`, root));
      return;
    }
    used.add(key);
    const allFacts = [
      ...facts.expense_facts.map((fact) => ({ ...fact, side: "debit" })),
      ...facts.liability_facts.map((fact) => ({ ...fact, side: "credit" })),
    ];
    const byId = new Map(allFacts.map((fact) => [fact.fact_id, fact]));
    const assigned = new Set();
    const lines = [];
    if (!Array.isArray(row.assignments)) {
      issues.push(issue("PAYROLL_ASSIGNMENTS_REQUIRED", `${root}.assignments must be an array`, `${root}.assignments`));
      return;
    }
    row.assignments.forEach((assignment, assignmentIndex) => {
      const assignmentRoot = `${root}.assignments[${assignmentIndex}]`;
      if (!isPlainObject(assignment) || typeof assignment.fact_id !== "string") {
        issues.push(issue("PAYROLL_ASSIGNMENT_INVALID", `${assignmentRoot} needs a fact_id and account`, assignmentRoot));
        return;
      }
      const fact = byId.get(assignment.fact_id);
      if (!fact) {
        issues.push(issue("PAYROLL_FACT_UNKNOWN", `${assignmentRoot}.fact_id is not present in the referenced PayrollAccountingFacts`, `${assignmentRoot}.fact_id`));
        return;
      }
      if (assigned.has(fact.fact_id)) {
        issues.push(issue("PAYROLL_FACT_ASSIGNED_TWICE", `${fact.fact_id} is assigned more than once`, assignmentRoot));
        return;
      }
      assigned.add(fact.fact_id);
      const account = normalizeAccount(assignment.account);
      if (!account) {
        issues.push(issue("ACCOUNT_INVALID", `${assignmentRoot}.account must be a four-digit BAS account`, `${assignmentRoot}.account`));
        return;
      }
      const accountName = typeof assignment.account_name === "string" && assignment.account_name.trim()
        ? assignment.account_name.trim()
        : `Account ${account}`;
      lines.push({
        account,
        account_name: accountName,
        debit_ore: fact.side === "debit" ? fact.amount_ore : 0n,
        credit_ore: fact.side === "credit" ? fact.amount_ore : 0n,
      });
    });
    for (const fact of allFacts) {
      if (!assigned.has(fact.fact_id)) issues.push(issue(
        "PAYROLL_FACT_UNASSIGNED",
        `${fact.fact_id} has no Bookkeeping account assignment`,
        `${root}.assignments`,
      ));
    }
    if (!validIsoDate(row.date)) issues.push(issue("PAYROLL_POSTING_DATE_INVALID", `${root}.date must be YYYY-MM-DD`, `${root}.date`));
    const description = typeof row.description === "string" && row.description.trim()
      ? row.description.trim()
      : `Payroll ${facts.period_id}`;
    const normalized = normalizeTransactions([{
      source_id: `payroll:${facts.period_id}:${facts.facts_ref.sha256.slice(0, 12)}`,
      date: row.date,
      description,
      evidence_document_ids: uniqueEvidence(allFacts),
      lines,
    }], {
      label: root,
      origin: "approved_payroll",
      sourcePrefix: `payroll:${facts.period_id}`,
      startingOrder: index,
    });
    issues.push(...normalized.issues);
    transactions.push(...normalized.transactions.map((transaction) => ({
      ...transaction,
      upstream_result_ref: cloneJson(facts.upstream_ref),
      payroll_facts_ref: cloneJson(facts.facts_ref),
    })));
    for (const liability of facts.liability_facts.filter((fact) => fact.kind === "net_salary_payable")) {
      openItemChanges.push({
        action: "open",
        item_id: liability.fact_id,
        kind: "employee_net_salary",
        party: liability.party_name ?? liability.party_ref,
        amount_ore: liability.amount_ore,
        due_date: liability.due_date,
        evidence_document_ids: [...liability.evidence_document_ids],
        origin: "approved_payroll",
        upstream_result_ref: cloneJson(facts.upstream_ref),
        payroll_facts_ref: cloneJson(facts.facts_ref),
      });
    }
  });

  for (const [key, facts] of factsByKey) {
    if (!used.has(key)) issues.push(issue(
      "PAYROLL_POSTING_ASSESSMENT_REQUIRED",
      `Bookkeeping must assess account assignments for PayrollAccountingFacts ${facts.facts_ref.stable_id}`,
      "bookkeeping_input.payroll_postings",
      { facts_ref: cloneJson(facts.facts_ref) },
    ));
  }
  return { transactions, open_item_changes: openItemChanges, issues };
}

export function findPayrollCandidates(upstreamResults) {
  return upstreamResults.filter((item) => {
    if (item.ref.schema_id === PAYROLL_ACCOUNTING_FACTS_SCHEMA_ID) return true;
    if (item.ref.schema_id !== UPSTREAM_RESULT_SCHEMA_ID) return false;
    if (item.payload?.source_domain === "payroll") return true;
    const candidate = nestedFacts(item.payload, false);
    return candidate?.ref?.schema_id === PAYROLL_ACCOUNTING_FACTS_SCHEMA_ID;
  });
}

function normalizeEconomicFacts(rows, category, allowedKinds, ids, schemaVersion, currency) {
  if (!Array.isArray(rows) || rows.length === 0) throw new ContractError(`Payroll ${category}_facts must be a non-empty array`);
  return rows.map((row, index) => {
    const label = `payroll_accounting_facts.${category}_facts[${index}]`;
    if (!isPlainObject(row)) throw new ContractError(`${label} must be an object`);
    requireText(row.fact_id, `${label}.fact_id`);
    if (ids.has(row.fact_id)) throw new ContractError(`${label}.fact_id is duplicated`);
    ids.add(row.fact_id);
    if (!allowedKinds.has(row.kind)) throw new ContractError(`${label}.kind ${row.kind ?? "(missing)"} is unsupported`);
    if (schemaVersion === "2.0" && row.amount_ore !== undefined) throw new ContractError(`${label}.amount_ore is not allowed in schema 2.0`);
    if (schemaVersion === "1.0" && row.amount !== undefined) throw new ContractError(`${label}.amount is not allowed in schema 1.0`);
    let amountOre;
    if (schemaVersion === "2.0") {
      try {
        amountOre = parseMoney(row.amount, { expectedCurrency: currency }).minorUnits;
      } catch (error) {
        throw new ContractError(`${label}.amount must be positive canonical Money: ${error.message}`);
      }
    } else if (Number.isSafeInteger(row.amount_ore)) {
      amountOre = BigInt(row.amount_ore);
    } else {
      throw new ContractError(`${label}.amount_ore must be a safe integer`);
    }
    if (amountOre <= 0n) throw new ContractError(`${label}.amount must be positive`);
    if (!Array.isArray(row.evidence_document_ids)
        || row.evidence_document_ids.some((item) => typeof item !== "string" || !item.trim())) {
      throw new ContractError(`${label}.evidence_document_ids must contain strings`);
    }
    if (category === "expense") requireText(row.employee_id, `${label}.employee_id`);
    if (row.kind === "net_salary_payable") {
      requireText(row.party_ref, `${label}.party_ref`);
      requireText(row.party_name, `${label}.party_name`);
      if (!validIsoDate(row.due_date)) throw new ContractError(`${label}.due_date must be YYYY-MM-DD`);
    } else if (category === "liability") {
      requireText(row.creditor, `${label}.creditor`);
      if (!/^\d{4}-\d{2}$/.test(row.reporting_period ?? "")) throw new ContractError(`${label}.reporting_period must be YYYY-MM`);
    }
    const normalized = cloneJson(row);
    delete normalized.amount;
    normalized.amount_ore = amountOre;
    return normalized;
  });
}

function assertAuthority(wrapper, expectedGroupDigest) {
  const authority = isPlainObject(wrapper.authority) ? wrapper.authority : {};
  if (wrapper.trust === "approved_internal") {
    assertContentRef(wrapper.source_run_ref, "approved_internal source_run_ref");
    const approvalRef = wrapper.approval_receipt_ref ?? authority.approval_receipt_ref ?? authority.approval_ref;
    assertContentRef(approvalRef, "approved_internal approval receipt");
  } else if (wrapper.trust === "trusted_external") {
    const source = wrapper.external_authority ?? authority.external_authority ?? authority.source;
    const validSource = typeof source === "string" && source.trim()
      || isPlainObject(source) && typeof (source.system ?? source.name) === "string" && (source.system ?? source.name).trim();
    if (!validSource) throw new ContractError("trusted_external requires a named external authority");
  } else {
    const digest = wrapper.group_digest ?? authority.group_digest;
    if (!/^[a-f0-9]{64}$/.test(digest ?? "")) throw new ContractError("sealed_same_aggregate requires a lowercase SHA-256 group_digest");
    if (!/^[a-f0-9]{64}$/.test(expectedGroupDigest ?? "")) throw new ContractError("The ConsolidationCase must fix a group_digest for sealed_same_aggregate Payroll facts");
    if (digest !== expectedGroupDigest) throw new ContractError("Payroll upstream group_digest does not match the ConsolidationCase");
  }
}

function nestedFacts(wrapper, required = true) {
  const facts = wrapper?.result ?? wrapper?.payroll_accounting_facts ?? wrapper?.sealed_result ?? wrapper?.output;
  if (!facts && required) throw new ContractError("Payroll upstream result is missing nested sealed facts");
  return facts;
}

function requireMatch(actual, expected, label) {
  if (typeof actual !== "string" || !actual) throw new ContractError(`Payroll upstream ${label} is required`);
  if (expected !== null && actual !== expected) throw new ContractError(`Payroll upstream ${label} does not match the ConsolidationCase`);
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ContractError(`${label} is required`);
}

function total(rows) {
  return rows.reduce((sum, row) => {
    return sum + row.amount_ore;
  }, 0n);
}

function uniqueEvidence(facts) {
  return [...new Set(facts.flatMap((fact) => fact.evidence_document_ids))].sort();
}
