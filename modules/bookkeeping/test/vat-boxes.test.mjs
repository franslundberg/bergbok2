import assert from "node:assert/strict";
import test from "node:test";

import { BAS_2026, BAS_2026_EXCLUDED } from "../src/private/vat/bas-2026.mjs";
import { computeDeclarationBoxes } from "../src/private/vat/boxes.mjs";

// Balances the way the ledger carries them: öre as bigint, debit and credit
// kept apart.  The helper takes kronor because the book's examples are in
// kronor, which keeps the cases readable next to the page they come from.
function balances(rows) {
  return rows.map(([account, debit, credit]) => ({
    account,
    account_name: account,
    debit_ore: BigInt(Math.round(debit * 100)),
    credit_ore: BigInt(Math.round(credit * 100)),
  }));
}

function boxesFor(rows, baseline = []) {
  return computeDeclarationBoxes({
    baselineBalances: balances(baseline),
    closingBalances: balances(rows),
  });
}

// Every case below is a worked example from Bokföringsboken 2026, printed pages
// 748 to 750, where the book states both the bookkeeping and the boxes it
// should produce.  That makes them stronger than cases we would invent.

test("book example A:1, domestic sales at 25 and 6 percent, fills rutorna 05, 10 and 12", () => {
  const { boxes } = boxesFor([
    ["3001", 0, 100_000],
    ["3003", 0, 10_000],
    ["2611", 0, 25_000],
    ["2631", 0, 600],
  ]);

  assert.equal(boxes["05"], 110_000n);
  assert.equal(boxes["10"], 25_000n);
  assert.equal(boxes["11"], 0n);
  assert.equal(boxes["12"], 600n);
  assert.equal(boxes["49"], 25_600n);
});

test("book example C:1, reverse charge in construction, fills rutorna 24, 30 and 48", () => {
  const { boxes } = boxesFor([
    ["4425", 50_000, 0],
    ["2647", 12_500, 0],
    ["2614", 0, 12_500],
  ]);

  assert.equal(boxes["24"], 50_000n);
  assert.equal(boxes["30"], 12_500n);
  assert.equal(boxes["48"], 12_500n);
  // Output and input cancel, which is the point of reverse charge with full
  // deduction.
  assert.equal(boxes["49"], 0n);
});

test("book example C:1 seen from the seller, fills ruta 41 and no output VAT", () => {
  const { boxes } = boxesFor([["3231", 0, 50_000]]);

  assert.equal(boxes["41"], 50_000n);
  assert.equal(boxes["10"], 0n);
  assert.equal(boxes["49"], 0n);
});

test("book example C:2, EU acquisition of goods, fills rutorna 20, 30 and 48", () => {
  const { boxes } = boxesFor([
    ["4515", 100_000, 0],
    ["2645", 25_000, 0],
    ["2614", 0, 25_000],
  ]);

  assert.equal(boxes["20"], 100_000n);
  assert.equal(boxes["30"], 25_000n);
  assert.equal(boxes["48"], 25_000n);
  assert.equal(boxes["49"], 0n);
});

test("book example C:3, triangular trade, fills rutorna 37 and 38", () => {
  const { boxes } = boxesFor([
    ["4512", 100_000, 0],
    ["3106", 0, 125_000],
  ]);

  assert.equal(boxes["37"], 100_000n);
  assert.equal(boxes["38"], 125_000n);
  // Neither side carries VAT, so nothing reaches ruta 49.
  assert.equal(boxes["49"], 0n);
});

test("import of goods fills the base in ruta 50 and the VAT in rutorna 60 and 48", () => {
  const { boxes } = boxesFor([
    ["4545", 3_009, 0],
    ["4549", 0, 3_009],
    ["2645", 751, 0],
    ["2615", 0, 751],
  ]);

  assert.equal(boxes["50"], 3_009n);
  assert.equal(boxes["60"], 751n);
  assert.equal(boxes["48"], 751n);
  assert.equal(boxes["49"], 0n);
});

test("a box is the movement over the cycle, not the closing balance", () => {
  // 4531 is a cost account that runs all year, so a quarter that added 1 749,35
  // on top of an earlier 5 000 must report only the quarter's movement.
  const { boxes } = boxesFor(
    [["4531", 6_749.35, 0]],
    [["4531", 5_000, 0]],
  );

  assert.equal(boxes["22"], 1_749n);
});

test("an exact account beats a range: 3105 is ruta 36, not ruta 05", () => {
  const { boxes } = boxesFor([
    ["3001", 0, 10_000],
    ["3105", 0, 4_000],
    ["3108", 0, 2_000],
  ]);

  assert.equal(boxes["05"], 10_000n, "only the unclaimed 3xxx account reaches ruta 05");
  assert.equal(boxes["36"], 4_000n);
  assert.equal(boxes["35"], 2_000n);
});

test("vinstmarginalbeskattning reports the margin, not the turnover", () => {
  // Printed page 748, example A:3. The sale sits on 321x and the matching cost
  // on 421x, so ruta 07 is the difference.
  const { boxes } = boxesFor([
    ["3211", 0, 30_000],
    ["4211", 20_000, 0],
  ]);

  assert.equal(boxes["07"], 10_000n);
});

test("vilande moms is not declared until the advance is paid", () => {
  const { boxes, unmapped } = boxesFor([["2618", 0, 5_000]]);

  assert.equal(boxes["10"], 0n);
  assert.deepEqual(unmapped, [], "an excluded account is a decision, not a gap");
});

test("rutorna 06 and 42 are reported as zero with a stated reason", () => {
  const { boxes, notes } = boxesFor([]);

  assert.equal(boxes["06"], 0n);
  assert.equal(boxes["42"], 0n);
  const undrivable = notes.filter((note) => note.kind === "not_derivable").map((note) => note.box);
  assert.deepEqual(undrivable.sort(), ["06", "42"]);
  assert.ok(notes.some((note) => note.box === "05" && note.kind === "partial"));
});

test("a VAT account that reaches no box is reported rather than silently dropped", () => {
  const { unmapped } = boxesFor([["2699", 0, 1_234]]);

  assert.deepEqual(unmapped, [{ account: "2699", movement_ore: -123_400n }]);
});

test("declared boxes are whole kronor", () => {
  const { boxes } = boxesFor([["2611", 0, 1_188.34]]);

  assert.equal(boxes["10"], 1_188n);
});

test("ruta 49 is every output box less ruta 48", () => {
  const { boxes } = boxesFor([
    ["2611", 0, 1_000],
    ["2624", 0, 200],
    ["2615", 0, 300],
    ["2641", 400, 0],
  ]);

  assert.equal(boxes["10"], 1_000n);
  assert.equal(boxes["31"], 200n);
  assert.equal(boxes["60"], 300n);
  assert.equal(boxes["48"], 400n);
  assert.equal(boxes["49"], 1_100n);
});

test("output VAT with no beskattningsunderlag behind it is reported", () => {
  // The real case from a demo run: import VAT booked on 2615 while the base
  // never reached 4545, so ruta 60 carried 751 kr and ruta 50 stood at zero.
  // The declaration would be accepted and still be wrong.
  const { boxes, inconsistencies } = boxesFor([
    ["2645", 751, 0],
    ["2615", 0, 751],
  ]);

  assert.equal(boxes["60"], 751n);
  assert.equal(boxes["50"], 0n);
  assert.deepEqual(inconsistencies, [
    { output_box: "60", base_boxes: ["50"], label: "import av varor" },
  ]);
});

test("reverse charge without its base is reported the same way", () => {
  const { inconsistencies } = boxesFor([
    ["2645", 250, 0],
    ["2614", 0, 250],
  ]);

  assert.deepEqual(inconsistencies.map((gap) => gap.output_box), ["30"]);
});

test("a complete reverse-charge posting raises nothing", () => {
  const { inconsistencies } = boxesFor([
    ["4531", 1000, 0],
    ["2645", 250, 0],
    ["2614", 0, 250],
    ["2893", 0, 1000],
  ]);

  assert.deepEqual(inconsistencies, []);
});

test("exempt sales carry no output VAT, so they are never reported as a gap", () => {
  // Rutorna 35 to 42 have no paired output box at all, which is why only
  // reverse charge and import are checked.
  const { boxes, inconsistencies } = boxesFor([
    ["3108", 0, 5_000],
    ["3105", 0, 2_000],
  ]);

  assert.equal(boxes["35"], 5_000n);
  assert.equal(boxes["36"], 2_000n);
  assert.deepEqual(inconsistencies, []);
});

// Structural checks over the mapping itself, which catch a typo in the data
// without anyone reading 51 account numbers.

test("the mapping names each account once and each box once", () => {
  const seenAccounts = new Map();
  const seenBoxes = new Set();
  for (const entry of BAS_2026) {
    assert.ok(!seenBoxes.has(entry.box), `box ${entry.box} appears twice`);
    seenBoxes.add(entry.box);
    for (const account of entry.accounts ?? []) {
      assert.ok(!seenAccounts.has(account), `account ${account} is claimed by two boxes`);
      seenAccounts.set(account, entry.box);
    }
    assert.ok(/^\d{2}$/.test(entry.box), `box ${entry.box} is not two digits`);
    for (const account of entry.accounts ?? []) {
      assert.ok(/^\d{4}$/.test(account), `account ${account} is not four digits`);
    }
  }
  for (const account of Object.keys(BAS_2026_EXCLUDED)) {
    assert.ok(!seenAccounts.has(account), `${account} is both mapped and excluded`);
  }
});

test("every box carries a role, and only non-manual boxes carry accounts", () => {
  for (const entry of BAS_2026) {
    assert.ok(["output", "input", "base", "manual"].includes(entry.role), entry.box);
    if (entry.role === "manual") {
      assert.equal(entry.accounts, undefined, `manual box ${entry.box} must name no accounts`);
      assert.ok(entry.reason, `manual box ${entry.box} must say why`);
      continue;
    }
    assert.ok(["debit", "credit"].includes(entry.side), `box ${entry.box} has no side`);
    assert.ok(
      (entry.accounts ?? []).length || (entry.prefixes ?? []).length,
      `box ${entry.box} matches nothing`,
    );
  }
});

test("exactly one box carries the input role, since ruta 49 subtracts it", () => {
  const inputs = BAS_2026.filter((entry) => entry.role === "input");
  assert.deepEqual(inputs.map((entry) => entry.box), ["48"]);
});

test("an empty ledger produces every box as zero", () => {
  const { boxes } = boxesFor([]);

  assert.equal(Object.keys(boxes).length, BAS_2026.length + 1, "every box plus ruta 49");
  for (const [box, value] of Object.entries(boxes)) {
    assert.equal(value, 0n, `box ${box}`);
  }
});
