import assert from "node:assert/strict";
import test from "node:test";

import { consolidate, consolidateOffline } from "../src/index.mjs";
import { normalizePayrollAccountingFacts } from "../src/private/payroll-facts.mjs";
import { assertBookkeepingReview, proposalReview } from "../src/private/review.mjs";
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
      chart_of_accounts: "BAS",
      vat_reporting: {
        frequency: "quarterly",
        chart: "BAS-2026",
        box_overrides: [],
        settlement_account: "2650",
      },
      open_items: {
        supplier_payable: { accounts: ["2440"], side: "credit" },
        customer_receivable: { accounts: ["1510"], side: "debit" },
        related_party_payable: { accounts: ["2893"], side: "credit" },
        other_current_payable: { accounts: ["2890"], side: "credit" },
        other_current_receivable: { accounts: ["1680"], side: "debit" },
      },
      ...(overrides.bookkeeping ?? {}),
    },
  };
}

function input(overrides = {}) {
  return {
    schema_id: "se.bergbok.bookkeeping-input",
    schema_version: "3.0",
    company_id: "example-ab",
    period_id: "2026-05",
    mode: "ordinary",
    transactions: [],
    open_item_changes: [],
    reconciliations: [],
    ...overrides,
  };
}

function bookkeepingState({ lastNumber = 7, balances = [], openItems = [] } = {}) {
  return {
    contract_version: "1.0",
    status: "approved",
    schema_id: "se.bergbok.bookkeeping.state",
    schema_version: "3.0",
    company_id: "example-ab",
    through_period_id: "2026-04",
    through_date: "2026-04-30",
    currency: "SEK",
    ledger: { balances, verification_series: { series: "A", last_number: lastNumber } },
    open_items: { items: openItems, totals: { count: openItems.length, by_kind: {} } },
    reconciliation: { period_id: "2026-04", accounts: [] },
    vat: {
      frequency: "quarterly",
      cycle_start: "2026-04-01",
      cycle_end: "2026-06-30",
      due_in_period: false,
      chart: "BAS-2026",
      input_accounts: [],
      output_accounts: [],
      settlement_account: "2650",
      status: "not_due",
      closing_transaction_source_id: null,
      declaration_boxes: {},
    },
  };
}

function makeCase({
  structuredInput = input(),
  previousBookkeeping = bookkeepingState(),
  effectivePolicies = policies(),
  upstreamResults = [],
  period = { id: "2026-05", kind: "ordinary", start: "2026-05-01", end: "2026-05-31" },
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
    date: "2026-05-12",
    description: "Materials paid from bank",
    lines: [
      { account: "4000", account_name: "Purchases", debit: "25.00 SEK", credit: "0.00 SEK" },
      { account: "1930", account_name: "Bank", debit: "0.00 SEK", credit: "25.00 SEK" },
    ],
  };
}

// Balances chosen so the kernel deterministically constructs a closing
// transaction and declaration boxes equal to what earlier, candidate-authored
// fixtures used to hand-supply: box 10 = 25.00 SEK, box 48 = 5.00 SEK, box 49
// = 20.00 SEK, settled to account 2650.
function dueVatFixture() {
  const previous = bookkeepingState({ balances: [
    { account: "1930", account_name: "Bank", debit: "100.00 SEK", credit: "0.00 SEK" },
    { account: "2081", account_name: "Share capital", debit: "0.00 SEK", credit: "80.00 SEK" },
    { account: "2611", account_name: "Output VAT", debit: "0.00 SEK", credit: "25.00 SEK" },
    { account: "2641", account_name: "Input VAT", debit: "5.00 SEK", credit: "0.00 SEK" },
  ] });
  previous.through_period_id = "2026-02";
  previous.through_date = "2026-02-28";
  previous.reconciliation.period_id = "2026-02";
  previous.vat.cycle_start = "2026-01-01";
  previous.vat.cycle_end = "2026-03-31";
  return { previous };
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
  assert.equal(outcome.projected_state.ref.schema_version, "3.0");
  assert.equal(outcome.projected_state.payload.schema_version, "3.0");
  assert.equal(outcome.canonical_outputs.bookkeeping.schema_version, "3.0");
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
    period: { id: "Import", kind: "import", end: "2026-04-30" },
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
    period: { id: "Import", kind: "import", end: "2026-04-30" },
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
  const outcome = consolidateOffline(caseBundle, { id: "openai-gpt-5.6-luna-high-v3" }, {
    input: structuredInput,
    core: {
      organization: { name: "Example AB", organization_number: "559999-9999" },
      policies: {
        bookkeeping: {
          chart_of_accounts: "BAS",
          vat_reporting: {
            frequency: "quarterly",
            chart: "BAS-2026",
            box_overrides: [],
            settlement_account: "2650",
          },
        },
      },
      evidence_document_ids: ["structured-bookkeeping.json"],
    },
    assessment: {
      questions: [], warnings: [], reasons: [],
      review: { summary: "Startperioden etablerar bolaget utan transaktioner.", transaction_summaries: [] },
    },
  });
  assert.equal(outcome.kind, "proposal");
  assert.equal(outcome.proposed_changes[0].action, "initialize_core_state");
  assert.equal(outcome.review.language, "sv");
  assert.equal(outcome.review.schema_version, "1.0");
  assert.equal(outcome.review.narrative_source, "ai");
  assert.equal(outcome.proposed_changes[0].core.policies.bookkeeping.vat_reporting.frequency, "quarterly");
  assert.deepEqual(outcome.canonical_outputs.period_delta.transactions, []);
  assert.ok(!Object.hasOwn(outcome.review, "report_markdown"));
});

test("an English case produces an English Bookkeeping review without changing accounting output", () => {
  const structuredInput = input({ transactions: [balancedPurchase()] });
  const caseBundle = makeCase({ structuredInput, language: "en" });
  const outcome = consolidateOffline(caseBundle);
  assert.equal(outcome.kind, "proposal");
  assert.equal(outcome.review.language, "en");
  assert.match(outcome.review.summary, /The bookkeeping for 2026-05 contains 1 verification/);
  assert.equal(outcome.canonical_outputs.bookkeeping.ledger.transactions[0].description, "Materials paid from bank");
  assert.equal(outcome.canonical_outputs.bookkeeping.vat_period.frequency, "quarterly");
  assert.equal(outcome.canonical_outputs.bookkeeping.vat_period.cycle_start, "2026-04-01");
  assert.equal(outcome.canonical_outputs.bookkeeping.vat_period.cycle_end, "2026-06-30");
  assert.equal(outcome.canonical_outputs.bookkeeping.vat_period.due_in_period, false);
});

test("Bookkeeping review requires exact single-line transaction-summary coverage", () => {
  const transactions = [{ source_id: "T1" }, { source_id: "T2" }];
  const review = {
    schema_version: "1.0",
    language: "sv",
    narrative_source: "ai",
    summary: "Två transaktioner föreslås.",
    transaction_summaries: [
      { source_id: "T1", summary: "Filippa betalade 25 000 kr. Beloppet bokförs på företagskontot mot konto 2081." },
      { source_id: "T2", summary: "Andra transaktionen." },
    ],
  };
  assert.equal(assertBookkeepingReview(review, transactions), true);
  assert.throws(
    () => assertBookkeepingReview({ ...review, transaction_summaries: review.transaction_summaries.slice(0, 1) }, transactions),
    /Missing transaction summary for T2/,
  );
  assert.throws(
    () => assertBookkeepingReview({ ...review, transaction_summaries: [...review.transaction_summaries, review.transaction_summaries[0]] }, transactions),
    /Duplicate transaction summary for T1/,
  );
  assert.throws(
    () => assertBookkeepingReview({ ...review, transaction_summaries: [{ source_id: "unknown", summary: "Okänd." }] }, transactions),
    /Unknown transaction summary source_id unknown/,
  );
  assert.throws(
    () => assertBookkeepingReview({ ...review, transaction_summaries: [{ source_id: "T1", summary: "Två\nrader." }, review.transaction_summaries[1]] }, transactions),
    /must be one line/,
  );
});

// An unpaid supplier invoice: 4000 against 2440, with a matching open item.
function unpaidPurchase() {
  return {
    source_id: "invoice-130989",
    date: "2026-05-12",
    description: "Leverantörsfaktura 130989",
    lines: [
      { account: "4000", account_name: "Inköp", debit: "9295.00 SEK", credit: "0.00 SEK" },
      { account: "2440", account_name: "Leverantörsskulder", debit: "0.00 SEK", credit: "9295.00 SEK" },
    ],
  };
}

function openSupplierItem() {
  return {
    action: "open",
    item_id: "supplier:130989",
    date: "2026-05-12",
    transaction_source_id: "invoice-130989",
    kind: "supplier_payable",
    party: "Leverantör AB",
    amount: "9295.00 SEK",
    due_date: "2026-06-11",
    evidence_document_ids: [],
  };
}

test("an open item that agrees with its mapped account raises no balance warning", async () => {
  const outcome = await consolidate(makeCase({
    structuredInput: input({ transactions: [unpaidPurchase()], open_item_changes: [openSupplierItem()] }),
  }));
  assert.equal(outcome.kind, "proposal");
  const items = outcome.canonical_outputs.bookkeeping.open_items;
  assert.equal(items.closing.length, 1);
  assert.deepEqual(items.totals, { count: 1, by_kind: { supplier_payable: "9295.00 SEK" } });
  // The change carries the day it happened; the item carries the day it arose, so a later
  // period can still report how long it has been outstanding.
  assert.equal(items.changes[0].date, "2026-05-12");
  assert.equal(items.closing[0].opened_date, "2026-05-12");
  // transaction_source_id names the transaction that books the debt; the kernel resolves
  // it to that transaction's permanent verification id, so the report can say "Se A1".
  assert.equal(items.changes[0].verification_id, "A8");
  assert.equal(items.closing[0].opened_verification_id, "A8");
  assert.deepEqual(outcome.warnings.filter((w) => w.code === "OPEN_ITEM_BALANCE_MISMATCH"), []);
});

test("an open item naming an unknown transaction is rejected rather than silently dropped", async () => {
  const outcome = await consolidate(makeCase({
    structuredInput: input({
      transactions: [unpaidPurchase()],
      open_item_changes: [{ ...openSupplierItem(), transaction_source_id: "does-not-exist" }],
    }),
  }));
  assert.equal(outcome.kind, "needs_input");
  assert.ok(outcome.questions.some((question) => question.code === "OPEN_ITEM_TRANSACTION_NOT_FOUND"));
});

test("an open item that disagrees with its mapped account warns without blocking the period", async () => {
  // The debt is booked but no item records it: today's silent failure, now visible.
  const outcome = await consolidate(makeCase({
    structuredInput: input({ transactions: [unpaidPurchase()] }),
  }));
  assert.equal(outcome.kind, "proposal", "a balance disagreement must never discard the bookkeeping");
  const warning = outcome.warnings.find((item) => item.code === "OPEN_ITEM_BALANCE_MISMATCH");
  assert.ok(warning, "missing OPEN_ITEM_BALANCE_MISMATCH");
  assert.match(warning.message, /supplier_payable uppgår till 0,00 kr medan konto 2440 visar 9 ?295,00 kr\./);
});

test("a point-of-sale purchase books straight to the payment account with no open item", async () => {
  // Paid at the till by card: no obligation ever stood, so no payable and no item. Both
  // sides of the balance check are zero, which agrees.
  const outcome = await consolidate(makeCase({
    structuredInput: input({
      transactions: [{
        source_id: "clas-ohlson-2026-08-11",
        date: "2026-05-11",
        description: "8 st SmartStore Home",
        lines: [
          { account: "5460", account_name: "Förbrukningsmaterial", debit: "511.49 SEK", credit: "0.00 SEK" },
          { account: "2641", account_name: "Debiterad ingående moms", debit: "127.87 SEK", credit: "0.00 SEK" },
          { account: "1930", account_name: "Företagskonto", debit: "0.00 SEK", credit: "639.36 SEK" },
        ],
      }],
    }),
  }));
  assert.equal(outcome.kind, "proposal");
  assert.deepEqual(outcome.canonical_outputs.bookkeeping.open_items.closing, []);
  assert.deepEqual(outcome.warnings.filter((w) => w.code === "OPEN_ITEM_BALANCE_MISMATCH"), []);
});

test("related-party debt is pinned to 2893 and drifting to 2890 is caught", async () => {
  const outlay = (account) => ({
    structuredInput: input({
      transactions: [{
        source_id: "outlay-2026-05-03",
        date: "2026-05-03",
        description: "Privat betalt inköp",
        lines: [
          { account: "4010", account_name: "Inköp material", debit: "615.71 SEK", credit: "0.00 SEK" },
          { account, account_name: "Skuld", debit: "0.00 SEK", credit: "615.71 SEK" },
        ],
      }],
      open_item_changes: [{
        action: "open",
        item_id: "related_party:Filippa Stark:2026-05-03",
        kind: "related_party_payable",
        party: "Filippa Stark",
        amount: "615.71 SEK",
        evidence_document_ids: [],
      }],
    }),
  });
  const pinned = await consolidate(makeCase(outlay("2893")));
  assert.equal(pinned.kind, "proposal");
  assert.deepEqual(pinned.warnings.filter((w) => w.code === "OPEN_ITEM_BALANCE_MISMATCH"), []);

  const drifted = await consolidate(makeCase(outlay("2890")));
  assert.equal(drifted.kind, "proposal");
  const warnings = drifted.warnings.filter((w) => w.code === "OPEN_ITEM_BALANCE_MISMATCH");
  assert.equal(warnings.length, 2, "both the empty 2893 and the unclaimed 2890 must be reported");
  assert.ok(warnings.some((w) => /related_party_payable/.test(w.message)));
  assert.ok(warnings.some((w) => /other_current_payable/.test(w.message)));
});

test("an open item carries forward and is settled by item_id in a later period", async () => {
  const opened = await consolidate(makeCase({
    structuredInput: input({ transactions: [unpaidPurchase()], open_item_changes: [openSupplierItem()] }),
  }));
  const carried = opened.projected_state.payload.open_items.items;
  assert.equal(carried[0].item_id, "supplier:130989");
  assert.equal(carried[0].opened_date, "2026-05-12", "the opened date must survive into the next period");
  assert.equal(carried[0].opened_verification_id, "A8", "the opening verification must survive into the next period");
  const settled = await consolidate(makeCase({
    period: { id: "2026-06", kind: "ordinary", start: "2026-06-01", end: "2026-06-30" },
    previousBookkeeping: {
      ...bookkeepingState({
        balances: [
          { account: "1930", account_name: "Företagskonto", debit: "9295.00 SEK", credit: "0.00 SEK" },
          { account: "2440", account_name: "Leverantörsskulder", debit: "0.00 SEK", credit: "9295.00 SEK" },
        ],
        openItems: carried,
      }),
      through_period_id: "2026-05",
      through_date: "2026-05-31",
    },
    structuredInput: input({
      period_id: "2026-06",
      transactions: [{
        source_id: "payment-130989",
        date: "2026-06-05",
        description: "Betalning av faktura 130989",
        lines: [
          { account: "2440", account_name: "Leverantörsskulder", debit: "9295.00 SEK", credit: "0.00 SEK" },
          { account: "1930", account_name: "Företagskonto", debit: "0.00 SEK", credit: "9295.00 SEK" },
        ],
      }],
      open_item_changes: [{ action: "settle", item_id: "supplier:130989", date: "2026-06-05", transaction_source_id: "payment-130989", amount: "9295.00 SEK", evidence_document_ids: [] }],
    }),
  }));
  assert.equal(settled.kind, "proposal", JSON.stringify(settled.questions ?? settled.reasons));
  assert.deepEqual(settled.canonical_outputs.bookkeeping.open_items.closing, []);
  assert.equal(settled.canonical_outputs.bookkeeping.open_items.changes[0].date, "2026-06-05");
  // Resolved from this period's own transaction, independent of the item's opened_verification_id.
  assert.equal(settled.canonical_outputs.bookkeeping.open_items.changes[0].verification_id, "A8");
  assert.deepEqual(settled.warnings.filter((w) => w.code === "OPEN_ITEM_BALANCE_MISMATCH"), []);
});

test("the open-item balance check is skipped without a mapping and rejects a malformed one", async () => {
  const withoutMapping = policies();
  delete withoutMapping.bookkeeping.open_items;
  const unmapped = await consolidate(makeCase({
    structuredInput: input({ transactions: [unpaidPurchase()] }),
    effectivePolicies: withoutMapping,
  }));
  assert.equal(unmapped.kind, "proposal");
  assert.deepEqual(unmapped.warnings.filter((w) => w.code === "OPEN_ITEM_BALANCE_MISMATCH"), []);
  const malformed = await consolidate(makeCase({
    effectivePolicies: policies({ bookkeeping: { open_items: { supplier_payable: { accounts: ["244"], side: "credit" } } } }),
  }));
  assert.equal(malformed.kind, "out_of_scope");
  assert.ok(malformed.reasons.some((reason) => reason.code === "INVALID_OPEN_ITEM_ACCOUNT_POLICY"));
});

test("deterministic summaries describe the period's bookkeeping in one status-neutral register", async () => {
  // The summary is frozen at proposal time and reused by the approved report, so no
  // outcome kind may describe the workflow state it happened to be in when written.
  const statusWords = /förslag|proposal|granskning|review|godkän|approved/i;
  const proposal = await consolidate(makeCase({ structuredInput: input({ transactions: [balancedPurchase()] }) }));
  const needsInput = await consolidate(makeCase({
    structuredInput: input({ transactions: [{ ...balancedPurchase(), lines: [
      { account: "4010", account_name: "Varuinköp", debit: "125.00 SEK", credit: "0.00 SEK" },
      { account: "1930", account_name: "Företagskonto", debit: "0.00 SEK", credit: "24.00 SEK" },
    ] }] }),
  }));
  const outOfScope = await consolidate(makeCase({
    effectivePolicies: policies({ bookkeeping: { profile: "all-swedish-businesses-v9" } }),
  }));
  assert.deepEqual(
    [proposal.kind, needsInput.kind, outOfScope.kind],
    ["proposal", "needs_input", "out_of_scope"],
  );
  for (const outcome of [proposal, needsInput, outOfScope]) {
    const summary = outcome.review.summary;
    // Well above the one-line summaries this replaced (47-72 characters), while leaving
    // room for a quiet period that carries no reconciliation or open-item clause.
    assert.ok(summary.length >= 150, `${outcome.kind} summary is too short: ${summary.length}`);
    assert.match(summary, /^Bokföringen för 2026-05 /, outcome.kind);
    assert.doesNotMatch(summary, statusWords, outcome.kind);
  }
  assert.match(proposal.review.summary, /omfattar 1 verifikation \(A8\) om totalt 25,00 kr\./);
  assert.match(proposal.review.summary, /Inga öppna poster återstår vid periodens slut\./);
  assert.match(proposal.review.summary, /Perioden ingår i momsperioden 2026-04-01–2026-06-30/);
});

test("deterministic review summaries combine the event and account treatment within the limit", () => {
  const description = `  En lång\n beskrivning ${"x".repeat(300)}  `;
  const review = proposalReview({
    caseBundle: makeCase(),
    output: { ledger: { transactions: [{
      source_id: "T1",
      description,
      lines: [
        { account: "4010", account_name: "Varuinköp", debit: "125.00 SEK", credit: "0.00 SEK" },
        { account: "1930", account_name: "Företagskonto", debit: "0.00 SEK", credit: "125.00 SEK" },
      ],
    }] } },
  });
  assert.equal(review.narrative_source, "deterministic");
  assert.equal(review.transaction_summaries[0].summary.length, 240);
  assert.doesNotMatch(review.transaction_summaries[0].summary, /\n/);
  assert.match(review.transaction_summaries[0].summary, /^En lång beskrivning/);
  assert.match(review.transaction_summaries[0].summary, /Bokförs med 125,00 kr i debet på 4010 mot kredit på 1930\.$/);
});

test("deterministic review summaries name debit and credit treatment in the selected language", () => {
  const transaction = {
    source_id: "T1",
    description: "Material paid from bank",
    lines: [
      { account: "4010", account_name: "Materials", debit: "125.00 SEK", credit: "0.00 SEK" },
      { account: "1930", account_name: "Bank", debit: "0.00 SEK", credit: "125.00 SEK" },
    ],
  };
  const review = proposalReview({
    caseBundle: makeCase({ language: "en" }),
    output: { ledger: { transactions: [transaction] } },
  });
  assert.equal(
    review.transaction_summaries[0].summary,
    "Material paid from bank. Booked as a debit to Materials (4010), SEK 125.00 against a credit to Bank (1930), SEK 125.00.",
  );
});

test("ordinary month continues numbering, balances, open items, reconciliation, and VAT outputs", async () => {
  const opening = [
    { account: "1930", account_name: "Bank", debit: "520.00 SEK", credit: "0.00 SEK" },
    { account: "2081", account_name: "Share capital", debit: "0.00 SEK", credit: "500.00 SEK" },
    { account: "2611", account_name: "Output VAT", debit: "0.00 SEK", credit: "25.00 SEK" },
    { account: "2641", account_name: "Input VAT", debit: "5.00 SEK", credit: "0.00 SEK" },
  ];
  const previous = bookkeepingState({ lastNumber: 7, balances: opening, openItems: [{
    item_id: "supplier:old",
    kind: "supplier_payable",
    party: "Old Supplier",
    original_amount: "10.00 SEK",
    remaining: "10.00 SEK",
    due_date: "2026-03-15",
    evidence_document_ids: [],
  }] });
  previous.through_period_id = "2026-02";
  previous.through_date = "2026-02-28";
  previous.reconciliation.period_id = "2026-02";
  previous.vat.cycle_start = "2026-01-01";
  previous.vat.cycle_end = "2026-03-31";
  const caseBundle = makeCase({
    previousBookkeeping: previous,
    period: { id: "2026-03", kind: "ordinary", start: "2026-03-01", end: "2026-03-31" },
    structuredInput: input({
      period_id: "2026-03",
      transactions: [{ ...balancedPurchase(), date: "2026-03-12" }],
      open_item_changes: [{ action: "settle", item_id: "supplier:old", amount: "10.00 SEK" }],
      reconciliations: [{ account: "1930", external_closing_balance: "495.00 SEK", evidence_document_ids: ["structured-bookkeeping.json"] }],
    }),
  });
  const outcome = await consolidate(caseBundle, "fixture-variant");
  assert.equal(outcome.kind, "proposal");
  const output = outcome.canonical_outputs.bookkeeping;
  assert.equal(output.ledger.transactions.length, 2);
  assert.equal(output.ledger.transactions[0].verification_id, "A8");
  assert.equal(output.ledger.verification_series.last_number, 9);
  assert.equal(output.open_items.closing.length, 0);
  assert.equal(output.reconciliations[0].status, "reconciled");
  assert.equal(output.vat_period.declaration_boxes["49"], "20.00 SEK");
  assert.equal(output.vat_period.frequency, "quarterly");
  assert.equal(output.vat_period.cycle_start, "2026-01-01");
  assert.equal(output.vat_period.cycle_end, "2026-03-31");
  assert.equal(output.vat_period.closing_transaction_source_id, "vat-closing");
  const closing = output.ledger.transactions[1];
  assert.equal(closing.source_id, "vat-closing");
  assert.equal(closing.date, "2026-03-31");
  assert.deepEqual(
    closing.lines.map((line) => `${line.account} debit=${line.debit} credit=${line.credit}`).sort(),
    [
      "2611 debit=25.00 SEK credit=0.00 SEK",
      "2641 debit=0.00 SEK credit=5.00 SEK",
      "2650 debit=0.00 SEK credit=20.00 SEK",
    ],
  );
  assert.equal(outcome.provenance.variant_ref.id, "fixture-variant");
  assert.ok(
    outcome.review.transaction_summaries.some((item) => item.source_id === "vat-closing" && item.summary),
    "the kernel-constructed VAT-closing transaction has its own deterministic narrative summary",
  );
});

test("VAT candidate-input and period-shape invariants fail closed", async (t) => {
  const period = { id: "2026-03", kind: "ordinary", start: "2026-03-01", end: "2026-03-31" };
  const run = async ({ previous, structuredInputOverrides = {}, effectivePolicies, selectedPeriod = period }) => consolidate(makeCase({
    previousBookkeeping: previous,
    period: selectedPeriod,
    structuredInput: input({ period_id: selectedPeriod.id, ...structuredInputOverrides }),
    ...(effectivePolicies ? { effectivePolicies } : {}),
  }));

  await t.test("a candidate must not supply vat at all", async () => {
    const { previous } = dueVatFixture();
    const outcome = await run({ previous, structuredInputOverrides: { vat: { status: "due" } } });
    assert.equal(outcome.kind, "needs_input");
    assert.ok(outcome.questions.some((question) => question.code === "VAT_NOT_CANDIDATE_SUPPLIED"));
  });

  await t.test("vat-closing is a reserved source_id", async () => {
    const { previous } = dueVatFixture();
    const outcome = await run({
      previous,
      structuredInputOverrides: {
        transactions: [{
          source_id: "vat-closing",
          date: "2026-03-15",
          description: "Not actually the closing",
          lines: [
            { account: "4000", account_name: "Purchases", debit: "1.00 SEK", credit: "0.00 SEK" },
            { account: "1930", account_name: "Bank", debit: "0.00 SEK", credit: "1.00 SEK" },
          ],
        }],
      },
    });
    assert.equal(outcome.kind, "needs_input");
    assert.ok(outcome.questions.some((question) => question.code === "VAT_CLOSING_SOURCE_ID_RESERVED"));
  });

  await t.test("a period cannot span more than one quarterly VAT deadline", async () => {
    const { previous } = dueVatFixture();
    previous.through_period_id = "2025";
    previous.through_date = "2025-12-31";
    previous.reconciliation.period_id = "2025";
    const year = { id: "2026", kind: "ordinary", start: "2026-01-01", end: "2026-12-31" };
    const outcome = await run({ previous, selectedPeriod: year });
    assert.ok(outcome.questions.some((question) => question.code === "VAT_PERIOD_SPANS_MULTIPLE_DEADLINES"));
  });

  await t.test("an unknown account chart is out of scope rather than a silent default", async () => {
    const { previous } = dueVatFixture();
    const outcome = await run({
      previous,
      effectivePolicies: policies({ bookkeeping: { vat_reporting: {
        frequency: "quarterly",
        chart: "BAS-1998",
        box_overrides: [],
        settlement_account: "2650",
      } } }),
    });
    assert.equal(outcome.kind, "out_of_scope");
    assert.ok(outcome.reasons.some((reason) => reason.code === "INVALID_VAT_ACCOUNT_POLICY"));
  });

  await t.test("outside quarter end, no closing transaction is constructed", async () => {
    const { previous } = dueVatFixture();
    const february = { id: "2026-02", kind: "ordinary", start: "2026-02-01", end: "2026-02-28" };
    previous.through_period_id = "2026-01";
    previous.through_date = "2026-01-31";
    previous.reconciliation.period_id = "2026-01";
    const outcome = await run({ previous, selectedPeriod: february });
    assert.equal(outcome.kind, "proposal");
    assert.equal(outcome.canonical_outputs.bookkeeping.vat_period.status, "not_due");
    assert.equal(outcome.canonical_outputs.bookkeeping.vat_period.closing_transaction_source_id, null);
    assert.equal(outcome.canonical_outputs.bookkeeping.ledger.transactions.length, 0);
  });

  await t.test("a box counts the cycle's movement, not the account's running balance", async () => {
    // 4531 is a cost account that runs all year. A quarter that adds 1 000,00
    // on top of an earlier 4 000,00 must declare only the quarter's movement,
    // which is the whole reason the baseline is carried in State.
    const { previous } = dueVatFixture();
    previous.ledger.balances.push(
      { account: "4531", account_name: "Services from outside the EU", debit: "5000.00 SEK", credit: "0.00 SEK" },
      { account: "2893", account_name: "Related party", debit: "0.00 SEK", credit: "5000.00 SEK" },
    );
    previous.vat.balances_at_cycle_start = [
      { account: "4531", account_name: "Services from outside the EU", debit: "4000.00 SEK", credit: "0.00 SEK" },
      { account: "2893", account_name: "Related party", debit: "0.00 SEK", credit: "4000.00 SEK" },
    ];
    const outcome = await run({ previous });
    assert.equal(outcome.kind, "proposal");
    assert.equal(outcome.canonical_outputs.bookkeeping.vat_period.declaration_boxes["22"], "1000.00 SEK");
  });

  await t.test("a period that closes no cycle carries the baseline forward untouched", async () => {
    const { previous } = dueVatFixture();
    const february = { id: "2026-02", kind: "ordinary", start: "2026-02-01", end: "2026-02-28" };
    previous.through_period_id = "2026-01";
    previous.through_date = "2026-01-31";
    previous.reconciliation.period_id = "2026-01";
    previous.vat.balances_at_cycle_start = [
      { account: "4531", account_name: "Services from outside the EU", debit: "4000.00 SEK", credit: "0.00 SEK" },
      { account: "2893", account_name: "Related party", debit: "0.00 SEK", credit: "4000.00 SEK" },
    ];
    const outcome = await run({ previous, selectedPeriod: february });
    assert.equal(outcome.kind, "proposal");
    // Carried through normalization, so it comes back in canonical account order.
    const byAccount = (rows) => [...rows].sort((left, right) => left.account.localeCompare(right.account));
    assert.deepEqual(
      byAccount(outcome.canonical_outputs.bookkeeping.vat_period.balances_at_cycle_start),
      byAccount(previous.vat.balances_at_cycle_start),
    );
  });

  await t.test("closing a cycle records the position after the closing entry, not before", async () => {
    // Caught by a demo run: recording the position before the entry left the
    // quarter's VAT in the baseline, so the next quarter subtracted VAT that had
    // already been settled and under-reported ruta 48 by exactly that amount.
    const { previous } = dueVatFixture();
    const outcome = await run({ previous });
    const { balances_at_cycle_start: recorded } = outcome.canonical_outputs.bookkeeping.vat_period;
    for (const account of ["2611", "2641"]) {
      const row = recorded.find((item) => item.account === account);
      assert.ok(
        row === undefined || (row.debit === "0.00 SEK" && row.credit === "0.00 SEK"),
        `${account} must stand at zero in the baseline the next cycle starts from`,
      );
    }
    // Accounts the closing entry does not touch carry their balance across.
    assert.equal(recorded.find((row) => row.account === "1930")?.debit, "100.00 SEK");
    assert.equal(recorded.find((row) => row.account === "2650")?.credit, "20.00 SEK");
  });

  await t.test("a settled quarter does not leak into the next one", async () => {
    // The whole chain: close one cycle, carry its baseline, and check that the
    // next cycle reports only its own VAT.
    const { previous } = dueVatFixture();
    const first = await run({ previous });
    assert.equal(first.kind, "proposal");
    assert.equal(first.canonical_outputs.bookkeeping.vat_period.declaration_boxes["10"], "25.00 SEK");

    const second = bookkeepingState({ balances: first.canonical_outputs.bookkeeping.ledger.closing_balances });
    second.through_period_id = "2026-05";
    second.through_date = "2026-05-31";
    second.reconciliation.period_id = "2026-05";
    second.ledger.verification_series = first.canonical_outputs.bookkeeping.ledger.verification_series;
    second.vat = first.canonical_outputs.bookkeeping.vat_period;
    const june = { id: "2026-06", kind: "ordinary", start: "2026-06-01", end: "2026-06-30" };
    const outcome = await run({ previous: second, selectedPeriod: june });
    assert.equal(outcome.kind, "proposal");
    const { declaration_boxes: boxes } = outcome.canonical_outputs.bookkeeping.vat_period;
    assert.equal(boxes["10"], "0.00 SEK", "the first quarter's output VAT must not be declared twice");
    assert.equal(boxes["48"], "0.00 SEK");
    assert.equal(boxes["49"], "0.00 SEK");
  });

  await t.test("reverse charge fills the base, the output and the deduction, and nets to zero", async () => {
    const { previous } = dueVatFixture();
    // Replace the domestic VAT with a purchase of services from outside the EU.
    previous.ledger.balances = [
      { account: "1930", account_name: "Bank", debit: "100.00 SEK", credit: "0.00 SEK" },
      { account: "2081", account_name: "Share capital", debit: "0.00 SEK", credit: "100.00 SEK" },
      { account: "4531", account_name: "Services from outside the EU", debit: "1000.00 SEK", credit: "0.00 SEK" },
      { account: "2614", account_name: "Reverse charge output VAT", debit: "0.00 SEK", credit: "250.00 SEK" },
      { account: "2645", account_name: "Calculated input VAT", debit: "250.00 SEK", credit: "0.00 SEK" },
      { account: "2893", account_name: "Related party", debit: "0.00 SEK", credit: "1000.00 SEK" },
    ];
    const outcome = await run({ previous });
    assert.equal(outcome.kind, "proposal");
    const { declaration_boxes: boxes } = outcome.canonical_outputs.bookkeeping.vat_period;
    assert.equal(boxes["22"], "1000.00 SEK");
    assert.equal(boxes["30"], "250.00 SEK");
    assert.equal(boxes["48"], "250.00 SEK");
    assert.equal(boxes["10"], "0.00 SEK", "no domestic sales VAT, since there were no sales");
    assert.equal(boxes["49"], "0.00 SEK");
  });

  await t.test("the closing entry clears every VAT account that moved", async () => {
    const { previous } = dueVatFixture();
    previous.ledger.balances.push(
      { account: "2614", account_name: "Reverse charge output VAT", debit: "0.00 SEK", credit: "40.00 SEK" },
      { account: "2645", account_name: "Calculated input VAT", debit: "40.00 SEK", credit: "0.00 SEK" },
    );
    const outcome = await run({ previous });
    assert.equal(outcome.kind, "proposal");
    const closing = outcome.canonical_outputs.bookkeeping.ledger.closing_balances;
    for (const account of ["2611", "2641", "2614", "2645"]) {
      const row = closing.find((item) => item.account === account);
      assert.ok(
        row === undefined || (row.debit === "0.00 SEK" && row.credit === "0.00 SEK"),
        `${account} was left with a balance after closing`,
      );
    }
  });

  await t.test("a VAT account the mapping does not know is reported, and the period still completes", async () => {
    const { previous } = dueVatFixture();
    previous.ledger.balances.push(
      { account: "2618", account_name: "Deferred output VAT", debit: "0.00 SEK", credit: "12.00 SEK" },
      { account: "2699", account_name: "Something unmapped", debit: "0.00 SEK", credit: "7.00 SEK" },
      { account: "1510", account_name: "Receivable", debit: "19.00 SEK", credit: "0.00 SEK" },
    );
    const outcome = await run({ previous });
    assert.equal(outcome.kind, "proposal");
    const codes = outcome.warnings.map((warning) => warning.code);
    assert.ok(codes.includes("VAT_ACCOUNT_NOT_IN_MAP"));
    // 2618 is deliberately excluded, so it must not be reported as a gap.
    const reported = outcome.warnings.filter((warning) => warning.code === "VAT_ACCOUNT_NOT_IN_MAP");
    assert.deepEqual(reported.map((warning) => warning.account), ["2699"]);
  });
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

test("legacy v1 integer-ore input and state are read but new output is v3 Money", async () => {
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
      date: "2026-05-12",
      description: "Legacy amount",
      lines: [
        { account: "4000", debit_ore: 2_500, credit_ore: 0 },
        { account: "1930", debit_ore: 0, credit_ore: 2_500 },
      ],
    }],
  });
  const outcome = await consolidate(makeCase({ structuredInput: legacyInput, previousBookkeeping: sealedLegacyState }));
  assert.equal(outcome.kind, "proposal");
  assert.equal(outcome.projected_state.ref.schema_version, "3.0");
  assert.equal(outcome.projected_state.payload.schema_version, "3.0");
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

test("Bookkeeping does not adapt schema-v2 State", async () => {
  const obsolete = sealContent({
    schemaId: "se.bergbok.bookkeeping.state",
    schemaVersion: "2.0",
    stableId: "example-ab:obsolete-v2-state",
    version: 1,
    payload: { ...bookkeepingState({ balances: [] }), schema_version: "2.0" },
  });
  const outcome = await consolidate(makeCase({ previousBookkeeping: obsolete }));
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
  assert.match(outcome.review.summary, /cannot be completed with the available evidence/);
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
  assert.match(outcome.review.summary, /falls outside the supported Bookkeeping profile/);
  assert.ok(outcome.reasons.some((reason) => reason.code === "UNSUPPORTED_PROFILE"));
});

test("unsupported VAT reporting frequencies fail explicitly", async () => {
  const outcome = await consolidate(makeCase({
    effectivePolicies: policies({ bookkeeping: { vat_reporting: {
      frequency: "monthly",
      input_accounts: ["2641"],
      output_accounts: ["2611"],
      settlement_account: "2650",
    } } }),
  }));
  assert.equal(outcome.kind, "out_of_scope");
  assert.ok(outcome.reasons.some((reason) => reason.code === "UNSUPPORTED_VAT_FREQUENCY"));
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
    stableId: "example-ab:2026-05:payroll-facts",
    version: 1,
    payload: {
      contract_version: "1.0",
      schema_version: "2.0",
      company_id: "example-ab",
      period_id: "2026-05",
      status: "proposed",
      currency: "SEK",
      source_payroll_result_ref: ref("se.bergbok.payroll-result", "payroll-run-1"),
      expense_facts: [{
        fact_id: "payroll:2026-05:e1:gross-cash-salary",
        kind: "gross_cash_salary",
        employee_id: "e1",
        amount: "300.00 SEK",
        evidence_document_ids: ["payroll-input-e1"],
      }],
      liability_facts: [
        {
          fact_id: "payroll:2026-05:e1:withholding-tax-payable",
          kind: "withholding_tax_payable",
          creditor: "skatteverket",
          reporting_period: "2026-05",
          amount: "90.00 SEK",
          evidence_document_ids: ["payroll-input-e1"],
        },
        {
          fact_id: "payroll:2026-05:e1:net-pay",
          kind: "net_salary_payable",
          party_ref: "e1",
          party_name: "Ada Example",
          due_date: "2026-05-25",
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
    date: "2026-05-25",
    description: "March salary",
    assignments: [
      { fact_id: "payroll:2026-05:e1:gross-cash-salary", account: salaryAccount, account_name: "Salary" },
      { fact_id: "payroll:2026-05:e1:withholding-tax-payable", account: "2710", account_name: "Employee tax" },
      { fact_id: "payroll:2026-05:e1:net-pay", account: "2910", account_name: "Salary payable" },
    ],
  };
}

function approvedPayrollWrapper(facts = payrollFacts(), overrides = {}) {
  return sealContent({
    schemaId: "se.bergbok.upstream-result",
    stableId: "example-ab:2026-05:payroll-accounting-facts",
    version: 1,
    payload: {
      contract_version: "1.0",
      status: "approved",
      trust: "approved_internal",
      company_id: "example-ab",
      period_id: "2026-05",
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
  const normalized = normalizePayrollAccountingFacts(wrapper, { companyId: "example-ab", periodId: "2026-05" });
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
    periodId: "2026-05",
    expectedGroupDigest: digest,
  }).trust, "sealed_same_aggregate");
  assert.throws(() => normalizePayrollAccountingFacts(wrapper, {
    companyId: "example-ab",
    periodId: "2026-05",
    expectedGroupDigest: "b".repeat(64),
  }), /group_digest does not match/);
});
