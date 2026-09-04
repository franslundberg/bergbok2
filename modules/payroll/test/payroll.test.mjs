import assert from "node:assert/strict";
import test from "node:test";

import { consolidate } from "../src/index.mjs";
import {
  assertModuleOutcome,
  createStateEnvelope,
  sealContent,
  verifySealedContent,
  parseMoney,
} from "../../../contracts/src/index.mjs";

const COMPANY_ID = "example-ab";
const PERIOD_ID = "2026-09";

function payrollInput(overrides = {}) {
  return {
    schema_version: "2.0",
    rules_profile: "simple-payroll-demo-v1",
    period_id: PERIOD_ID,
    payment_date: "2026-09-25",
    employee: {
      employee_id: "employee-1",
      name: "Kim Example",
      personal_identity_number: "19900101-1234",
      payment_destination: "SE00-DEMO-PAYROLL-ACCOUNT",
    },
    pay_components: [
      { type: "fixed_monthly_salary", description: "Fixed monthly salary", amount: "40000.00 SEK" },
    ],
    ...overrides,
  };
}

function makeCase({ input = payrollInput(), policy = undefined, documents = undefined, previousPayroll = null, language = undefined } = {}) {
  const docset = sealContent({
    schemaId: "se.bergbok.docset",
    stableId: `${COMPANY_ID}:${PERIOD_ID}:docset`,
    version: 1,
    payload: {
      documents: documents ?? [{
        document_id: "payroll-input-1",
        role: "payroll-input",
        media_type: "application/json",
        content_base64: Buffer.from(JSON.stringify(input), "utf8").toString("base64"),
      }],
    },
  });
  const previousState = createStateEnvelope({
    companyId: COMPANY_ID,
    sequence: 4,
    core: {},
    domains: previousPayroll ? { payroll: previousPayroll } : {},
  });
  return sealContent({
    schemaId: "se.bergbok.consolidation-case",
    stableId: `${COMPANY_ID}:${PERIOD_ID}:payroll`,
    version: 1,
    payload: {
      contract_version: "1.0",
      company_id: COMPANY_ID,
      domain: "payroll",
      ...(language ? { language } : {}),
      period: { id: PERIOD_ID, kind: "ordinary", start: "2026-09-01", end: "2026-09-30" },
      docset,
      previous_state: previousState,
      upstream_results: [],
      effective_policies: policy ?? {
        core: { country: "SE", currency: "SEK" },
        payroll: {
          profile: "simple-payroll-demo-v1",
          daily_divisor: 30,
          withholding_basis_points: 3_000,
          employer_contribution_basis_points: 3_142,
        },
      },
    },
  });
}

test("ordinary fixed salary and whole-day absence produce a reviewable proposal", async () => {
  const caseBundle = makeCase({
    input: payrollInput({
      pay_components: [
        { type: "fixed_monthly_salary", description: "Fixed monthly salary", amount: "40000.00 SEK" },
        { type: "ordinary_absence", description: "Two unpaid absence days", days: 2 },
      ],
    }),
  });

  const result = await consolidate(caseBundle);
  assert.equal(result.kind, "proposal");
  assertModuleOutcome(result, { caseRef: caseBundle.ref, domain: "payroll" });
  assert.equal(result.canonical_outputs.payslip.payload.absence_deduction, "2666.67 SEK");
  assert.equal(result.canonical_outputs.payslip.payload.gross_pay, "37333.33 SEK");
  assert.equal(result.canonical_outputs.payslip.payload.tax_withheld, "11200.00 SEK");
  assert.equal(result.canonical_outputs.payslip.payload.net_pay, "26133.33 SEK");
  assert.equal(result.canonical_outputs.agi.payload.employer_contribution, "11730.13 SEK");
  assert.equal(result.canonical_outputs.payslip.ref.schema_version, "2.0");
  for (const key of ["payslip", "payment", "agi", "payroll_accounting_facts"]) {
    assert.equal(result.canonical_outputs[key].ref.schema_version, "2.0", key);
    assert.equal(result.canonical_outputs[key].payload.schema_version, "2.0", key);
  }
  assert.equal(result.projected_state.ref.schema_version, "2.0");
  assert.equal(result.projected_state.payload.schema_version, "2.0");
  assert.equal(result.canonical_outputs.payroll.schema_version, "2.0");
  assert.equal(result.canonical_outputs.payment.payload.status, "prepared_not_paid");
  assert.equal(result.canonical_outputs.agi.payload.status, "prepared_not_submitted");
  assert.equal(result.review.actions_performed.approved, false);
  assert.equal(result.review.actions_performed.state_written, false);
});

test("an English case produces an English Payroll review", async () => {
  const result = await consolidate(makeCase({ language: "en" }));
  assert.equal(result.kind, "proposal");
  assert.equal(result.review.language, "en");
  assert.match(result.review.summary, /^Proposed payroll for /);
});

test("legacy v1 integer-ore input is read but Payroll writes schema v2 Money", async () => {
  const result = await consolidate(makeCase({
    input: payrollInput({
      schema_version: "1.0",
      pay_components: [{ type: "fixed_monthly_salary", description: "Legacy salary", amount_ore: 4_000_000 }],
    }),
  }));
  assert.equal(result.kind, "proposal");
  assert.equal(result.projected_state.ref.schema_version, "2.0");
  assert.equal(result.projected_state.payload.schema_version, "2.0");
  assert.equal(result.canonical_outputs.payslip.payload.gross_pay, "40000.00 SEK");
});

test("a signed correction changes current payroll and accumulates projected year-to-date State", async () => {
  const previousPayroll = sealContent({
    schemaId: "se.bergbok.payroll.state",
    schemaVersion: "1.0",
    stableId: `${COMPANY_ID}:payroll-state`,
    version: 4,
    payload: {
      contract_version: "1.0",
      schema_version: "1.0",
      status: "approved",
      company_id: COMPANY_ID,
      through_period_id: "2026-08",
      employees: [{
        employee_id: "employee-1",
        name: "Kim Example",
        year_to_date: {
          reporting_year: "2026",
          gross_pay_ore: 8_000_000,
          tax_withheld_ore: 2_400_000,
          employer_contribution_basis_ore: 8_000_000,
          employer_contribution_ore: 2_513_600,
          net_pay_ore: 5_600_000,
        },
      }],
    },
  });
  const previousPayrollRef = structuredClone(previousPayroll.ref);
  const caseBundle = makeCase({
    previousPayroll,
    input: payrollInput({
      pay_components: [
        { type: "fixed_monthly_salary", description: "Fixed monthly salary", amount: "40000.00 SEK" },
        { type: "correction", description: "August salary correction", amount: "-500.00 SEK", relates_to_period: "2026-08" },
      ],
    }),
  });

  const result = await consolidate(caseBundle, { id: "simple-payroll-demo-v1", version: "1" });
  assert.equal(result.kind, "proposal");
  assert.equal(result.canonical_outputs.payslip.payload.correction, "-500.00 SEK");
  assert.equal(result.canonical_outputs.payslip.payload.gross_pay, "39500.00 SEK");
  assert.equal(result.canonical_outputs.payslip.payload.net_pay, "27650.00 SEK");
  const employeeState = result.projected_state.payload.employees[0];
  assert.equal(employeeState.year_to_date.gross_pay, "119500.00 SEK");
  assert.equal(employeeState.year_to_date.tax_withheld, "35850.00 SEK");
  assert.equal(employeeState.year_to_date.net_pay, "83650.00 SEK");
  assert.deepEqual(previousPayroll.ref, previousPayrollRef);
});

test("Payroll rejects a tampered sealed v1 prior state before adaptation", async () => {
  const sealed = sealContent({
    schemaId: "se.bergbok.payroll.state",
    schemaVersion: "1.0",
    stableId: `${COMPANY_ID}:tampered-payroll-state`,
    version: 1,
    payload: { schema_version: "1.0", employees: [] },
  });
  const tampered = structuredClone(sealed);
  tampered.payload.employees.push({ employee_id: "injected" });
  const result = await consolidate(makeCase({ previousPayroll: tampered }));
  assert.equal(result.kind, "needs_input");
  assert.ok(result.questions.some((question) => question.code === "INVALID_PREVIOUS_PAYROLL_MONEY"));
});

test("Payroll rejects prior State whose payload and ContentRef schema versions disagree", async () => {
  const mismatch = sealContent({
    schemaId: "se.bergbok.payroll.state",
    schemaVersion: "2.0",
    stableId: `${COMPANY_ID}:mismatched-payroll-state`,
    version: 1,
    payload: { schema_version: "1.0", employees: [] },
  });
  const result = await consolidate(makeCase({ previousPayroll: mismatch }));
  assert.equal(result.kind, "needs_input");
  assert.ok(result.questions.some((question) => question.code === "INVALID_PREVIOUS_PAYROLL_MONEY"));
});

test("unsupported profiles and pay components are explicit out-of-scope outcomes", async () => {
  const unsupportedVariant = await consolidate(makeCase(), "advanced-payroll-v2");
  assert.equal(unsupportedVariant.kind, "out_of_scope");
  assert.equal(unsupportedVariant.reasons[0].code, "UNSUPPORTED_RULES_PROFILE");

  const unsupportedComponent = await consolidate(makeCase({
    input: payrollInput({
      pay_components: [
        { type: "fixed_monthly_salary", description: "Fixed monthly salary", amount: "40000.00 SEK" },
        { type: "taxable_benefit", description: "Car benefit", amount: "5000.00 SEK" },
      ],
    }),
  }));
  assert.equal(unsupportedComponent.kind, "out_of_scope");
  assert.equal(unsupportedComponent.reasons[0].code, "UNSUPPORTED_PAY_COMPONENT");

  const unsupportedJurisdiction = await consolidate(makeCase({
    policy: {
      core: { country: "DK", currency: "DKK" },
      payroll: {
        profile: "simple-payroll-demo-v1",
        daily_divisor: 30,
        withholding_basis_points: 3_000,
        employer_contribution_basis_points: 3_142,
      },
    },
  }));
  assert.equal(unsupportedJurisdiction.kind, "out_of_scope");
  assert.ok(unsupportedJurisdiction.reasons.some((reason) => reason.code === "UNSUPPORTED_PAYROLL_COUNTRY"));
});

test("missing payroll documents, employee facts, and effective rates return needs_input", async () => {
  const noDocument = await consolidate(makeCase({ documents: [], language: "en" }));
  assert.equal(noDocument.kind, "needs_input");
  assert.equal(noDocument.review.language, "en");
  assert.match(noDocument.review.summary, /^Payroll needs /);
  assert.equal(noDocument.questions[0].code, "MISSING_PAYROLL_INPUT");

  const missingEmployeeAndRates = await consolidate(makeCase({
    input: payrollInput({ employee: { employee_id: "employee-1", name: "Kim Example" } }),
    policy: {
      core: { country: "SE", currency: "SEK" },
      payroll: { profile: "simple-payroll-demo-v1", daily_divisor: 30 },
    },
  }));
  assert.equal(missingEmployeeAndRates.kind, "needs_input");
  const fields = new Set(missingEmployeeAndRates.questions.map((item) => item.field));
  assert.ok(fields.has("employee.personal_identity_number"));
  assert.ok(fields.has("employee.payment_destination"));
  assert.ok(fields.has("effective_policies.payroll.withholding_basis_points"));
  assert.ok(fields.has("effective_policies.payroll.employer_contribution_basis_points"));
});

test("sealed payroll accounting facts use canonical Money, reconcile, and remain proposed", async () => {
  const result = await consolidate(makeCase());
  const facts = result.canonical_outputs.payroll_accounting_facts;
  verifySealedContent(facts);
  assert.equal(facts.ref.schema_id, "se.bergbok.bookkeeping.payroll-accounting-facts");
  assert.equal(facts.ref.schema_version, "2.0");
  assert.equal(facts.payload.status, "proposed");
  assert.equal(facts.payload.source_payroll_result_ref.schema_id, "se.bergbok.payroll.result");
  const economicFacts = [...facts.payload.expense_facts, ...facts.payload.liability_facts];
  assert.ok(economicFacts.every((fact) => parseMoney(fact.amount, { expectedCurrency: "SEK" }).minorUnits > 0n));
  assert.equal(
    facts.payload.expense_facts.reduce((sum, fact) => sum + parseMoney(fact.amount).minorUnits, 0n),
    facts.payload.liability_facts.reduce((sum, fact) => sum + parseMoney(fact.amount).minorUnits, 0n),
  );
  assert.equal("transactions" in facts.payload, false);
  assert.equal(JSON.stringify(facts.payload).includes('"account"'), false);
  assert.deepEqual(facts.payload.liability_facts.find((fact) => fact.kind === "net_salary_payable"), {
    fact_id: "payroll:2026-09:employee-1:net-pay",
    kind: "net_salary_payable",
    party_ref: "employee-1",
    party_name: "Kim Example",
    amount: "28000.00 SEK",
    due_date: "2026-09-25",
    evidence_document_ids: ["payroll-input-1"],
  });
});

test("consolidation is deterministic, deeply immutable, and does not mutate its case", async () => {
  const caseBundle = makeCase();
  const before = structuredClone(caseBundle);
  const first = await consolidate(caseBundle);
  const second = await consolidate(caseBundle);
  assert.deepEqual(first, second);
  assert.deepEqual(caseBundle, before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.canonical_outputs.payroll_accounting_facts.payload), true);
  assert.throws(() => {
    first.canonical_outputs.payslip.payload.net_pay = "0.00 SEK";
  }, TypeError);
});
