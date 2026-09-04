import { formatMoney, parseMoney } from "../../../../contracts/src/index.mjs";

export const PAYROLL_SCHEMA_VERSION = "2.0";
export const LEGACY_PAYROLL_SCHEMA_VERSION = "1.0";

const V2_TO_INTERNAL = Object.freeze({
  amount: "amount_ore",
  deduction: "deduction_ore",
  fixed_monthly_salary: "fixed_monthly_salary_ore",
  absence_deduction: "absence_deduction_ore",
  correction: "correction_ore",
  gross_pay: "gross_pay_ore",
  tax_withheld: "tax_withheld_ore",
  employer_contribution_basis: "employer_contribution_basis_ore",
  employer_contribution: "employer_contribution_ore",
  net_pay: "net_pay_ore",
  cash_compensation: "cash_compensation_ore",
});

export function adaptPayrollInput(value, currency = "SEK") {
  const version = value?.schema_version;
  if (![LEGACY_PAYROLL_SCHEMA_VERSION, PAYROLL_SCHEMA_VERSION].includes(version)) {
    throw new TypeError("Payroll input must use schema version 1.0 or 2.0");
  }
  return toInternal(value, currency, version, "payroll_input");
}

export function adaptPayrollState(value, currency = "SEK") {
  const version = value?.schema_version ?? LEGACY_PAYROLL_SCHEMA_VERSION;
  if (![LEGACY_PAYROLL_SCHEMA_VERSION, PAYROLL_SCHEMA_VERSION].includes(version)) {
    throw new TypeError("Payroll state must use schema version 1.0 or 2.0");
  }
  return toInternal(value, currency, version, "previous_state.domains.payroll");
}

export function payrollToV2(value, currency = "SEK") {
  if (typeof value === "bigint") throw new TypeError("Unqualified bigint cannot cross the Payroll boundary");
  if (Array.isArray(value)) return value.map((item) => payrollToV2(item, currency));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("_ore")) result[key.slice(0, -4)] = mapPortableLeaves(child, currency);
    else result[key] = payrollToV2(child, currency);
  }
  return result;
}

function toInternal(value, currency, version, path) {
  if (Array.isArray(value)) return value.map((item, index) => toInternal(item, currency, version, `${path}[${index}]`));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (version === PAYROLL_SCHEMA_VERSION && key.endsWith("_ore")) {
      throw new TypeError(`${path}.${key} is a legacy money field and cannot appear in schema 2.0`);
    }
    if (version === LEGACY_PAYROLL_SCHEMA_VERSION && Object.hasOwn(V2_TO_INTERNAL, key)) {
      throw new TypeError(`${path}.${key} is a schema 2.0 money field and cannot appear in schema 1.0`);
    }
    if (version === PAYROLL_SCHEMA_VERSION && Object.hasOwn(V2_TO_INTERNAL, key)) {
      result[V2_TO_INTERNAL[key]] = mapMoneyLeaves(child, currency, `${path}.${key}`);
    } else if (version === LEGACY_PAYROLL_SCHEMA_VERSION && key.endsWith("_ore")) {
      result[key] = mapLegacyLeaves(child, `${path}.${key}`);
    } else {
      result[key] = toInternal(child, currency, version, `${path}.${key}`);
    }
  }
  return result;
}

function mapMoneyLeaves(value, currency, path) {
  if (value === null) return null;
  if (typeof value === "string") return parseMoney(value, { expectedCurrency: currency }).minorUnits;
  if (Array.isArray(value)) return value.map((item, index) => mapMoneyLeaves(item, currency, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapMoneyLeaves(child, currency, `${path}.${key}`)]));
  }
  throw new TypeError(`${path} must contain canonical Money`);
}

function mapLegacyLeaves(value, path) {
  if (value === null) return null;
  if (Number.isSafeInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map((item, index) => mapLegacyLeaves(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapLegacyLeaves(child, `${path}.${key}`)]));
  }
  throw new TypeError(`${path} must contain safe integer legacy amounts`);
}

function mapPortableLeaves(value, currency) {
  if (value === null) return null;
  if (typeof value === "bigint" || Number.isSafeInteger(value)) return formatMoney(value, currency);
  if (Array.isArray(value)) return value.map((item) => mapPortableLeaves(item, currency));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapPortableLeaves(child, currency)]));
  }
  throw new TypeError("Internal Payroll money must use integer minor units");
}
