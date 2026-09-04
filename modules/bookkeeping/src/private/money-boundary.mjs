import { formatMoney, parseMoney } from "../../../../contracts/src/index.mjs";

export const BOOKKEEPING_SCHEMA_VERSION = "2.0";
export const LEGACY_BOOKKEEPING_SCHEMA_VERSION = "1.0";

const V2_TO_INTERNAL = Object.freeze({
  debit: "debit_ore",
  credit: "credit_ore",
  amount: "amount_ore",
  original_amount: "original_amount_ore",
  remaining: "remaining_ore",
  ledger_closing_balance: "ledger_closing_balance_ore",
  external_closing_balance: "external_closing_balance_ore",
  by_kind: "by_kind_ore",
});

export function adaptBookkeepingInput(input, currency) {
  assertVersion(input, "Bookkeeping input");
  return toInternal(input, currency, input.schema_version, "bookkeeping_input");
}

export function adaptBookkeepingState(state, currency) {
  assertVersion(state, "Bookkeeping state");
  return toInternal(state, currency, state.schema_version, "previous_state.domains.bookkeeping");
}

export function bookkeepingToV2(value, currency) {
  return toPortable(value, currency);
}

function assertVersion(value, label) {
  if (!value || typeof value !== "object" || ![LEGACY_BOOKKEEPING_SCHEMA_VERSION, BOOKKEEPING_SCHEMA_VERSION].includes(value.schema_version)) {
    throw new TypeError(`${label} must use schema version 1.0 or 2.0`);
  }
}

function toInternal(value, currency, version, path) {
  if (Array.isArray(value)) return value.map((item, index) => toInternal(item, currency, version, `${path}[${index}]`));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (version === BOOKKEEPING_SCHEMA_VERSION && (key.endsWith("_ore") || key.endsWith("_sek"))) {
      throw new TypeError(`${path}.${key} is a legacy money field and cannot appear in schema 2.0`);
    }
    if (version === LEGACY_BOOKKEEPING_SCHEMA_VERSION && (Object.hasOwn(V2_TO_INTERNAL, key) || key === "declaration_boxes")) {
      throw new TypeError(`${path}.${key} is a schema 2.0 money field and cannot appear in schema 1.0`);
    }
    if (version === BOOKKEEPING_SCHEMA_VERSION && key === "declaration_boxes") {
      result.declaration_boxes_sek = child === null ? null : mapMoneyLeaves(child, currency, `${path}.${key}`, (minor) => {
        if (minor % 100n !== 0n) throw new TypeError(`${path}.${key} values must be whole SEK`);
        return minor / 100n;
      });
      continue;
    }
    if (version === BOOKKEEPING_SCHEMA_VERSION && Object.hasOwn(V2_TO_INTERNAL, key)) {
      result[V2_TO_INTERNAL[key]] = mapMoneyLeaves(child, currency, `${path}.${key}`, (minor) => minor);
      continue;
    }
    if (version === LEGACY_BOOKKEEPING_SCHEMA_VERSION && key.endsWith("_ore")) {
      result[key] = mapLegacyLeaves(child, `${path}.${key}`);
      continue;
    }
    if (version === LEGACY_BOOKKEEPING_SCHEMA_VERSION && key.endsWith("_sek")) {
      result[key] = mapLegacyLeaves(child, `${path}.${key}`);
      continue;
    }
    result[key] = toInternal(child, currency, version, `${path}.${key}`);
  }
  return result;
}

function toPortable(value, currency) {
  if (typeof value === "bigint") throw new TypeError("Unqualified bigint cannot cross the bookkeeping boundary");
  if (Array.isArray(value)) return value.map((item) => toPortable(item, currency));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "declaration_boxes_sek") {
      result.declaration_boxes = child === null ? null : mapPortableMoneyLeaves(child, currency, 100n);
    } else if (key.endsWith("_ore")) {
      result[key.slice(0, -4)] = mapPortableMoneyLeaves(child, currency, 1n);
    } else {
      result[key] = toPortable(child, currency);
    }
  }
  return result;
}

function mapMoneyLeaves(value, currency, path, map) {
  if (value === null) return null;
  if (typeof value === "string") return map(parseMoney(value, { expectedCurrency: currency }).minorUnits);
  if (Array.isArray(value)) return value.map((item, index) => mapMoneyLeaves(item, currency, `${path}[${index}]`, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapMoneyLeaves(child, currency, `${path}.${key}`, map)]));
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

function mapPortableMoneyLeaves(value, currency, multiplier) {
  if (value === null) return null;
  if (typeof value === "bigint" || Number.isSafeInteger(value)) return formatMoney(BigInt(value) * multiplier, currency);
  if (Array.isArray(value)) return value.map((item) => mapPortableMoneyLeaves(item, currency, multiplier));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapPortableMoneyLeaves(child, currency, multiplier)]));
  }
  throw new TypeError("Internal bookkeeping money must use integer minor units");
}
