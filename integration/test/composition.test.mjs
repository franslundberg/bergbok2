import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";

import { Artifacts, Bookkeeping, CompanyRecord, Payroll } from "../../index.mjs";

const TEST_ROOT = path.resolve("integration/test/.tmp/composition");
after(() => rm(TEST_ROOT, { recursive: true, force: true }));

test("the public modules compose through an approved Payroll-to-Bookkeeping handoff", async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(path.dirname(TEST_ROOT), { recursive: true });
  const company = await CompanyRecord.create({
    rootDir: TEST_ROOT,
    companyId: "composition-ab",
    language: "en",
    clock: fixedClock,
    initialState: {
      core: {
        organization: { name: "Composition AB", organization_number: "559992-0001" },
        policies: { bookkeeping: bookkeepingCorePolicy() },
      },
      domains: {
        bookkeeping: {
          contract_version: "1.0",
          status: "approved",
          schema_id: "se.bergbok.bookkeeping.state",
          schema_version: "3.0",
          company_id: "composition-ab",
          through_period_id: "2026-04",
          through_date: "2026-04-30",
          currency: "SEK",
          ledger: {
            balances: [
              { account: "1930", account_name: "Bank", debit: "500.00 SEK", credit: "0.00 SEK" },
              { account: "2081", account_name: "Share capital", debit: "0.00 SEK", credit: "500.00 SEK" },
            ],
            verification_series: { series: "A", last_number: 7 },
          },
          open_items: { items: [], totals: { count: 0, by_kind: {} } },
          reconciliation: { period_id: "2026-04", accounts: [] },
          vat: vatNotDue("2026-04-01", "2026-06-30"),
        },
      },
    },
  });
  const period = { id: "2026-05", kind: "ordinary", start: "2026-05-01", end: "2026-05-31" };
  const payrollInput = {
    schema_version: "2.0",
    rules_profile: "simple-payroll-demo-v1",
    period_id: period.id,
    payment_date: "2026-05-25",
    employee: {
      employee_id: "employee-1",
      name: "Kim Example",
      personal_identity_number: "19900101-1234",
      payment_destination: "SE00-DEMO-PAYROLL-ACCOUNT",
    },
    pay_components: [{
      type: "fixed_monthly_salary",
      description: "Fixed monthly salary",
      amount: "40000.00 SEK",
    }],
  };
  const payrollAssignment = await assign(company, period, "payroll-input", payrollInput, null);
  const payrollCase = await company.prepare("payroll", period.id, {
    expectedDocsetHead: payrollAssignment.docset.ref,
    effective_policies: {
      core: { country: "SE", currency: "SEK" },
      payroll: {
        profile: "simple-payroll-demo-v1",
        daily_divisor: 30,
        withholding_basis_points: 3000,
        employer_contribution_basis_points: 3142,
      },
    },
  });
  const payrollOutcome = await Payroll.consolidate(payrollCase);
  assert.equal(payrollOutcome.kind, "proposal");
  const payrollRun = await company.record(payrollCase.ref, payrollOutcome);
  const payrollApproval = await company.approve(payrollRun.ref, approval("payroll-approver"));
  assert.equal(payrollApproval.upstream_result.payload.trust, "approved_internal");

  const bookkeepingInput = {
    schema_id: "se.bergbok.bookkeeping-input",
    schema_version: "3.0",
    company_id: "composition-ab",
    period_id: period.id,
    mode: "ordinary",
    transactions: [],
    payroll_postings: [payrollPosting(payrollApproval.upstream_result.payload.output)],
    open_item_changes: [],
    reconciliations: [{ account: "1930", external_closing_balance: "500.00 SEK" }],
  };
  const bookkeepingAssignment = await assign(
    company,
    period,
    "bookkeeping-input",
    bookkeepingInput,
    payrollAssignment.docset.ref,
  );
  const bookkeepingCase = await company.prepare("bookkeeping", period.id, {
    expectedDocsetHead: bookkeepingAssignment.docset.ref,
    upstreamRefs: [payrollApproval.upstream_result.ref],
    effective_policies: {
      core: {
        country: "SE",
        currency: "SEK",
        fiscal_year: { start: "2026-01-01", end: "2026-12-31" },
        accounting_method: "invoice",
      },
      bookkeeping: {
        profile: "se-private-ab-invoice-calendar-demo-v1",
        verification_series: "A",
        open_items: {
          supplier_payable: { accounts: ["2440"], side: "credit" },
          customer_receivable: { accounts: ["1510"], side: "debit" },
          other_current_payable: { accounts: ["2890", "2893"], side: "credit" },
          other_current_receivable: { accounts: ["1680"], side: "debit" },
        },
        ...bookkeepingCorePolicy(),
      },
    },
  });
  assert.deepEqual(bookkeepingCase.payload.upstream_results[0].ref, payrollApproval.upstream_result.ref);
  const bookkeepingOutcome = await Bookkeeping.consolidate(bookkeepingCase);
  assert.equal(bookkeepingOutcome.kind, "proposal");
  assert.equal(bookkeepingOutcome.canonical_outputs.bookkeeping.ledger.transactions[0].verification_id, "A8");
  assert.equal(bookkeepingOutcome.evidence[1].trust, "approved_internal");
  const bookkeepingRun = await company.record(bookkeepingCase.ref, bookkeepingOutcome);
  const bookkeepingApproval = await company.approve(bookkeepingRun.ref, approval("bookkeeping-approver"));

  const artifactBundle = await Artifacts.render(bookkeepingApproval.output_snapshot, "sie4-v1");
  assert.equal(artifactBundle.payload.preview, false);
  assert.match(Buffer.from(artifactBundle.payload.artifacts[0].content_base64, "base64").toString("utf8"), /Payroll 2026-05/);
  const reportBundle = await Artifacts.render(bookkeepingApproval.output_snapshot, "report-html-v1");
  assert.equal(reportBundle.payload.language, "en");
  const reportHtml = Buffer.from(reportBundle.payload.artifacts[0].content_base64, "base64").toString("utf8");
  assert.match(reportHtml, /<h1>Bookkeeping report/);
  assert.match(reportHtml, /Payroll 2026-05/);
  assert.match(reportHtml, /7010/);
  const payslipBundle = await Artifacts.render(payrollApproval.output_snapshot, "payslips-pdf-v1");
  assert.equal(payslipBundle.payload.language, "en");
  assert.match(Buffer.from(payslipBundle.payload.artifacts[0].content_base64, "base64").toString("latin1"), /Gross pay/);
  const finalState = await company.read({ kind: "state" });
  assert.ok(finalState.payload.domains.payroll);
  assert.ok(finalState.payload.domains.bookkeeping);
});

async function assign(company, period, role, input, expectedHead) {
  const logItemRef = await company.ingest({
    filename: `${role}.json`,
    media_type: "application/json",
    content: JSON.stringify(input),
    suggested_period: period.id,
  }, { id: "uploader", role: "operator" });
  return company.reviseDocset(period, expectedHead, {
    actor: { id: "uploader", role: "operator" },
    add: [{ log_item_ref: logItemRef, role }],
  });
}

function approval(id) {
  return {
    decision: "approved",
    actor: { id, role: "approver" },
    authority: { kind: "role", role: "approver" },
  };
}

function payrollPosting(facts) {
  const accounts = {
    gross_cash_salary: ["7010", "Salaries"],
    employer_contribution: ["7510", "Employer contributions"],
    withholding_tax_payable: ["2710", "Employee withholding tax"],
    employer_contribution_payable: ["2731", "Employer contributions payable"],
    net_salary_payable: ["2910", "Accrued salaries"],
  };
  return {
    payroll_facts_ref: facts.ref,
    date: "2026-05-25",
    description: "Payroll 2026-05 - Kim Example",
    assignments: [...facts.payload.expense_facts, ...facts.payload.liability_facts].map((fact) => ({
      fact_id: fact.fact_id,
      account: accounts[fact.kind][0],
      account_name: accounts[fact.kind][1],
    })),
  };
}

function bookkeepingCorePolicy() {
  return {
    chart_of_accounts: "BAS",
    vat_reporting: {
      frequency: "quarterly",
      input_accounts: ["2641"],
      output_accounts: ["2611"],
      settlement_account: "2650",
    },
  };
}

function vatNotDue(cycleStart, cycleEnd) {
  return {
    frequency: "quarterly",
    cycle_start: cycleStart,
    cycle_end: cycleEnd,
    due_in_period: false,
    input_accounts: ["2641"],
    output_accounts: ["2611"],
    settlement_account: "2650",
    status: "not_due",
    closing_transaction_source_id: null,
    declaration_boxes: {},
  };
}

function fixedClock() {
  return new Date("2026-09-03T12:00:00.000Z");
}
