import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { main } from "../demo/cli.mjs";
import { DEFAULT_APPROVER, periodFor, resolveApprover } from "../demo/workflow.mjs";

test("the Fiktiv AB demo defaults approval to Filippa Stark", () => {
  assert.equal(DEFAULT_APPROVER, "Filippa Stark");
  assert.equal(resolveApprover(), "Filippa Stark");
  assert.equal(resolveApprover("   "), "Filippa Stark");
  assert.equal(resolveApprover("Future Co-worker"), "Future Co-worker");
});

test("the demo help documents Import and fixture Period runs", async () => {
  const messages = [];
  const original = console.log;
  console.log = (...parts) => messages.push(parts.join(" "));
  try {
    assert.equal(await main(["--help"]), 0);
  } finally {
    console.log = original;
  }
  assert.match(messages.join("\n"), /\[--actor NAME\]/);
  assert.match(messages.join("\n"), /default: Filippa Stark/);
  assert.match(messages.join("\n"), /import --start-date YYYY-MM-DD --docset DIR/);
  assert.match(messages.join("\n"), /run --workspace DIR --period ID/);
  assert.match(messages.join("\n"), /--period-start YYYY-MM-DD --period-end YYYY-MM-DD/);
  assert.match(messages.join("\n"), /Uppstart, 2026-05,[\s\S]*2026-08/);
});

test("the Fiktiv fixture catalog publishes July and August", async () => {
  const catalog = JSON.parse(await readFile(new URL("../demo/fixtures/fiktiv-ab/periods.json", import.meta.url), "utf8"));
  assert.deepEqual(catalog.periods.map(({ id, kind, start, end, documents }) => ({
    id,
    kind,
    ...(start ? { start } : {}),
    end,
    documents,
  })), [
    { id: "Uppstart", kind: "start", end: "2026-05-11", documents: "Uppstart" },
    { id: "2026-05", kind: "ordinary", start: "2026-05-12", end: "2026-05-31", documents: "2026-05" },
    { id: "2026-06", kind: "ordinary", start: "2026-06-01", end: "2026-06-30", documents: "2026-06" },
    { id: "2026-07", kind: "ordinary", start: "2026-07-01", end: "2026-07-31", documents: "2026-07" },
    { id: "2026-08", kind: "ordinary", start: "2026-08-01", end: "2026-08-31", documents: "2026-08" },
  ]);
});

test("catalogued Periods use fixture dates while custom Periods require explicit dates", () => {
  const initial = { id: "Uppstart", kind: "start", end: "2026-05-11" };
  const workspace = {
    initial_period: initial,
    demo_periods: [initial, { id: "2026-06", kind: "ordinary", start: "2026-06-01", end: "2026-06-30" }],
  };
  assert.deepEqual(periodFor(workspace, { period: "2026-06" }), workspace.demo_periods[1]);
  assert.deepEqual(periodFor(workspace, { period: "2026-06", periodStart: "2026-06-01", periodEnd: "2026-06-30" }), workspace.demo_periods[1]);
  assert.throws(() => periodFor(workspace, { period: "2026-06", periodStart: "2026-06-02", periodEnd: "2026-06-30" }), /supplied dates do not match/);
  assert.deepEqual(periodFor(workspace, { period: "week-23", periodStart: "2026-06-01", periodEnd: "2026-06-07" }), {
    id: "week-23", kind: "ordinary", start: "2026-06-01", end: "2026-06-07",
  });
  assert.throws(() => periodFor(workspace, { period: "week-23" }), /requires --period-start and --period-end/);
  assert.throws(() => periodFor(workspace, { period: "../escape", periodStart: "2026-06-01", periodEnd: "2026-06-07" }), /filesystem-safe/);
  assert.throws(() => periodFor(workspace, { period: "reverse", periodStart: "2026-06-08", periodEnd: "2026-06-07" }), /must not be after/);
});

test("Import requires both a Bergbok Start Date and source Docset", async () => {
  const messages = [];
  const original = console.error;
  console.error = (...parts) => messages.push(parts.join(" "));
  try {
    assert.equal(await main(["import"]), 2);
  } finally {
    console.error = original;
  }
  assert.match(messages.join("\n"), /requires --start-date/);
});
