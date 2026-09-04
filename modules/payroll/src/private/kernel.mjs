import { PAYROLL_SCHEMA_VERSION, payrollToV2 } from "./money-boundary.mjs";

export const SIMPLE_PAYROLL_PROFILE = Object.freeze({
  id: "simple-payroll-demo-v1",
  version: "1",
  input_schema_version: PAYROLL_SCHEMA_VERSION,
  supported_component_types: Object.freeze([
    "fixed_monthly_salary",
    "ordinary_absence",
    "correction",
  ]),
});

export function calculateSimplePayroll({
  companyId,
  periodId,
  documentId,
  documentIds,
  input,
  policy,
  priorYearToDate,
  sourceResultRef,
}) {
  const salary = input.pay_components.find((component) => component.type === "fixed_monthly_salary");
  const absences = input.pay_components.filter((component) => component.type === "ordinary_absence");
  const corrections = input.pay_components.filter((component) => component.type === "correction");

  const fixedSalaryOre = salary.amount_ore;
  const normalizedAbsences = absences.map((component) => ({
    ...component,
    deduction_ore: component.days === undefined
      ? component.deduction_ore
      : roundRatio(fixedSalaryOre, component.days, policy.daily_divisor),
  }));
  const absenceDeductionOre = safeSum(normalizedAbsences.map((component) => component.deduction_ore), "absence deductions");
  const correctionOre = safeSum(corrections.map((component) => component.amount_ore), "corrections");
  const grossPayOre = safeAdd(
    safeAdd(fixedSalaryOre, -absenceDeductionOre, "gross pay"),
    correctionOre,
    "gross pay",
  );
  if (grossPayOre <= 0n) {
    return {
      unsupported: {
        code: "NON_POSITIVE_GROSS_PAY",
        message: "The simple payroll profile cannot process payroll with non-positive gross pay.",
      },
    };
  }

  const taxWithheldOre = roundBasisPoints(grossPayOre, policy.tax_withholding_basis_points);
  const employerContributionBasisOre = grossPayOre;
  const employerContributionOre = roundBasisPoints(
    employerContributionBasisOre,
    policy.employer_contribution_basis_points,
  );
  const netPayOre = safeAdd(grossPayOre, -taxWithheldOre, "net pay");
  const paymentItemId = `payroll:${periodId}:${input.employee.employee_id}:net-pay`;

  const earnings = [
    {
      kind: "fixed_monthly_salary",
      description: salary.description,
      amount_ore: fixedSalaryOre,
    },
    ...corrections
      .filter((component) => component.amount_ore > 0n)
      .map((component) => ({
        kind: "correction",
        description: component.description,
        amount_ore: component.amount_ore,
        relates_to_period: component.relates_to_period ?? null,
      })),
  ];
  const deductions = [
    ...normalizedAbsences.map((component) => ({
      kind: "ordinary_absence",
      description: component.description,
      amount_ore: component.deduction_ore,
      days: component.days ?? null,
    })),
    ...corrections
      .filter((component) => component.amount_ore < 0n)
      .map((component) => ({
        kind: "correction",
        description: component.description,
        amount_ore: -component.amount_ore,
        relates_to_period: component.relates_to_period ?? null,
      })),
    {
      kind: "tax_withholding",
      description: "Preliminary tax withholding",
      amount_ore: taxWithheldOre,
    },
  ];

  const payslip = {
    contract_version: "1.0",
    schema_version: PAYROLL_SCHEMA_VERSION,
    status: "proposed",
    company_id: companyId,
    period_id: periodId,
    payment_date: input.payment_date,
    employee_id: input.employee.employee_id,
    employee_name: input.employee.name,
    earnings,
    deductions,
    fixed_monthly_salary_ore: fixedSalaryOre,
    absence_deduction_ore: absenceDeductionOre,
    correction_ore: correctionOre,
    gross_pay_ore: grossPayOre,
    tax_withheld_ore: taxWithheldOre,
    net_pay_ore: netPayOre,
  };

  const payment = {
    contract_version: "1.0",
    schema_version: PAYROLL_SCHEMA_VERSION,
    status: "prepared_not_paid",
    company_id: companyId,
    period_id: periodId,
    payment_id: paymentItemId,
    requested_execution_date: input.payment_date,
    currency: "SEK",
    amount_ore: netPayOre,
    payee: {
      employee_id: input.employee.employee_id,
      name: input.employee.name,
      destination: input.employee.payment_destination,
    },
  };

  const reportingPeriod = input.payment_date.slice(0, 7);
  const agi = {
    contract_version: "1.0",
    schema_version: PAYROLL_SCHEMA_VERSION,
    status: "prepared_not_submitted",
    company_id: companyId,
    period_id: periodId,
    reporting_period: reportingPeriod,
    payment_date: input.payment_date,
    employee: {
      employee_id: input.employee.employee_id,
      personal_identity_number: input.employee.personal_identity_number,
    },
    cash_compensation_ore: grossPayOre,
    tax_withheld_ore: taxWithheldOre,
    employer_contribution_basis_ore: employerContributionBasisOre,
    employer_contribution_ore: employerContributionOre,
  };

  const evidenceDocumentIds = documentIds ?? [documentId];
  const accountingFacts = {
    contract_version: "1.0",
    schema_version: PAYROLL_SCHEMA_VERSION,
    company_id: companyId,
    period_id: periodId,
    status: "proposed",
    currency: "SEK",
    source_payroll_result_ref: sourceResultRef,
    expense_facts: [
      {
        fact_id: `payroll:${periodId}:${input.employee.employee_id}:gross-cash-salary`,
        kind: "gross_cash_salary",
        employee_id: input.employee.employee_id,
        amount_ore: grossPayOre,
        evidence_document_ids: evidenceDocumentIds,
      },
      {
        fact_id: `payroll:${periodId}:${input.employee.employee_id}:employer-contribution-expense`,
        kind: "employer_contribution",
        employee_id: input.employee.employee_id,
        amount_ore: employerContributionOre,
        evidence_document_ids: evidenceDocumentIds,
      },
    ],
    liability_facts: [
      {
        fact_id: `payroll:${periodId}:${input.employee.employee_id}:withholding-tax-payable`,
        kind: "withholding_tax_payable",
        creditor: "skatteverket",
        reporting_period: reportingPeriod,
        amount_ore: taxWithheldOre,
        evidence_document_ids: evidenceDocumentIds,
      },
      {
        fact_id: `payroll:${periodId}:${input.employee.employee_id}:employer-contribution-payable`,
        kind: "employer_contribution_payable",
        creditor: "skatteverket",
        reporting_period: reportingPeriod,
        amount_ore: employerContributionOre,
        evidence_document_ids: evidenceDocumentIds,
      },
      {
        fact_id: paymentItemId,
        kind: "net_salary_payable",
        party_ref: input.employee.employee_id,
        party_name: input.employee.name,
        due_date: input.payment_date,
        amount_ore: netPayOre,
        evidence_document_ids: evidenceDocumentIds,
      },
    ],
  };

  const currentYearToDate = {
    reporting_year: reportingPeriod.slice(0, 4),
    gross_pay_ore: grossPayOre,
    tax_withheld_ore: taxWithheldOre,
    employer_contribution_basis_ore: employerContributionBasisOre,
    employer_contribution_ore: employerContributionOre,
    net_pay_ore: netPayOre,
  };
  const yearToDate = mergeYearToDate(priorYearToDate, currentYearToDate);

  const result = {
    unsupported: null,
    amounts: {
      fixed_monthly_salary_ore: fixedSalaryOre,
      absence_deduction_ore: absenceDeductionOre,
      correction_ore: correctionOre,
      gross_pay_ore: grossPayOre,
      tax_withheld_ore: taxWithheldOre,
      employer_contribution_basis_ore: employerContributionBasisOre,
      employer_contribution_ore: employerContributionOre,
      net_pay_ore: netPayOre,
    },
    payslip,
    payment,
    agi,
    accountingFacts,
    employeeState: {
      employee_id: input.employee.employee_id,
      name: input.employee.name,
      personal_identity_number: input.employee.personal_identity_number,
      year_to_date: yearToDate,
      last_payment_date: input.payment_date,
      last_payroll_result_ref: sourceResultRef,
    },
  };
  return payrollToV2(result, "SEK");
}

function roundBasisPoints(amountOre, basisPoints) {
  return roundRatio(amountOre, basisPoints, 10_000);
}

function roundRatio(amountOre, numerator, denominator) {
  return (amountOre * BigInt(numerator) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
}

function safeSum(values, label) {
  return values.reduce((sum, value) => safeAdd(sum, value, label), 0n);
}

function safeAdd(left, right, label) {
  if (typeof left !== "bigint" || typeof right !== "bigint") throw new TypeError(`${label} must use exact minor units`);
  return left + right;
}

function mergeYearToDate(previous, current) {
  if (!previous || previous.reporting_year !== current.reporting_year) return current;
  return {
    reporting_year: current.reporting_year,
    gross_pay_ore: safeAdd(previous.gross_pay_ore, current.gross_pay_ore, "year-to-date gross pay"),
    tax_withheld_ore: safeAdd(previous.tax_withheld_ore, current.tax_withheld_ore, "year-to-date tax"),
    employer_contribution_basis_ore: safeAdd(
      previous.employer_contribution_basis_ore,
      current.employer_contribution_basis_ore,
      "year-to-date employer contribution basis",
    ),
    employer_contribution_ore: safeAdd(
      previous.employer_contribution_ore,
      current.employer_contribution_ore,
      "year-to-date employer contribution",
    ),
    net_pay_ore: safeAdd(previous.net_pay_ore, current.net_pay_ore, "year-to-date net pay"),
  };
}
