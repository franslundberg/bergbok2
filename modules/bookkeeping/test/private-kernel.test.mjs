import assert from "node:assert/strict";
import test from "node:test";

import {
  assignVerificationNumbers,
  combineBalances,
  normalizeBalances,
} from "../src/private/ledger.mjs";

test("private Accounting Kernel helpers are pure and preserve verification continuity", () => {
  const transactions = [{
    source_id: "later",
    date: "2026-03-20",
    description: "Later",
    lines: [],
    evidence_document_ids: [],
    origin: "test",
    _source_order: 0,
  }, {
    source_id: "earlier",
    date: "2026-03-10",
    description: "Earlier",
    lines: [],
    evidence_document_ids: [],
    origin: "test",
    _source_order: 1,
  }];
  const before = structuredClone(transactions);
  const numbered = assignVerificationNumbers(transactions, { series: "A", previousLastNumber: 9 });
  assert.deepEqual(numbered.map((item) => [item.source_id, item.verification_id]), [
    ["earlier", "A10"],
    ["later", "A11"],
  ]);
  assert.deepEqual(transactions, before);

  const opening = normalizeBalances([
    { account: "1930", account_name: "Bank", debit_ore: 10000n, credit_ore: 0n },
    { account: "2081", account_name: "Share capital", debit_ore: 0n, credit_ore: 10000n },
  ]);
  assert.equal(opening.issues.length, 0);
  assert.deepEqual(combineBalances(opening.balances, [
    { account: "1930", account_name: "Bank", debit_ore: 0n, credit_ore: 2500n },
    { account: "4000", account_name: "Purchases", debit_ore: 2500n, credit_ore: 0n },
  ]), [
    { account: "1930", account_name: "Bank", debit_ore: 7500n, credit_ore: 0n },
    { account: "2081", account_name: "Share capital", debit_ore: 0n, credit_ore: 10000n },
    { account: "4000", account_name: "Purchases", debit_ore: 2500n, credit_ore: 0n },
  ]);
});
