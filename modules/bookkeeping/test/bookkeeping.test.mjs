import assert from "node:assert/strict";
import test from "node:test";

import { consolidate, consolidateOffline } from "../src/index.mjs";
import { normalizePayrollAccountingFacts } from "../src/private/payroll-facts.mjs";
import {
  ContractError,
  assertModuleOutcome,
  createContentRef,
  createStateEnvelope,
  sealContent,
  verifySealedContent,
} from "../../../contracts/src/index.mjs";

const PROFILE = "se-private-ab-invoice-calendar-demo-v1";

function policies(overrides = {}) {
  return {
    core: {
      country: "SE",
      currency: "SEK",
      fiscal_year: { start: "2026-01-01", end: "2026-12-31" },
      accounting_method: "invoice",
      ...(overrides.core ?? {}),
    },
    bookkeeping: {
      profile: PROFILE,
      verification_series: "A",
      ...(overrides.bookkeeping ?? {}),
    },
  };
}

function input(overrides = {}) {
  return {
    schema_id: "se.bergbok.bookkeeping-input",
    schema_version: "2.0",
    company_id: "example-ab",
    period_id: "2026-03",
    mode: "ordinary",
    transactions: [],
    open_item_changes: [],
    reconciliations: [],
    vat: { status: "not_due" },
    ...overrides,
  };
}

function bookkeepingState({ lastNumber = 7, balances = [], openItems = [] } = {}) {
  return {
    contract_version: "1.0",
    status: "approved",
    schema_id: "se.bergbok.bookkeeping.state",
    schema_version: "2.0",
    company_id: "example-ab",
    through_period_id: "2026-02",
    through_date: "2026-02-28",
    currency: "SEK",
    ledger: { balances, verification_series: { series: "A", last_number: lastNumber } },
    open_items: { items: openItems, totals: { count: openItems.length, by_kind: {} } },
    reconciliation: { period_id: "2026-02", accounts: [] },
    vat: { status: "not_due", reporting_period_start: null, reporting_period_end: null, declaration_boxes: null },
  };
}

function makeCase({
  structuredInput = input(),
  previousBookkeeping = bookkeepingState(),
  effectivePolicies = policies(),
  upstreamResults = [],
  period = { id: "2026-03", kind: "ordinary", start: "2026-03-01", end: "2026-03-31" },
  domain = "bookkeeping",
  language,
  groupDigest,
  previousCore = { organization: { name: "Example AB", organization_number: "559999-9999" } },
} = {}) {
  const previous = createStateEnvelope({
    companyId: "example-ab",
    sequence: previousBookkeeping ? 2 : 0,
    core: previousCore,
    domains: previousBookkeeping ? { bookkeeping: previousBookkeeping } : {},
  });
  const docset = sealContent({
    schemaId: "se.bergbok.docset",
    stableId: `example-ab:${period.id}:docset`,
    version: 1,
    payload: {
      documents: [{
        document_id: "structured-bookkeeping.json",
        role: "bookkeeping-input",
        media_type: "application/json",
        content_base64: Buffer.from(JSON.stringify(structuredInput), "utf8").toString("base64"),
      }],
    },
  });
  return sealContent({
    schemaId: "se.bergbok.consolidation-case",
    stableId: `example-ab:${period.id}:${domain}`,
    version: 1,
    payload: {
      contract_version: "1.0",
      company_id: "example-ab",
      domain,
      ...(language ? { language } : {}),
      period,
      docset,
      previous_state: previous,
      effective_policies: effectivePolicies,
      upstream_results: upstreamResults,
      ...(groupDigest ? { group_digest: groupDigest } : {}),
    },
  });
}

function balancedPurchase() {
  return {
    source_id: "purchase-1",
    date: "2026-03-12",
    description: "Materials paid from bank",
    lines: [
      { account: "4000", account_name: "Purchases", debit: "25.00 SEK", credit: "0.00 SEK" },
      { account: "1930", account_name: "Bank", debit: "0.00 SEK", credit: "25.00 SEK" },
    ],
  };
}

test("Start proposes a zero Bookkeeping State from S0", async () => {
  const caseBundle = makeCase({
    previousBookkeeping: null,
    structuredInput: input({
      period_id: "Start",
      mode: "start",
    }),
    period: { id: "Start", kind: "start", end: "2026-03-31" },
  });
  const outcome = await consolidate(caseBundle);
  assertModuleOutcome(outcome, { caseRef: caseBundle.ref, domain: "bookkeeping" });
  assert.equal(outcome.kind, "proposal");
  assert.deepEqual(outcome.canonical_outputs.bookkeeping.ledger.transactions, []);
  assert.equal(outcome.projected_state.ref.schema_id, "se.bergbok.bookkeeping.state");
  assert.equal(outcome.projected_state.ref.schema_version, "2.0");
  assert.equal(outcome.projected_state.payload.schema_version, "2.0");
  assert.equal(outcome.canonical_outputs.bookkeeping.schema_version, "2.0");
  assert.equal(outcome.projected_state.payload.company_id, "example-ab");
  assert.equal(verifySealedContent(outcome.projected_state), true);
  assert.deepEqual(outcome.proposed_changes, [{
    action: "replace_domain_state",
    domain: "bookkeeping",
    state_ref: outcome.projected_state.ref,
  }]);
  assert.deepEqual(outcome.projected_state.payload.ledger.balances, []);
  assert.equal(outcome.projected_state.payload.ledger.verification_series.last_number, 0);
  assert.equal(outcome.projected_state.payload.through_date, "2026-03-31");
});

test("Start rejects transaction-producing data", async () => {
  const caseBundle = makeCase({
    previousBookkeeping: null,
    period: { id: "Start", kind: "start", end: "2026-03-31" },
    structuredInput: input({ period_id: "Start", mode: "start", transactions: [balancedPurchase()] }),
  });
  const outcome = await consolidate(caseBundle);
  assert.equal(outcome.kind, "needs_input");
  assert.ok(outcome.questions.some((question) => question.code === "TRANSACTIONS_NOT_ALLOWED"));
});

test("Import establishes balances, open items, and verification continuity", async () => {
  const caseBundle = makeCase({
    previousBookkeeping: null,
    period: { id: "Import", kind: "import", end: "2026-02-28" },
    structuredInput: input({
      period_id: "Import",
      mode: "import",
      imported_balances: [
        { account: "1930", account_name: "Bank", debit: "100.00 SEK", credit: "0.00 SEK" },
        { account: "2081", account_name: "Share capital", debit: "0.00 SEK", credit: "100.00 SEK" },
      ],
      imported_open_items: [{ item_id: "supplier:1", kind: "supplier_payable", party: "Supplier AB", remaining: "10.00 SEK" }],
      imported_verification_series: { series: "A", last_number: 17 },
    }),
  });
  const outcome = await consolidate(caseBundle);
  assert.equal(outcome.kind, "proposal");
  assert.equal(outcome.projected_state.payload.ledger.verification_series.last_number, 17);
  assert.equal(outcome.projected_state.payload.open_items.items[0].item_id, "supplier:1");
  assert.equal(outcome.canonical_outputs.bookkeeping.ledger.transactions.length, 0);
  assert.ok(outcome.evidence.some((item) => item.document_id === "structured-bookkeeping.json"));

  const ordinary = await consolidate(makeCase({
    previousBookkeeping: structuredClone(outcome.projected_state.payload),
    structuredInput: input({ transactions: [balancedPurchase()] }),
  }));
  assert.equal(ordinary.kind, "proposal");
  assert.equal(ordinary.canonical_outputs.bookkeeping.ledger.transactions[0].verification_id, "A18");
});

test("Import rejects transactions", async () => {
  const outcome = await consolidate(makeCase({
    previousBookkeeping: null,
    period: { id: "Import", kind: "import", end: "2026-02-28" },
    structuredInput: input({
      period_id: "Import",
      mode: "import",
      imported_balances: [],
      imported_open_items: [],
      imported_verification_series: { series: "A", last_number: 0 },
      transactions: [balancedPurchase()],
    }),
  }));
  assert.equal(outcome.kind, "needs_input");
  assert.ok(outcome.questions.some((question) => question.code === "TRANSACTIONS_NOT_ALLOWED"));
});

test("an AI-derived Start candidate proposes core initialization and a Swedish review", () => {
  const structuredInput = input({ period_id: "Start", mode: "start", transactions: [] });
  const caseBundle = makeCase({
    previousBookkeeping: null,
    previousCore: {},
    structuredInput,
    period: { id: "Start", kind: "start", end: "2026-03-31" },
  });
  const outcome = consolidateOffline(caseBundle, { id: "openai-gpt-5.6-luna-high-v2" }, {
    input: structuredInput,
    core: { organization: { name: "Example AB", organization_number: "559999-9999" }, evidence_document_ids: ["structured-bookkeeping.json"] },
    assessment: { questions: [], warnings: [], reasons: [] },
  });
  assert.equal(outcome.kind, "proposal");
  assert.equal(outcome.proposed_changes[0].action, "initialize_core_state");
  assert.equal(outcome.review.language, "sv");
  assert.match(outcome.review.report_markdown, /^# Bokföringsförslag/m);
});

test("an English case produces an English Bookkeeping review without changing accounting output", () => {
  const structuredInput = input({ transactions: [balancedPurchase()] });
  const caseBundle = makeCase({ structuredInput, language: "en" });
  const outcome = consolidateOffline(caseBundle);
  assert.equal(outcome.kind, "proposal");
  assert.equal(outcome.review.language, "en");
  assert.match(outcome.review.report_markdown, /^# Bookkeeping proposal/m);
  assert.equal(outcome.canonical_outputs.bookkeeping.ledger.transactions[0].description, "Materials paid from bank");
});

test("ordinary month continues numbering, balances, open items, reconciliation, and VAT outputs", async () => {
  const opening = [
    { account: "1930", account_name: "Bank", debit: "500.00 SEK", credit: "0.00 SEK" },
    { account: "2081", account_name: "Share capital", debit: "0.00 SEK", credit: "500.00 SEK" },
  ];
  const caseBundle = makeCase({
    previousBookkeeping: bookkeepingState({ lastNumber: 7, balances: opening, openItems: [{
      item_id: "supplier:old",
      kind: "supplier_payable",
      party: "Old Supplier",
      original_amount: "10.00 SEK",
      remaining: "10.00 SEK",
      due_date: "2026-03-15",
      evidence_document_ids: [],
    }] }),
    effectivePolicies: policies({ bookkeeping: { vat_reporting: { frequency: "quarterly", period_end: "2026-03-31" } } }),
    structuredInput: input({
      transactions: [balancedPurchase()],
      open_item_changes: [{ action: "settle", item_id: "supplier:old", amount: "10.00 SEK" }],
      reconciliations: [{ account: "1930", external_closing_balance: "475.00 SEK", evidence_document_ids: ["structured-bookkeeping.json"] }],
      vat: {
        status: "due",
        reporting_period_start: "2026-01-01",
        reporting_period_end: "2026-03-31",
        declaration_boxes: { "10": "25.00 SEK", "11": "0.00 SEK", "12": "0.00 SEK", "48": "5.00 SEK", "49": "20.00 SEK" },
      },
    }),
  });
  const outcome = await consolidate(caseBundle, "fixture-variant");
  assert.equal(outcome.kind, "proposal");
  const output = outcome.canonical_outputs.bookkeeping;
  assert.equal(output.ledger.transactions[0].verification_id, "A8");
  assert.equal(output.ledger.verification_series.last_number, 8);
  assert.equal(output.open_items.closing.length, 0);
  assert.equal(output.reconciliations[0].status, "reconciled");
  assert.equal(output.vat_period.declaration_boxes["49"], "20.00 SEK");
  assert.equal(outcome.provenance.variant_ref.id, "fixture-variant");
});

test("an arbitrary ordinary interval continues from Import by date", async () => {
  const previous = bookkeepingState({ balances: [
    { account: "1930", account_name: "Bank", debit: "100.00 SEK", credit: "0.00 SEK" },
    { account: "2081", account_name: "Share capital", debit: "0.00 SEK", credit: "100.00 SEK" },
  ] });
  previous.through_period_id = "Import";
  previous.through_date = "2026-05-31";
  const caseBundle = makeCase({
    previousBookkeeping: previous,
    period: { id: "week-23", kind: "ordinary", start: "2026-06-01", end: "2026-06-07" },
    structuredInput: input({ period_id: "week-23" }),
  });
  const outcome = await consolidate(caseBundle);
  assert.equal(outcome.kind, "proposal");
  assert.equal(outcome.projected_state.payload.through_date, "2026-06-07");
});

test("legacy v1 integer-ore input and state are read but new output is v2 Money", async () => {
  const legacyState = bookkeepingState({ balances: [] });
  legacyState.schema_version = "1.0";
  legacyState.open_items.totals = { count: 0, by_kind_ore: {} };
  legacyState.vat.declaration_boxes_sek = null;
  delete legacyState.vat.declaration_boxes;
  const sealedLegacyState = sealContent({
    schemaId: "se.bergbok.bookkeeping.state",
    schemaVersion: "1.0",
    stableId: "example-ab:legacy-bookkeeping-state",
    version: 2,
    payload: legacyState,
  });
  const originalLegacyRef = structuredClone(sealedLegacyState.ref);
  const legacyInput = input({
    schema_version: "1.0",
    transactions: [{
      source_id: "legacy",
      date: "2026-03-12",
      description: "Legacy amount",
      lines: [
        { account: "4000", debit_ore: 2_500, credit_ore: 0 },
        { account: "1930", debit_ore: 0, credit_ore: 2_500 },
      ],
    }],
  });
  const outcome = await consolidate(makeCase({ structuredInput: legacyInput, previousBookkeeping: sealedLegacyState }));
  assert.equal(outcome.kind, "proposal");
  assert.equal(outcome.projected_state.ref.schema_version, "2.0");
  assert.equal(outcome.projected_state.payload.schema_version, "2.0");
  assert.equal(outcome.canonical_outputs.bookkeeping.ledger.transactions[0].lines[0].debit, "25.00 SEK");
  assert.deepEqual(sealedLegacyState.ref, originalLegacyRef);
});

test("a tampered sealed v1 Bookkeeping state is rejected before adaptation", async () => {
  const sealed = sealContent({
    schemaId: "se.bergbok.bookkeeping.state",
    schemaVersion: "1.0",
    stableId: "example-ab:tampered-v1-state",
    version: 1,
    payload: { ...bookkeepingState({ balances: [] }), schema_version: "1.0" },
  });
  const tampered = structuredClone(sealed);
  tampered.payload.through_date = "2026-01-01";
  const outcome = await consolidate(makeCase({ previousBookkeeping: tampered }));
  assert.equal(outcome.kind, "needs_input");
  assert.ok(outcome.questions.some((question) => question.code === "PREVIOUS_BOOKKEEPING_MONEY_INVALID"));
});

test("Bookkeeping rejects a sealed state whose payload and ContentRef schema versions disagree", async () => {
  const mismatch = sealContent({
    schemaId: "se.bergbok.bookkeeping.state",
    schemaVersion: "2.0",
    stableId: "example-ab:mismatched-state",
    version: 1,
    payload: { ...bookkeepingState({ balances: [] }), schema_version: "1.0" },
  });
  const outcome = await consolidate(makeCase({ previousBookkeeping: mismatch }));
  assert.equal(outcome.kind, "needs_input");
  assert.ok(outcome.questions.some((question) => question.code === "PREVIOUS_BOOKKEEPING_MONEY_INVALID"));
});

test("an imbalanced transaction returns NeedsInput and no proposed changes", async () => {
  const bad = balancedPurchase();
  bad.lines[1].credit = "24.00 SEK";
  const caseBundle = makeCase({ language: "en", structuredInput: input({ transactions: [bad] }) });
  const outcome = await consolidate(caseBundle);
  assert.equal(outcome.kind, "needs_input");
  assert.equal(outcome.review.language, "en");
  assert.match(outcome.review.report_markdown, /^# Bookkeeping needs input/m);
  assert.equal(outcome.proposed_changes.length, 0);
  assert.equal(outcome.projected_state, null);
  assert.ok(outcome.questions.some((question) => question.code === "TRANSACTION_IMBALANCE"));
});

test("Bookkeeping rejects wrong-currency and mixed-version Money fields", async () => {
  const wrongCurrency = balancedPurchase();
  wrongCurrency.lines[0].debit = "25.00 USD";
  const wrongCurrencyOutcome = await consolidate(makeCase({ structuredInput: input({ transactions: [wrongCurrency] }) }));
  assert.equal(wrongCurrencyOutcome.kind, "needs_input");
  assert.ok(wrongCurrencyOutcome.questions.some((question) => question.code === "BOOKKEEPING_MONEY_INVALID"));

  const mixed = balancedPurchase();
  mixed.lines[0].debit_ore = 2_500;
  const mixedOutcome = await consolidate(makeCase({ structuredInput: input({ transactions: [mixed] }) }));
  assert.equal(mixedOutcome.kind, "needs_input");
  assert.ok(mixedOutcome.questions.some((question) => question.code === "BOOKKEEPING_MONEY_INVALID"));
});

test("an unsupported effective policy returns OutOfScope", async () => {
  const caseBundle = makeCase({ language: "en", effectivePolicies: policies({ bookkeeping: { profile: "all-swedish-businesses-v9" } }) });
  const outcome = await consolidate(caseBundle);
  assert.equal(outcome.kind, "out_of_scope");
  assert.equal(outcome.review.language, "en");
  assert.match(outcome.review.report_markdown, /^# Bookkeeping out of scope/m);
  assert.ok(outcome.reasons.some((reason) => reason.code === "UNSUPPORTED_PROFILE"));
});

test("wrong domain returns OutOfScope without invoking accounting mechanics", async () => {
  const caseBundle = makeCase({ domain: "payroll" });
  const outcome = await consolidate(caseBundle);
  assert.equal(outcome.kind, "out_of_scope");
  assert.equal(outcome.reasons[0].code, "WRONG_DOMAIN");
});

function ref(schemaId, stableId) {
  return createContentRef({ schemaId, stableId, version: 1, payload: { marker: stableId } });
}

function payrollFacts() {
  return sealContent({
    schemaId: "se.bergbok.bookkeeping.payroll-accounting-facts",
    schemaVersion: "2.0",
    stableId: "example-ab:2026-03:payroll-facts",
    version: 1,
    payload: {
      contract_version: "1.0",
      schema_version: "2.0",
      company_id: "example-ab",
      period_id: "2026-03",
      status: "proposed",
      currency: "SEK",
      source_payroll_result_ref: ref("se.bergbok.payroll-result", "payroll-run-1"),
      expense_facts: [{
        fact_id: "payroll:2026-03:e1:gross-cash-salary",
        kind: "gross_cash_salary",
        employee_id: "e1",
        amount: "300.00 SEK",
        evidence_document_ids: ["payroll-input-e1"],
      }],
      liability_facts: [
        {
          fact_id: "payroll:2026-03:e1:withholding-tax-payable",
          kind: "withholding_tax_payable",
          creditor: "skatteverket",
          reporting_period: "2026-03",
          amount: "90.00 SEK",
          evidence_document_ids: ["payroll-input-e1"],
        },
        {
          fact_id: "payroll:2026-03:e1:net-pay",
          kind: "net_salary_payable",
          party_ref: "e1",
          party_name: "Ada Example",
          due_date: "2026-03-25",
          amount: "210.00 SEK",
          evidence_document_ids: ["payroll-input-e1"],
        },
      ],
    },
  });
}

function payrollPosting(facts, salaryAccount = "7010") {
  return {
    payroll_facts_ref: facts.ref,
    date: "2026-03-25",
    description: "March salary",
    assignments: [
      { fact_id: "payroll:2026-03:e1:gross-cash-salary", account: salaryAccount, account_name: "Salary" },
      { fact_id: "payroll:2026-03:e1:withholding-tax-payable", account: "2710", account_name: "Employee tax" },
      { fact_id: "payroll:2026-03:e1:net-pay", account: "2910", account_name: "Salary payable" },
    ],
  };
}

function approvedPayrollWrapper(facts = payrollFacts(), overrides = {}) {
  return sealContent({
    schemaId: "se.bergbok.upstream-result",
    stableId: "example-ab:2026-03:payroll-accounting-facts",
    version: 1,
    payload: {
      contract_version: "1.0",
      status: "approved",
      trust: "approved_internal",
      company_id: "example-ab",
      period_id: "2026-03",
      source_domain: "payroll",
      source_run_ref: ref("se.bergbok.run", "payroll-run-1"),
      approval_receipt_ref: ref("se.bergbok.approval-receipt", "payroll-approval-1"),
      output: facts,
      ...overrides,
    },
  });
}

test("approved sealed Payroll facts are normalized and included", async () => {
  const facts = payrollFacts();
  const wrapper = approvedPayrollWrapper(facts);
  const normalized = normalizePayrollAccountingFacts(wrapper, { companyId: "example-ab", periodId: "2026-03" });
  assert.equal(normalized.expense_facts.length, 1);
  assert.equal(normalized.liability_facts.length, 2);
  const caseBundle = makeCase({
    upstreamResults: [wrapper],
    structuredInput: input({ payroll_postings: [payrollPosting(facts)] }),
  });
  const outcome = await consolidate(caseBundle);
  assert.equal(outcome.kind, "proposal");
  assert.equal(outcome.canonical_outputs.bookkeeping.ledger.transactions[0].description, "March salary");
  assert.equal(outcome.canonical_outputs.bookkeeping.open_items.closing[0].remaining, "210.00 SEK");
  assert.equal(outcome.evidence[1].trust, "approved_internal");
});

test("Bookkeeping requires an assessed account mapping and may select a different salary account", async () => {
  const facts = payrollFacts();
  const wrapper = approvedPayrollWrapper(facts);
  const missing = await consolidate(makeCase({ upstreamResults: [wrapper] }));
  assert.equal(missing.kind, "needs_input");
  assert.ok(missing.questions.some((question) => question.code === "PAYROLL_POSTING_ASSESSMENT_REQUIRED"));

  const mapped = await consolidate(makeCase({
    upstreamResults: [wrapper],
    structuredInput: input({ payroll_postings: [payrollPosting(facts, "7210")] }),
  }));
  assert.equal(mapped.kind, "proposal");
  assert.equal(mapped.canonical_outputs.bookkeeping.ledger.transactions[0].lines[0].account, "7210");
  assert.equal(mapped.canonical_outputs.bookkeeping.ledger.transactions[0].lines[0].debit, "300.00 SEK");
});

test("bare proposed Payroll facts and missing authority are rejected", async () => {
  const facts = payrollFacts();
  assert.throws(() => normalizePayrollAccountingFacts(facts), ContractError);
  const bareOutcome = await consolidate(makeCase({ upstreamResults: [facts] }));
  assert.equal(bareOutcome.kind, "needs_input");
  assert.ok(bareOutcome.questions.some((question) => question.code === "PAYROLL_UPSTREAM_REJECTED"));

  const untrusted = approvedPayrollWrapper(payrollFacts(), { approval_receipt_ref: null });
  const untrustedOutcome = await consolidate(makeCase({ upstreamResults: [untrusted] }));
  assert.equal(untrustedOutcome.kind, "needs_input");
  assert.ok(untrustedOutcome.questions.some((question) => question.prompt.includes("approval receipt")));
});

test("sealed-same-aggregate Payroll facts require the exact case group digest", () => {
  const digest = "a".repeat(64);
  const wrapper = approvedPayrollWrapper(payrollFacts(), {
    trust: "sealed_same_aggregate",
    approval_receipt_ref: null,
    group_digest: digest,
  });
  assert.equal(normalizePayrollAccountingFacts(wrapper, {
    companyId: "example-ab",
    periodId: "2026-03",
    expectedGroupDigest: digest,
  }).trust, "sealed_same_aggregate");
  assert.throws(() => normalizePayrollAccountingFacts(wrapper, {
    companyId: "example-ab",
    periodId: "2026-03",
    expectedGroupDigest: "b".repeat(64),
  }), /group_digest does not match/);
});
