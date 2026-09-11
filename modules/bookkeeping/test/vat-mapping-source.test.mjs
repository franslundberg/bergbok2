// Check the VAT mapping against the book it was taken from.
//
// The source is Bokföringsboken 2026, a licensed work, so the reference copy is
// gitignored under modules/bookkeeping/reference/ and these checks skip when it
// is absent.  They are a developer check on the data, not a portable one.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { BAS_2026 } from "../src/private/vat/bas-2026.mjs";

const REFERENCE = new URL("../reference/bokforingsboken-2026.md", import.meta.url);

function book() {
  try {
    return readFileSync(REFERENCE, "utf8");
  } catch {
    return null;
  }
}

const SKIP = book() === null ? { skip: "reference copy of the book is not present" } : {};

// Printed pages 743-745 hold the mapping sorted by account, 746-748 the same
// mapping sorted by box.  Page markers carry the book's own printed numbers.
function pagesOf(text) {
  const parts = text.split(/(<!-- p\. \d+ -->)/);
  const pages = new Map();
  for (let index = 1; index < parts.length; index += 2) {
    pages.set(Number(parts[index].match(/\d+/)[0]), parts[index + 1]);
  }
  return pages;
}

function mappingFromBook(text) {
  const pages = pagesOf(text);
  const pairs = new Map();
  const record = (account, box) => {
    const existing = pairs.get(account);
    assert.ok(
      existing === undefined || existing === box,
      `the book maps ${account} to both ruta ${existing} and ruta ${box}`,
    );
    pairs.set(account, box);
  };

  for (const page of [743, 744, 745]) {
    for (const line of (pages.get(page) ?? "").split("\n")) {
      const match = line.match(/^\s*(\d{4})\s+\S.*?\s{2,}(\d{2})\s*(?:\S.*)?$/);
      if (match) record(match[1], match[2]);
    }
  }
  for (const page of [746, 747, 748]) {
    for (const line of (pages.get(page) ?? "").split("\n")) {
      const match = line.match(/^\s*(\d{2})\s+\S.*?\s{2,}(\d{4})\s*(?:\S.*)?$/);
      if (match) record(match[2], match[1]);
    }
  }
  return pairs;
}

function ourMapping() {
  const pairs = new Map();
  for (const entry of BAS_2026) {
    for (const account of entry.accounts ?? []) pairs.set(account, entry.box);
  }
  return pairs;
}

test("every mapped account exists in the book", SKIP, () => {
  // Presence anywhere in the text, not a heading of its own: the book gives a
  // full entry to main accounts only, and names sub-accounts such as 4515 in
  // underkonto tables.  This still catches an account number that is a typo.
  const text = book();
  const present = new Set([...text.matchAll(/\b(\d{4})\b/g)].map((match) => match[1]));

  const missing = [...ourMapping().keys()].filter((account) => !present.has(account));
  assert.deepEqual(missing, [], "accounts we map that never appear in the book");
});

test("our mapping agrees with the book wherever the book states a pair", SKIP, () => {
  const fromBook = mappingFromBook(book());
  const ours = ourMapping();

  assert.ok(fromBook.size > 40, `only ${fromBook.size} pairs parsed from the book`);

  const disagreements = [];
  for (const [account, box] of fromBook) {
    const mine = ours.get(account);
    // 2640 and its sub-accounts reach ruta 48 through the note on 2647 rather
    // than through a row of their own, so the tables name only some of them.
    if (mine === undefined) {
      disagreements.push(`${account}: book says ruta ${box}, we map nothing`);
      continue;
    }
    if (mine !== box) disagreements.push(`${account}: book says ruta ${box}, we say ${mine}`);
  }
  assert.deepEqual(disagreements, []);
});
