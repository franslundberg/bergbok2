import assert from "node:assert/strict";
import test from "node:test";

import { BAS_2026_RESULT_GROUPS, buildResultReport } from "../src/index.mjs";
import {
  createContentRef,
  createStateEnvelope,
  sealContent,
} from "../../../contracts/src/index.mjs";

const COMPANY_ID = "fiktiv-ab";

const state = () =>
  createStateEnvelope({
    companyId: COMPANY_ID,
    sequence: 4,
    core: {
      organization: { name: "Fiktiv AB", organization_number: "559999-0008" },
      bookkeeping_start_date: "2026-05-12",
      policies: {
        currency: "SEK",
        fiscal_year: { start: "2026-01-01", end: "2026-12-31" },
      },
    },
    domains: {},
  });

const period = (month, start = `${month}-01`) => ({
  id: month,
  kind: "ordinary",
  start,
  end: new Date(`${month}-01T00:00:00Z`)
    .toISOString()
    .replace(
      /-01T.*$/,
      `-${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()}`,
    ),
});

const line = (account, accountName, debit, credit, currency = "SEK") => ({
  account,
  account_name: accountName,
  debit: `${debit} ${currency}`,
  credit: `${credit} ${currency}`,
});

const transaction = (month, id, lines) => ({
  verification_id: id,
  date: `${month}-15`,
  description: id,
  lines,
});

function approvedMonth(month, transactions, options = {}) {
  const definition =
    options.period ?? period(month, month === "2026-05" ? "2026-05-12" : undefined);
  const runRef = createContentRef({
    schemaId: "se.bergbok.consolidation-run",
    stableId: `${COMPANY_ID}:${month}:bookkeeping-run`,
    version: 1,
    payload: { month },
  });
  const snapshot = sealContent({
    schemaId: "se.bergbok.output-snapshot",
    schemaVersion: "2.0",
    stableId: `${COMPANY_ID}:${month}:snapshot`,
    version: 1,
    payload: {
      contract_version: "2.0",
      approval_status: options.approvalStatus ?? "approved",
      approval_receipt_ref: null,
      language: "sv",
      context: { company_id: COMPANY_ID, period: definition },
      run_ref: options.snapshotRunRef ?? runRef,
      proposal_digest: "test",
      recorded_at: "2026-09-01T10:00:00.000Z",
      outcome: {
        canonical_outputs: {
          period_delta: {
            schema_id: "se.bergbok.bookkeeping-period-delta",
            schema_version: "3.0",
            company_id: COMPANY_ID,
            period_id: definition.id,
            currency: options.currency ?? "SEK",
            transactions,
          },
        },
      },
    },
  });
  return { month, period: definition, run_ref: runRef, snapshot };
}

const value = (report, rowId, columnId) =>
  report.payload.rows.find(({ id }) => id === rowId)?.values?.[columnId];

test("monthly reports use credit minus debit, retain zero totals and qualify uncovered months", () => {
  const may = approvedMonth("2026-05", [
    transaction("2026-05", "A1", [
      line("1930", "Företagskonto", "100.00", "0.00"),
      line("3010", "Försäljning", "0.00", "100.00"),
    ]),
    transaction("2026-05", "A2", [
      line("6570", "Bankkostnader", "25.00", "0.00"),
      line("1930", "Företagskonto", "0.00", "25.00"),
    ]),
  ]);
  const report = buildResultReport({
    state: state(),
    periods: [may, { month: "2026-06", period: period("2026-06"), snapshot: null }],
    fromMonth: "2026-05",
    toMonth: "2026-06",
    layout: "monthly",
    recordedAt: "2026-09-10T10:00:00.000Z",
  });

  assert.equal(report.payload.coverage.status, "partially_covered");
  assert.deepEqual(report.payload.coverage.uncovered_months, ["2026-06"]);
  assert.equal(report.payload.columns[0].coverage_start, "2026-05-12");
  assert.equal(value(report, "account-3010", "2026-05"), "100.00 SEK");
  assert.equal(value(report, "account-6570", "2026-05"), "-25.00 SEK");
  assert.equal(value(report, "calculated_result", "2026-05"), "75.00 SEK");
  assert.equal(value(report, "calculated_result", "2026-06"), null);
  assert.equal(value(report, "total-operating_costs", "2026-05"), "-25.00 SEK");
  assert.equal(value(report, "total-financial", "2026-05"), "0.00 SEK");
  assert.equal(
    report.payload.rows.some(({ account }) => account === "1930"),
    false,
  );
  assert.deepEqual(
    report.payload.rows.filter(({ kind }) => kind === "account").map(({ account }) => account),
    ["3010", "6570"],
  );
});

test("period and accumulated columns use approved deltas and do not let 8999 erase calculated result", () => {
  const may = approvedMonth("2026-05", [
    transaction("2026-05", "A1", [
      line("1930", "Företagskonto", "100.00", "0.00"),
      line("3010", "Försäljning", "0.00", "100.00"),
    ]),
  ]);
  const august = approvedMonth("2026-08", [
    transaction("2026-08", "A2", [
      line("4010", "Varuinköp", "10.00", "0.00"),
      line("1930", "Företagskonto", "0.00", "10.00"),
    ]),
    transaction("2026-08", "A3", [
      line("2099", "Årets resultat", "90.00", "0.00"),
      line("8999", "Årets resultat", "0.00", "90.00"),
    ]),
  ]);
  const report = buildResultReport({
    state: state(),
    periods: [
      may,
      { month: "2026-06", period: period("2026-06"), snapshot: null },
      { month: "2026-07", period: period("2026-07"), snapshot: null },
      august,
    ],
    fromMonth: "2026-08",
    toMonth: "2026-08",
    layout: "period_accumulated",
  });

  assert.equal(value(report, "calculated_result", "period"), "-10.00 SEK");
  assert.equal(value(report, "calculated_result", "accumulated"), "90.00 SEK");
  assert.equal(value(report, "account-8999", "period"), "90.00 SEK");
  assert.equal(value(report, "account-8999", "accumulated"), "90.00 SEK");
  assert.equal(report.payload.columns[1].status, "partially_covered");
});

test("a wholly uncovered range is a successful qualified report with no amounts", () => {
  const report = buildResultReport({
    state: state(),
    periods: [{ month: "2026-09", period: period("2026-09"), run_ref: null, snapshot: null }],
    fromMonth: "2026-09",
    toMonth: "2026-09",
    layout: "period_accumulated",
  });

  assert.equal(report.payload.coverage.status, "not_covered");
  assert.equal(report.payload.coverage.covered_from, null);
  assert.equal(report.payload.coverage.covered_through, null);
  assert.equal(report.payload.columns[0].label, "september 2026");
  assert.equal(value(report, "calculated_result", "period"), null);
  assert.equal(value(report, "calculated_result", "accumulated"), null);
  assert.deepEqual(report.payload.source.approved_run_refs, []);
});

test("Fiktiv acceptance range covers May through August and leaves September uncovered", () => {
  const sources = [
    approvedMonth("2026-05", [
      transaction("2026-05", "A1", [
        line("1930", "Företagskonto", "100.00", "0.00"),
        line("3010", "Försäljning", "0.00", "100.00"),
      ]),
    ]),
    approvedMonth("2026-06", []),
    approvedMonth("2026-07", []),
    approvedMonth("2026-08", [
      transaction("2026-08", "A2", [
        line("4010", "Varuinköp", "10.00", "0.00"),
        line("1930", "Företagskonto", "0.00", "10.00"),
      ]),
    ]),
    { month: "2026-09", period: period("2026-09"), run_ref: null, snapshot: null },
  ];
  const monthly = buildResultReport({
    state: state(),
    periods: sources,
    fromMonth: "2026-05",
    toMonth: "2026-09",
    layout: "monthly",
  });
  assert.deepEqual(
    monthly.payload.columns.slice(0, 5).map(({ status }) => status),
    ["covered", "covered", "covered", "covered", "not_covered"],
  );
  assert.equal(value(monthly, "calculated_result", "2026-09"), null);
  assert.equal(value(monthly, "calculated_result", "total"), "90.00 SEK");

  const august = buildResultReport({
    state: state(),
    periods: sources.slice(0, 4),
    fromMonth: "2026-08",
    toMonth: "2026-08",
    layout: "period_accumulated",
  });
  assert.equal(value(august, "calculated_result", "period"), "-10.00 SEK");
  assert.equal(value(august, "calculated_result", "accumulated"), "90.00 SEK");
  assert.equal(august.payload.columns[1].status, "covered");
});

test("BAS 2026 result groups cover every class 3-8 account exactly once", () => {
  for (let account = 3000; account <= 8999; account += 1) {
    const matches = BAS_2026_RESULT_GROUPS.filter(
      ({ from, to }) => account >= from && account <= to,
    );
    assert.equal(matches.length, 1, `account ${account}`);
  }
  assert.equal(
    BAS_2026_RESULT_GROUPS.some(({ from, to }) => 2999 >= from && 2999 <= to),
    false,
  );
});

test("reports reject duplicate periods, unapproved or malformed snapshots, mixed currencies and inconsistent references", () => {
  const balanced = [
    transaction("2026-05", "A1", [
      line("1930", "Företagskonto", "1.00", "0.00"),
      line("3010", "Försäljning", "0.00", "1.00"),
    ]),
  ];
  const may = approvedMonth("2026-05", balanced);
  const build = (periods) =>
    buildResultReport({
      state: state(),
      periods,
      fromMonth: "2026-05",
      toMonth: "2026-05",
      layout: "monthly",
    });
  assert.throws(() => build([may, may]), /unique/);
  assert.throws(
    () => build([approvedMonth("2026-05", balanced, { approvalStatus: "preliminary" })]),
    /approved/,
  );
  assert.throws(
    () => build([approvedMonth("2026-05", balanced, { currency: "EUR" })]),
    /incompatible/,
  );
  assert.throws(
    () =>
      build([
        approvedMonth("2026-05", balanced, {
          snapshotRunRef: createContentRef({
            schemaId: "se.bergbok.consolidation-run",
            stableId: "different",
            version: 1,
            payload: {},
          }),
        }),
      ]),
    /inconsistent/,
  );
  assert.throws(
    () =>
      build([
        approvedMonth("2026-05", [
          transaction("2026-05", "A1", [line("3010", "Försäljning", "0.00", "1.00")]),
        ]),
      ]),
    /balanced/,
  );
});
