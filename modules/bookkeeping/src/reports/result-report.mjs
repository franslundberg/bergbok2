import {
  ContractError,
  assertContentRef,
  assertPeriod,
  formatMoney,
  parseMoney,
  sealContent,
  verifySealedContent,
} from "../../../../contracts/src/index.mjs";
import { canonicalStringify, sha256Json } from "../../../../contracts/src/canonical.mjs";

const REPORT_SCHEMA = "se.bergbok.result-report";
const REPORT_VERSION = "1.0";
const REPORT_MAPPING = "bas-2026-cost-type-v1";
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const ACCOUNT = /^\d{4}$/;

export const BAS_2026_RESULT_GROUPS = Object.freeze([
  { id: "operating_income", label: "Rörelsens intäkter", from: 3000, to: 3999, section: "income" },
  {
    id: "materials",
    label: "Råvaror, förnödenheter och handelsvaror",
    from: 4000,
    to: 4999,
    section: "operating_costs",
  },
  {
    id: "external_costs",
    label: "Övriga externa kostnader",
    from: 5000,
    to: 6999,
    section: "operating_costs",
  },
  { id: "personnel", label: "Personalkostnader", from: 7000, to: 7699, section: "operating_costs" },
  {
    id: "impairments",
    label: "Nedskrivningar och återföringar",
    from: 7700,
    to: 7799,
    section: "operating_costs",
  },
  {
    id: "depreciation",
    label: "Avskrivningar enligt plan",
    from: 7800,
    to: 7899,
    section: "operating_costs",
  },
  {
    id: "other_operating_costs",
    label: "Övriga rörelsekostnader",
    from: 7900,
    to: 7999,
    section: "operating_costs",
  },
  {
    id: "financial",
    label: "Finansiella och andra poster",
    from: 8000,
    to: 8799,
    section: "financial",
  },
  {
    id: "appropriations",
    label: "Bokslutsdispositioner",
    from: 8800,
    to: 8899,
    section: "appropriations",
  },
  { id: "tax", label: "Skatter", from: 8900, to: 8989, section: "tax" },
  {
    id: "booked_result",
    label: "Bokfört resultat",
    from: 8990,
    to: 8999,
    section: "booked_result",
  },
]);

const SECTION_LABELS = Object.freeze({
  income: "Rörelsens intäkter",
  operating_costs: "Rörelsens kostnader",
  financial: "Finansiella poster",
  appropriations: "Bokslutsdispositioner",
  tax: "Skatt",
  booked_result: "Bokfört resultat",
});

const SECTION_GROUPS = Object.freeze({
  income: ["operating_income"],
  operating_costs: [
    "materials",
    "external_costs",
    "personnel",
    "impairments",
    "depreciation",
    "other_operating_costs",
  ],
  financial: ["financial"],
  appropriations: ["appropriations"],
  tax: ["tax"],
  booked_result: ["booked_result"],
});

export function buildResultReport({
  state,
  periods,
  fromMonth,
  toMonth,
  layout,
  recordedAt = new Date().toISOString(),
}) {
  verifySealedContent(state, "result-report State");
  if (state.ref.schema_id !== "se.bergbok.state-envelope") {
    throw new ContractError("Result report requires a State envelope");
  }
  if (!MONTH.test(fromMonth ?? "") || !MONTH.test(toMonth ?? "") || fromMonth > toMonth) {
    throw new ContractError("Result report requires an ordered YYYY-MM range");
  }
  if (!["monthly", "period_accumulated"].includes(layout)) {
    throw new ContractError("Result report layout must be monthly or period_accumulated");
  }
  if (!Number.isFinite(new Date(recordedAt).valueOf())) {
    throw new ContractError("Result report recordedAt must be an ISO date-time");
  }
  const core = state.payload?.core;
  const companyId = state.payload?.company_id;
  const company = core?.organization;
  const currency = core?.policies?.currency;
  const fiscalYear = core?.policies?.fiscal_year;
  const bookkeepingStart = core?.bookkeeping_start_date;
  if (!companyId || !company?.name || !company?.organization_number || !currency) {
    throw new ContractError("Result report requires approved company identity and currency");
  }
  if (!fiscalYear?.start || !fiscalYear?.end || !bookkeepingStart) {
    throw new ContractError("Result report requires fiscal year and bookkeeping start date");
  }
  const requestedMonths = monthRange(fromMonth, toMonth);
  const fiscalMonths = monthRange(
    laterMonth(fiscalYear.start.slice(0, 7), bookkeepingStart.slice(0, 7)),
    toMonth,
  );
  if (fiscalMonths.length > 18 || requestedMonths.length > 18) {
    throw new ContractError("Result report range may contain at most 18 months");
  }
  if (fromMonth < fiscalYear.start.slice(0, 7) || toMonth > fiscalYear.end.slice(0, 7)) {
    throw new ContractError("Result report range must stay inside one declared fiscal year");
  }

  const normalized = normalizePeriods(periods, { companyId, currency });
  const monthMaps = new Map();
  const sourceRunRefs = [];
  for (const month of fiscalMonths) {
    const source = normalized.get(month);
    if (!source?.snapshot) continue;
    monthMaps.set(month, accountMovements(source.snapshot, { companyId, currency, month }));
    sourceRunRefs.push(source.runRef);
  }
  const coverage = reportCoverage(requestedMonths, normalized);
  const columns = buildColumns({
    layout,
    requestedMonths,
    fiscalMonths,
    normalized,
    coverage,
  });
  const usedMonths =
    layout === "monthly" ? requestedMonths : [...new Set([...requestedMonths, ...fiscalMonths])];
  const accountRows = combinedAccounts(monthMaps, usedMonths);
  const rowValues = (accounts) =>
    Object.fromEntries(
      columns.map((column) => [
        column.id,
        column.status === "not_covered"
          ? null
          : formatMoney(
              column.months.reduce(
                (total, month) =>
                  total +
                  accounts.reduce(
                    (monthTotal, account) =>
                      monthTotal + (monthMaps.get(month)?.get(account)?.minorUnits ?? 0n),
                    0n,
                  ),
                0n,
              ),
              currency,
            ),
      ]),
    );
  const rows = buildRows(accountRows, rowValues);
  const payload = {
    contract_version: REPORT_VERSION,
    report_type: "result_report",
    language: "sv",
    mapping: { id: REPORT_MAPPING, version: "1" },
    company: {
      id: companyId,
      name: company.name,
      organization_number: company.organization_number,
    },
    currency,
    fiscal_year: fiscalYear,
    bookkeeping_start_date: bookkeepingStart,
    requested_range: { from_month: fromMonth, to_month: toMonth },
    layout,
    coverage,
    columns: columns.map(({ months, ...column }) => column),
    rows,
    source: {
      state_ref: state.ref,
      approved_run_refs: uniqueRefs(
        sourceRunRefs.filter((ref) =>
          usedMonths.some((month) => sameRef(normalized.get(month)?.runRef, ref)),
        ),
      ),
    },
    recorded_at: recordedAt,
  };
  const identity = sha256Json({
    state_ref: state.ref,
    requested_range: payload.requested_range,
    layout,
    recorded_at: recordedAt,
  });
  const report = sealContent({
    schemaId: REPORT_SCHEMA,
    schemaVersion: REPORT_VERSION,
    stableId: `${companyId}:result-report:${identity}`,
    version: 1,
    payload,
  });
  assertResultReport(report);
  return report;
}

export function assertResultReport(report) {
  verifySealedContent(report, "result report");
  if (
    report.ref.schema_id !== REPORT_SCHEMA ||
    report.ref.schema_version !== REPORT_VERSION ||
    report.payload?.contract_version !== REPORT_VERSION ||
    report.payload?.report_type !== "result_report"
  ) {
    throw new ContractError("Unsupported result report");
  }
  if (
    report.payload.language !== "sv" ||
    report.payload.mapping?.id !== REPORT_MAPPING ||
    report.payload.mapping?.version !== "1" ||
    typeof report.payload.company?.id !== "string" ||
    typeof report.payload.company?.name !== "string" ||
    typeof report.payload.company?.organization_number !== "string" ||
    typeof report.payload.currency !== "string" ||
    !MONTH.test(report.payload.requested_range?.from_month ?? "") ||
    !MONTH.test(report.payload.requested_range?.to_month ?? "") ||
    report.payload.requested_range.from_month > report.payload.requested_range.to_month ||
    !["monthly", "period_accumulated"].includes(report.payload.layout) ||
    !Array.isArray(report.payload.columns) ||
    !Array.isArray(report.payload.rows)
  ) {
    throw new ContractError("Result report is missing columns or rows");
  }
  formatMoney(0n, report.payload.currency);
  const coverage = report.payload.coverage;
  if (
    !coverage ||
    !["covered", "partially_covered", "not_covered"].includes(coverage.status) ||
    typeof coverage.complete !== "boolean" ||
    !Array.isArray(coverage.uncovered_months) ||
    !coverage.uncovered_months.every((month) => MONTH.test(month))
  ) {
    throw new ContractError("Result report contains invalid coverage");
  }
  for (const column of report.payload.columns) {
    if (
      typeof column?.id !== "string" ||
      typeof column?.label !== "string" ||
      !["covered", "partially_covered", "not_covered"].includes(column?.status)
    ) {
      throw new ContractError("Result report contains an invalid column");
    }
  }
  const columnIds = new Set(report.payload.columns.map(({ id }) => id));
  if (columnIds.size !== report.payload.columns.length) {
    throw new ContractError("Result report column IDs must be unique");
  }
  const rowIds = new Set();
  const accounts = new Set();
  for (const row of report.payload.rows) {
    if (
      typeof row?.id !== "string" ||
      typeof row?.label !== "string" ||
      !["section", "account", "subtotal", "result"].includes(row?.kind)
    ) {
      throw new ContractError("Result report contains an invalid row");
    }
    if (rowIds.has(row.id)) throw new ContractError("Result report row IDs must be unique");
    rowIds.add(row.id);
    if (row.kind === "section") continue;
    if (
      !row.values ||
      Object.keys(row.values).length !== columnIds.size ||
      Object.keys(row.values).some((id) => !columnIds.has(id))
    ) {
      throw new ContractError("Result report row values do not match its columns");
    }
    if (row.kind === "account") {
      if (!ACCOUNT.test(row.account ?? "") || accounts.has(row.account)) {
        throw new ContractError("Result report account rows must be unique result accounts");
      }
      const number = Number(row.account);
      if (number < 3000 || number > 8999) {
        throw new ContractError("Result report cannot contain balance accounts");
      }
      accounts.add(row.account);
    }
    for (const id of columnIds) {
      const value = row.values[id];
      if (value !== null) parseMoney(value, { expectedCurrency: report.payload.currency });
    }
  }
  for (const id of [
    "total-income",
    "total-operating_costs",
    "operating_result",
    "total-financial",
    "result_after_financial_items",
    "total-appropriations",
    "result_before_tax",
    "total-tax",
    "calculated_result",
    "total-booked_result",
  ]) {
    if (!rowIds.has(id)) throw new ContractError(`Result report is missing required row ${id}`);
  }
  assertContentRef(report.payload.source?.state_ref, "result-report State reference");
  if (!Array.isArray(report.payload.source?.approved_run_refs)) {
    throw new ContractError("Result report is missing approved run references");
  }
  report.payload.source.approved_run_refs.forEach((ref, index) =>
    assertContentRef(ref, `result-report approved run reference ${index}`),
  );
  return true;
}

function normalizePeriods(periods, { companyId, currency }) {
  if (!Array.isArray(periods)) throw new ContractError("Result report periods must be an array");
  const result = new Map();
  for (const entry of periods) {
    const month = entry?.month;
    if (!MONTH.test(month ?? "") || result.has(month)) {
      throw new ContractError("Result report periods must contain unique YYYY-MM months");
    }
    const period = entry.period ?? null;
    const snapshot = entry.snapshot ?? null;
    const runRef = entry.run_ref ?? entry.runRef ?? null;
    if (period !== null) {
      assertPeriod(period);
      if (period.id !== month || period.kind !== "ordinary") {
        throw new ContractError(`Result report month ${month} requires its ordinary Period`);
      }
    }
    if (snapshot === null) {
      if (runRef !== null)
        throw new ContractError(`Uncovered month ${month} cannot have a run reference`);
      result.set(month, { month, period, runRef: null, snapshot: null });
      continue;
    }
    if (!period) {
      throw new ContractError(`Result report snapshot ${month} requires its ordinary Period`);
    }
    verifySealedContent(snapshot, `result-report snapshot ${month}`);
    if (
      snapshot.ref.schema_id !== "se.bergbok.output-snapshot" ||
      snapshot.payload?.approval_status !== "approved" ||
      snapshot.payload?.context?.company_id !== companyId ||
      canonicalStringify(snapshot.payload?.context?.period) !== canonicalStringify(period)
    ) {
      throw new ContractError(`Result report snapshot ${month} is not an approved matching period`);
    }
    assertContentRef(runRef, `result-report run reference ${month}`);
    if (!sameRef(snapshot.payload.run_ref, runRef)) {
      throw new ContractError(`Result report run reference ${month} is inconsistent`);
    }
    const delta = snapshot.payload.outcome?.canonical_outputs?.period_delta;
    if (
      delta?.schema_id !== "se.bergbok.bookkeeping-period-delta" ||
      delta?.schema_version !== "3.0" ||
      delta?.company_id !== companyId ||
      delta?.period_id !== period.id ||
      delta?.currency !== currency
    ) {
      throw new ContractError(`Result report period delta ${month} is incompatible`);
    }
    if (!Array.isArray(delta.transactions)) {
      throw new ContractError(`Result report period delta ${month} has invalid transactions`);
    }
    result.set(month, { month, period, runRef, snapshot });
  }
  return result;
}

function accountMovements(snapshot, { currency, month }) {
  const delta = snapshot.payload.outcome.canonical_outputs.period_delta;
  const accounts = new Map();
  for (const transaction of delta.transactions ?? []) {
    if (typeof transaction.date !== "string" || transaction.date.slice(0, 7) !== month) {
      throw new ContractError(`Result report transaction falls outside ${month}`);
    }
    let debitTotal = 0n;
    let creditTotal = 0n;
    if (!Array.isArray(transaction.lines)) {
      throw new ContractError("Result report transaction has invalid lines");
    }
    for (const line of transaction.lines) {
      const debit = parseMoney(line.debit, { expectedCurrency: currency }).minorUnits;
      const credit = parseMoney(line.credit, { expectedCurrency: currency }).minorUnits;
      debitTotal += debit;
      creditTotal += credit;
      if (!ACCOUNT.test(line.account ?? ""))
        throw new ContractError("Result report account must use four digits");
      const number = Number(line.account);
      if (number < 3000 || number > 8999) continue;
      const group = groupForAccount(number);
      if (!group) throw new ContractError(`Result account ${line.account} has no BAS report group`);
      if (typeof line.account_name !== "string" || !line.account_name.trim()) {
        throw new ContractError(`Result account ${line.account} is missing its name`);
      }
      const existing = accounts.get(line.account);
      if (existing && existing.accountName !== line.account_name) {
        throw new ContractError(`Result account ${line.account} has inconsistent names`);
      }
      accounts.set(line.account, {
        account: line.account,
        accountName: line.account_name,
        groupId: group.id,
        minorUnits: (existing?.minorUnits ?? 0n) + credit - debit,
      });
    }
    if (debitTotal !== creditTotal)
      throw new ContractError("Result report transaction is not balanced");
  }
  return accounts;
}

function combinedAccounts(monthMaps, usedMonths) {
  const result = new Map();
  for (const month of usedMonths) {
    const accounts = monthMaps.get(month);
    if (!accounts) continue;
    for (const [account, value] of accounts) {
      const existing = result.get(account);
      if (existing && existing.accountName !== value.accountName) {
        throw new ContractError(`Result account ${account} has inconsistent names across periods`);
      }
      result.set(account, value);
    }
  }
  return [...result.values()]
    .filter(({ account }) =>
      usedMonths.some((month) => (monthMaps.get(month)?.get(account)?.minorUnits ?? 0n) !== 0n),
    )
    .sort((left, right) => left.account.localeCompare(right.account, "sv"));
}

function buildRows(accounts, rowValues) {
  const rows = [];
  const accountsFor = (groupIds) =>
    accounts.filter((account) => groupIds.includes(account.groupId));
  const addSection = (sectionId, { includeEmpty = true } = {}) => {
    const groupIds = SECTION_GROUPS[sectionId];
    const sectionAccounts = accountsFor(groupIds);
    if (!includeEmpty && sectionAccounts.length === 0) return;
    rows.push({ kind: "section", id: sectionId, label: SECTION_LABELS[sectionId] });
    for (const groupId of groupIds) {
      const group = BAS_2026_RESULT_GROUPS.find(({ id }) => id === groupId);
      const groupAccounts = sectionAccounts.filter((account) => account.groupId === groupId);
      for (const account of groupAccounts) {
        rows.push({
          kind: "account",
          id: `account-${account.account}`,
          account: account.account,
          label: account.accountName,
          values: rowValues([account.account]),
        });
      }
      if (groupIds.length > 1 && (groupAccounts.length > 0 || includeEmpty)) {
        rows.push({
          kind: "subtotal",
          id: `subtotal-${groupId}`,
          label: `Summa ${group.label.toLocaleLowerCase("sv")}`,
          values: rowValues(groupAccounts.map(({ account }) => account)),
        });
      }
    }
    rows.push({
      kind: "subtotal",
      id: `total-${sectionId}`,
      label: sectionTotalLabel(sectionId),
      values: rowValues(sectionAccounts.map(({ account }) => account)),
    });
  };

  addSection("income");
  addSection("operating_costs");
  const operatingAccounts = accountsFor([
    ...SECTION_GROUPS.income,
    ...SECTION_GROUPS.operating_costs,
  ]);
  rows.push({
    kind: "result",
    id: "operating_result",
    label: "Rörelseresultat",
    values: rowValues(operatingAccounts.map(({ account }) => account)),
  });

  addSection("financial");
  const throughFinancial = accountsFor([
    ...SECTION_GROUPS.income,
    ...SECTION_GROUPS.operating_costs,
    ...SECTION_GROUPS.financial,
  ]);
  rows.push({
    kind: "result",
    id: "result_after_financial_items",
    label: "Resultat efter finansiella poster",
    values: rowValues(throughFinancial.map(({ account }) => account)),
  });

  addSection("appropriations");
  const beforeTax = accountsFor([
    ...SECTION_GROUPS.income,
    ...SECTION_GROUPS.operating_costs,
    ...SECTION_GROUPS.financial,
    ...SECTION_GROUPS.appropriations,
  ]);
  rows.push({
    kind: "result",
    id: "result_before_tax",
    label: "Resultat före skatt",
    values: rowValues(beforeTax.map(({ account }) => account)),
  });

  addSection("tax");
  const calculated = accounts.filter(({ groupId }) => groupId !== "booked_result");
  rows.push({
    kind: "result",
    id: "calculated_result",
    label: "Beräknat resultat",
    values: rowValues(calculated.map(({ account }) => account)),
  });
  addSection("booked_result");
  return rows;
}

function buildColumns({ layout, requestedMonths, fiscalMonths, normalized, coverage }) {
  const statusFor = (months) => {
    const covered = months.filter((month) => normalized.get(month)?.snapshot).length;
    if (covered === 0) return "not_covered";
    return covered === months.length ? "covered" : "partially_covered";
  };
  const coverageFor = (months) => {
    const covered = months
      .map((month) => normalized.get(month))
      .filter((entry) => entry?.snapshot && entry.period);
    return covered.length
      ? {
          coverage_start: covered[0].period.start ?? null,
          coverage_end: covered.at(-1).period.end ?? null,
        }
      : {};
  };
  if (layout === "monthly") {
    return [
      ...requestedMonths.map((month) => ({
        id: month,
        kind: "month",
        label: monthLabel(month),
        status: statusFor([month]),
        months: [month],
        ...periodCoverage(normalized.get(month)?.period),
      })),
      {
        id: "total",
        kind: "total",
        label: coverage.covered_through
          ? `Ack. godkänt t.o.m. ${dateLabel(coverage.covered_through)}`
          : "Ackumulerat",
        status: statusFor(requestedMonths),
        months: requestedMonths.filter((month) => normalized.get(month)?.snapshot),
        ...coverageFor(requestedMonths),
      },
    ];
  }
  const accumulatedCoverage = coverageFor(fiscalMonths);
  return [
    {
      id: "period",
      kind: "period",
      label:
        requestedMonths.length === 1
          ? monthLabel(requestedMonths[0])
          : `${monthLabel(requestedMonths[0])}–${monthLabel(requestedMonths.at(-1))}`,
      status: statusFor(requestedMonths),
      months: requestedMonths.filter((month) => normalized.get(month)?.snapshot),
      ...coverageFor(requestedMonths),
    },
    {
      id: "accumulated",
      kind: "accumulated",
      label: accumulatedCoverage.coverage_end
        ? `Ack. godkänt t.o.m. ${dateLabel(accumulatedCoverage.coverage_end)}`
        : "Ackumulerat",
      status: statusFor(fiscalMonths),
      months: fiscalMonths.filter((month) => normalized.get(month)?.snapshot),
      ...accumulatedCoverage,
    },
  ];
}

function reportCoverage(months, normalized) {
  const uncovered = months.filter((month) => !normalized.get(month)?.snapshot);
  const coveredEntries = months
    .map((month) => normalized.get(month))
    .filter((entry) => entry?.snapshot && entry.period);
  return {
    status:
      uncovered.length === 0
        ? "covered"
        : coveredEntries.length
          ? "partially_covered"
          : "not_covered",
    complete: uncovered.length === 0,
    covered_from: coveredEntries[0]?.period?.start ?? null,
    covered_through: coveredEntries.at(-1)?.period?.end ?? null,
    uncovered_months: uncovered,
  };
}

function periodCoverage(period) {
  if (!period) return {};
  return {
    coverage_start: period.start ?? null,
    coverage_end: period.end ?? null,
  };
}

function groupForAccount(number) {
  return BAS_2026_RESULT_GROUPS.find(({ from, to }) => number >= from && number <= to) ?? null;
}

function sectionTotalLabel(sectionId) {
  return {
    income: "Summa rörelsens intäkter",
    operating_costs: "Summa rörelsens kostnader",
    financial: "Summa finansiella poster",
    appropriations: "Summa bokslutsdispositioner",
    tax: "Summa skatt",
    booked_result: "Summa bokfört resultat",
  }[sectionId];
}

function monthRange(fromMonth, toMonth) {
  const result = [];
  let year = Number(fromMonth.slice(0, 4));
  let month = Number(fromMonth.slice(5, 7));
  const endYear = Number(toMonth.slice(0, 4));
  const endMonth = Number(toMonth.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    result.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
  }
  return result;
}

function monthLabel(month) {
  return new Intl.DateTimeFormat("sv-SE", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}

function dateLabel(date) {
  return new Intl.DateTimeFormat("sv-SE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function laterMonth(left, right) {
  return left > right ? left : right;
}

function uniqueRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    if (!ref) return false;
    const key = `${ref.stable_id}@${ref.version}#${ref.sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameRef(left, right) {
  return (
    left?.schema_id === right?.schema_id &&
    left?.schema_version === right?.schema_version &&
    left?.stable_id === right?.stable_id &&
    left?.version === right?.version &&
    left?.sha256 === right?.sha256
  );
}
