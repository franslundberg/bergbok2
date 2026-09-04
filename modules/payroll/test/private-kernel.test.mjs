import assert from "node:assert/strict";
import test from "node:test";

import { createContentRef, parseMoney } from "../../../contracts/src/index.mjs";
import { calculateSimplePayroll } from "../src/private/kernel.mjs";

test("private Payroll Kernel is deterministic and has no authority side effects", () => {
  const sourceResultRef = createContentRef({
    schemaId: "se.bergbok.payroll.result",
    stableId: "example-ab:2026-09:employee-1",
    version: 1,
    payload: { fixed: true },
  });
  const input = {
    payment_date: "2026-09-25",
    employee: {
      employee_id: "employee-1",
      name: "Kim Example",
      personal_identity_number: "19900101-1234",
      payment_destination: "SE00-DEMO-PAYROLL-ACCOUNT",
    },
    pay_components: [
      { type: "fixed_monthly_salary", description: "Salary", amount_ore: 4_000_000n },
      { type: "ordinary_absence", description: "One day", days: 1 },
    ],
  };
  const parameters = {
    companyId: "example-ab",
    periodId: "2026-09",
    documentId: "payroll-input-1",
    input,
    policy: {
      daily_divisor: 30,
      tax_withholding_basis_points: 3_000,
      employer_contribution_basis_points: 3_142,
    },
    priorYearToDate: null,
    sourceResultRef,
  };
  const first = calculateSimplePayroll(parameters);
  const second = calculateSimplePayroll(structuredClone(parameters));
  assert.deepEqual(first, second);
  assert.equal(first.payslip.status, "proposed");
  assert.equal(first.payment.status, "prepared_not_paid");
  assert.equal(first.agi.status, "prepared_not_submitted");
  const expenses = first.accountingFacts.expense_facts;
  const liabilities = first.accountingFacts.liability_facts;
  assert.equal(
    expenses.reduce((sum, fact) => sum + parseMoney(fact.amount).minorUnits, 0n),
    liabilities.reduce((sum, fact) => sum + parseMoney(fact.amount).minorUnits, 0n),
  );
  assert.equal("transactions" in first.accountingFacts, false);
});
