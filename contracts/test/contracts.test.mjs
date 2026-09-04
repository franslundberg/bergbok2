import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractError,
  ISO_4217_SOURCE,
  assertMoney,
  assertConsolidationCase,
  assertPeriod,
  createContentRef,
  createModuleOutcome,
  createStateEnvelope,
  currencyMinorUnits,
  formatMoney,
  parseMoney,
  proposalDigest,
  sealContent,
  verifySealedContent,
} from "../src/index.mjs";

test("canonical Money follows ISO 4217 currency exponents", () => {
  assert.deepEqual(parseMoney("48406.36 SEK"), { currency: "SEK", exponent: 2, minorUnits: 4_840_636n });
  assert.deepEqual(parseMoney("-1.234 KWD"), { currency: "KWD", exponent: 3, minorUnits: -1_234n });
  assert.deepEqual(parseMoney("1000 JPY"), { currency: "JPY", exponent: 0, minorUnits: 1_000n });
  assert.deepEqual(parseMoney("1.2345 CLF"), { currency: "CLF", exponent: 4, minorUnits: 12_345n });
  assert.equal(formatMoney(4_840_636n, "SEK"), "48406.36 SEK");
  assert.equal(formatMoney(-1_234n, "KWD"), "-1.234 KWD");
  assert.equal(formatMoney(1_000n, "JPY"), "1000 JPY");
  assert.equal(formatMoney(12_345n, "CLF"), "1.2345 CLF");
  assert.equal(formatMoney(123456789012345678901234567890n, "SEK"), "1234567890123456789012345678.90 SEK");
  assert.equal(currencyMinorUnits("SEK"), 2);
  assert.equal(currencyMinorUnits("BOV"), 2);
  assert.equal(currencyMinorUnits("USN"), 2);
  assert.equal(assertMoney("0.00 SEK", { expectedCurrency: "SEK" }), true);
  assert.equal(ISO_4217_SOURCE.published, "2026-01-01");
  assert.match(ISO_4217_SOURCE.sha256, /^[a-f0-9]{64}$/);
});

test("canonical Money round-trips exact bigint minor units", () => {
  for (const [currency, values] of Object.entries({
    JPY: [0n, -1n, 999999999999999999999999n],
    SEK: [0n, 1n, -1n, 4_840_636n, -999999999999999999999999n],
    KWD: [0n, 1n, -1_234n],
    CLF: [0n, 12_345n, -999_999n],
  })) {
    for (const minorUnits of values) {
      assert.equal(parseMoney(formatMoney(minorUnits, currency)).minorUnits, minorUnits);
    }
  }
});

test("canonical Money rejects non-canonical and unsupported values", () => {
  for (const value of [
    100,
    "48406 SEK",
    "48406.360 SEK",
    "48406.36SEK",
    "48 406.36 SEK",
    "48406,36 SEK",
    "+48406.36 SEK",
    "048406.36 SEK",
    "-0.00 SEK",
    "1e2 SEK",
    "1000.00 JPY",
    "1.00 XAU",
    "1.00 BGN",
    "1.00 MRO",
    "-0 JPY",
  ]) assert.throws(() => assertMoney(value));
  assert.throws(() => assertMoney("1.00 USD", { expectedCurrency: "SEK" }), /Expected Money in SEK/);
});

test("content references are independent of object key order", () => {
  const left = createContentRef({ schemaId: "test", stableId: "x", version: 1, payload: { b: 2, a: 1 } });
  const right = createContentRef({ schemaId: "test", stableId: "x", version: 1, payload: { a: 1, b: 2 } });
  assert.deepEqual(left, right);
});

test("sealed content detects mutation", () => {
  const sealed = sealContent({ schemaId: "test", stableId: "x", version: 1, payload: { amount: 10 } });
  verifySealedContent(sealed);
  const altered = structuredClone(sealed);
  altered.payload.amount = 11;
  assert.throws(() => verifySealedContent(altered), ContractError);
});

test("the proposal digest binds review and provenance as well as state", () => {
  const state = createStateEnvelope({ companyId: "demo", sequence: 0, core: {}, domains: {} });
  const caseBundle = sealContent({
    schemaId: "se.bergbok.consolidation-case",
    stableId: "demo:2026-01:bookkeeping",
    version: 1,
    payload: { marker: true },
  });
  const base = createModuleOutcome({
    kind: "proposal",
    domain: "bookkeeping",
    caseRef: caseBundle.ref,
    projectedState: state,
    review: { summary: "looks right" },
    provenance: { module_version: "1" },
  });
  const changed = createModuleOutcome({
    kind: "proposal",
    domain: "bookkeeping",
    caseRef: caseBundle.ref,
    projectedState: state,
    review: { summary: "different review" },
    provenance: { module_version: "1" },
  });
  assert.notEqual(proposalDigest(base), proposalDigest(changed));
});

test("non-proposal outcomes must explain what stops processing", () => {
  const caseBundle = sealContent({ schemaId: "case", stableId: "case", version: 1, payload: {} });
  assert.throws(() => createModuleOutcome({
    kind: "needs_input",
    domain: "bookkeeping",
    caseRef: caseBundle.ref,
  }), /at least one question/);
  assert.throws(() => createModuleOutcome({
    kind: "out_of_scope",
    domain: "payroll",
    caseRef: caseBundle.ref,
  }), /at least one reason/);
});

test("Period kinds have canonical date shapes", () => {
  assert.equal(assertPeriod({ id: "Start", kind: "start", end: "2026-05-11" }), true);
  assert.equal(assertPeriod({ id: "Import", kind: "import", end: "2026-05-31" }), true);
  assert.equal(assertPeriod({ id: "week-23", kind: "ordinary", start: "2026-06-01", end: "2026-06-07" }), true);
  assert.throws(() => assertPeriod({ id: "Opening", kind: "opening", end: "2026-05-31" }), /start, import, or ordinary/);
  assert.throws(() => assertPeriod({ id: "Start", kind: "start", start: "2026-05-01", end: "2026-05-11" }), /must not have a lower bound/);
  assert.throws(() => assertPeriod({ id: "Import", kind: "import" }), /Period.end/);
  assert.throws(() => assertPeriod({ id: "custom", kind: "ordinary", end: "2026-06-30" }), /Period.start/);
  assert.throws(() => assertPeriod({ id: "custom", kind: "ordinary", start: "2026-07-01", end: "2026-06-30" }), /starts after/);
  assert.throws(() => assertPeriod({ id: "custom", kind: "ordinary", start_date: "2026-06-01", end: "2026-06-30" }), /canonical start and end/);
});

test("a ConsolidationCase requires the canonical Period contract", () => {
  const previous = createStateEnvelope({ companyId: "demo", sequence: 0, core: {}, domains: {} });
  const docset = sealContent({ schemaId: "se.bergbok.docset", stableId: "demo:start:docset", version: 1, payload: { documents: [] } });
  const make = (period) => sealContent({
    schemaId: "se.bergbok.consolidation-case",
    stableId: "demo:start:bookkeeping",
    version: 1,
    payload: { contract_version: "1.0", company_id: "demo", domain: "bookkeeping", period, docset, previous_state: previous, effective_policies: {}, upstream_results: [] },
  });
  assert.equal(assertConsolidationCase(make({ id: "Start", kind: "start", end: "2026-05-11" })), true);
  assert.throws(() => assertConsolidationCase(make({ id: "Opening", kind: "opening", end: "2026-05-31" })), /start, import, or ordinary/);
});
