// Derive the boxes of a momsdeklaration from the ledger.
//
// A box is the movement of its accounts over the VAT cycle, not their closing
// balance.  The two coincide for the 26-series, which the closing entry zeroes
// at every cycle, but not for the 3- and 4-series base accounts, which run for
// the whole year.  Taking the movement is what makes the base boxes right.
//
// The caller supplies both ends: the balances as the cycle opened and as it
// closed, before the closing entry itself is booked.

import { netBalanceForAccount, roundToWholeKrona } from "../ledger.mjs";
import { BAS_2026, BAS_2026_BOX_PAIRS, BAS_2026_EXCLUDED } from "./bas-2026.mjs";

// Boxes whose value is arithmetic over the others rather than a sum of
// accounts.
const COMPUTED_BOXES = Object.freeze({
  49: "Moms att betala eller få tillbaka",
});

// A VAT account that moved and reaches no box is a defect: every 26-series
// account belongs somewhere, or is listed as deliberately excluded.  The check
// stops there on purpose.  Widening it to the 3- and 4-series would flag every
// ordinary cost and revenue account, and the base boxes cannot be policed this
// way anyway, since most accounts in those ranges legitimately reach no box.
const VAT_ACCOUNT_PREFIX = "26";

export function computeDeclarationBoxes({
  baselineBalances = [],
  closingBalances = [],
  map = BAS_2026,
  excluded = BAS_2026_EXCLUDED,
  pairs = BAS_2026_BOX_PAIRS,
} = {}) {
  const movements = movementsOverCycle(baselineBalances, closingBalances);
  const index = buildIndex(map);

  // Resolve each account to its box once, then accumulate.
  const totals = new Map();
  const claimed = new Set();
  for (const [account, net] of movements) {
    const entry = matchFor(account, index);
    if (!entry) continue;
    claimed.add(account);
    const signed = entry.side === "credit" ? -net : net;
    totals.set(entry.box, (totals.get(entry.box) ?? 0n) + signed);
  }

  const boxes = {};
  for (const entry of map) {
    boxes[entry.box] = entry.role === "manual" ? 0n : roundToWholeKrona(totals.get(entry.box) ?? 0n);
  }

  boxes["49"] = sumByRole(map, boxes, "output") - (boxes["48"] ?? 0n);

  return {
    boxes,
    notes: notesFor(map),
    unmapped: unmappedAccounts(movements, claimed, excluded),
    inconsistencies: pairingGaps(boxes, pairs),
  };
}

// Output VAT with no beskattningsunderlag behind it. The declaration would be
// accepted and still be wrong, because Skatteverket is told the tax but not the
// amount it was charged on. Nothing else notices: the base sits on a 4-series
// account, and the unmapped check only watches the 26-series.
function pairingGaps(boxes, pairs) {
  const gaps = [];
  for (const pair of pairs) {
    const output = pair.outputs.find((box) => (boxes[box] ?? 0n) !== 0n);
    if (!output) continue;
    if (pair.bases.some((box) => (boxes[box] ?? 0n) !== 0n)) continue;
    gaps.push({
      output_box: output,
      base_boxes: [...pair.bases],
      label: pair.label,
    });
  }
  return gaps;
}

// The net movement per account over the cycle.  An account present at only one
// end still moved, so both ends contribute their account numbers.
function movementsOverCycle(baselineBalances, closingBalances) {
  const accounts = new Set([
    ...baselineBalances.map((row) => row.account),
    ...closingBalances.map((row) => row.account),
  ]);
  const movements = new Map();
  for (const account of accounts) {
    const net =
      netBalanceForAccount(closingBalances, account) - netBalanceForAccount(baselineBalances, account);
    if (net !== 0n) movements.set(account, net);
  }
  return movements;
}

// Most-specific-wins, resolved once per account.  Ruta 05 claims the whole 31xx
// range while 3105 belongs to ruta 36, so an exact account has to beat a prefix
// and a longer prefix has to beat a shorter one.
function buildIndex(map) {
  const exact = new Map();
  const prefixes = [];
  for (const entry of map) {
    for (const account of entry.accounts ?? []) exact.set(account, entry);
    for (const prefix of entry.prefixes ?? []) prefixes.push({ prefix, entry });
  }
  prefixes.sort((left, right) => right.prefix.length - left.prefix.length);
  return { exact, prefixes };
}

function matchFor(account, index) {
  const direct = index.exact.get(account);
  if (direct) return direct;
  return index.prefixes.find(({ prefix }) => account.startsWith(prefix))?.entry ?? null;
}

function sumByRole(map, boxes, role) {
  let total = 0n;
  for (const entry of map) {
    if (entry.role === role) total += boxes[entry.box] ?? 0n;
  }
  return total;
}

// Machine-readable reasons a box is not fully derived, so a report can say so
// in words rather than presenting a zero as a measurement.
function notesFor(map) {
  const notes = [];
  for (const entry of map) {
    if (entry.role === "manual") {
      notes.push({ box: entry.box, kind: "not_derivable", message: entry.reason });
    }
    if (entry.partial) {
      notes.push({ box: entry.box, kind: "partial", message: entry.partial });
    }
    if (entry.note) {
      notes.push({ box: entry.box, kind: "caveat", message: entry.note });
    }
    if (entry.proposed) {
      notes.push({
        box: entry.box,
        kind: "proposed_account",
        message: "kontot är ett förslag i BAS 2026, inte ett etablerat konto",
      });
    }
  }
  return notes;
}

// A gap that announces itself is safe; a silent zero is not.
function unmappedAccounts(movements, claimed, excluded) {
  const rows = [];
  for (const [account, net] of movements) {
    if (claimed.has(account)) continue;
    if (Object.hasOwn(excluded, account)) continue;
    if (!account.startsWith(VAT_ACCOUNT_PREFIX)) continue;
    rows.push({ account, movement_ore: net });
  }
  return rows.sort((left, right) => left.account.localeCompare(right.account));
}

export { COMPUTED_BOXES };

// The chart a company's policy names, resolved to a mapping.  Only BAS 2026
// exists so far; a second chart year would be a second entry here.
const CHARTS = Object.freeze({ "BAS-2026": BAS_2026 });

// A company's effective mapping: the published chart, with any box the policy
// overrides replaced wholesale.  Replacing rather than merging keeps an
// override readable on its own, without the reader having to hold the standard
// entry in their head to know what the company actually does.
export function resolveVatMap(policy) {
  const chart = CHARTS[policy?.chart];
  if (!chart) return null;
  const overrides = new Map((policy.box_overrides ?? []).map((entry) => [entry.box, entry]));
  if (overrides.size === 0) return chart;
  const merged = chart.map((entry) => overrides.get(entry.box) ?? entry);
  const known = new Set(chart.map((entry) => entry.box));
  for (const [box, entry] of overrides) {
    if (!known.has(box)) merged.push(entry);
  }
  return Object.freeze(merged);
}

export function chartNames() {
  return Object.keys(CHARTS);
}

// Every account the mapping claims, which is what a VAT line may use.
export function mappedVatAccounts(map) {
  const accounts = new Set();
  for (const entry of map) {
    for (const account of entry.accounts ?? []) {
      if (account.startsWith(VAT_ACCOUNT_PREFIX)) accounts.add(account);
    }
  }
  return accounts;
}

export function accountsForRole(map, role) {
  const accounts = [];
  for (const entry of map) {
    if (entry.role !== role) continue;
    accounts.push(...(entry.accounts ?? []));
  }
  return accounts.sort();
}

// The accounts a closing entry has to clear: every VAT account the mapping
// claims, on whichever side its box reports.
export function vatAccountSides(map) {
  const sides = new Map();
  for (const entry of map) {
    if (entry.role !== "output" && entry.role !== "input") continue;
    for (const account of entry.accounts ?? []) sides.set(account, entry.side);
  }
  return sides;
}
