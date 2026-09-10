"use client";

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { CANONICAL_MONEY, formatResultReportMoney } from "@/lib/bergbok/result-report-view";

type ReportColumn = {
  id: string;
  label: string;
  status: "covered" | "partially_covered" | "not_covered";
  coverage_start?: string;
  coverage_end?: string;
};

type ReportRow = {
  kind: "section" | "account" | "subtotal" | "result";
  id: string;
  account?: string;
  label: string;
  values?: Record<string, string | null>;
};

type ResultReport = {
  ref: { schema_id: string; schema_version: string; sha256: string };
  payload: {
    contract_version: string;
    company: { name: string; organization_number: string };
    currency: string;
    requested_range: { from_month: string; to_month: string };
    layout: "monthly" | "period_accumulated";
    coverage: {
      status: "covered" | "partially_covered" | "not_covered";
      complete: boolean;
      covered_from: string | null;
      covered_through: string | null;
      uncovered_months: string[];
    };
    columns: ReportColumn[];
    rows: ReportRow[];
  };
};

type ResultReportOutput = {
  ok?: boolean;
  unavailable?: boolean;
  message?: string;
  report?: ResultReport;
};

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export function ResultReportTool({
  result,
  isError,
}: ToolCallMessagePartProps<Record<string, unknown>, ResultReportOutput>) {
  if (result === undefined && !isError) {
    return (
      <div className="my-3 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        Tar fram resultatrapport från godkänd bokföring…
      </div>
    );
  }
  if (isError || !isResultReport(result?.report)) return <UnavailableReport />;
  const report = result.report;
  const { payload } = report;
  const incompleteCoverage =
    !payload.coverage.complete || payload.columns.some(({ status }) => status !== "covered");
  return (
    <article className="my-3 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">Resultatrapport</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {payload.company.name} · Org.nr {payload.company.organization_number}
            </p>
          </div>
          <div className="text-left text-xs text-muted-foreground sm:text-right">
            <div>{formatMonthRange(payload.requested_range)}</div>
            <div>{payload.currency}</div>
          </div>
        </div>
        {incompleteCoverage ? <CoverageWarning report={report} /> : null}
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] border-collapse text-sm tabular-nums">
          <caption className="sr-only">
            Resultatrapport för {payload.company.name}, {formatMonthRange(payload.requested_range)}
          </caption>
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th
                scope="col"
                className="sticky left-0 z-10 min-w-64 bg-muted px-4 py-2.5 text-left font-medium"
              >
                Konto
              </th>
              {payload.columns.map((column) => (
                <th
                  scope="col"
                  key={column.id}
                  className="min-w-36 px-3 py-2.5 text-right font-medium whitespace-nowrap"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {payload.rows.map((row) =>
              row.kind === "section" ? (
                <tr key={row.id}>
                  <th
                    scope="rowgroup"
                    colSpan={payload.columns.length + 1}
                    className="border-y border-border bg-muted/25 px-4 pt-4 pb-2 text-left font-semibold"
                  >
                    {row.label}
                  </th>
                </tr>
              ) : (
                <tr
                  key={row.id}
                  className={
                    row.kind === "result"
                      ? "border-t-2 border-foreground/20 font-semibold"
                      : row.kind === "subtotal"
                        ? "border-t border-border font-medium"
                        : "border-b border-border/50"
                  }
                >
                  <th
                    scope="row"
                    className={`sticky left-0 bg-card px-4 py-2 text-left ${
                      row.kind === "account"
                        ? "font-normal"
                        : row.kind === "subtotal"
                          ? "font-medium"
                          : "font-semibold"
                    }`}
                  >
                    {row.account ? (
                      <span className="mr-2 inline-block w-10 text-muted-foreground">
                        {row.account}
                      </span>
                    ) : null}
                    {row.label}
                  </th>
                  {payload.columns.map((column) => (
                    <td key={column.id} className="px-3 py-2 text-right whitespace-nowrap">
                      {formatResultReportMoney(row.values?.[column.id], payload.currency)}
                    </td>
                  ))}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      <footer className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-5">
        {coverageText(report)} Beloppen bygger endast på godkänd bokföring.
      </footer>
    </article>
  );
}

function CoverageWarning({ report }: { report: ResultReport }) {
  const { coverage } = report.payload;
  return (
    <div
      role="status"
      className="mt-3 rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950/35 dark:text-amber-100"
    >
      {coverage.covered_through
        ? `Ofullständig täckning. Godkänd bokföring finns till och med ${formatDate(coverage.covered_through)}; månader utan täckning visas med —.`
        : "Ingen månad i det begärda intervallet täcks av godkänd bokföring; belopp visas med —."}
    </div>
  );
}

function UnavailableReport() {
  return (
    <div role="status" className="my-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
      Den sparade resultatrapporten kan inte verifieras och är därför inte tillgänglig.
    </div>
  );
}

function isResultReport(value: unknown): value is ResultReport {
  if (!value || typeof value !== "object") return false;
  const report = value as ResultReport;
  const payload = report.payload;
  if (
    report.ref?.schema_id !== "se.bergbok.result-report" ||
    report.ref?.schema_version !== "1.0" ||
    !/^[a-f0-9]{64}$/.test(report.ref?.sha256 ?? "") ||
    payload?.contract_version !== "1.0" ||
    typeof payload.company?.name !== "string" ||
    typeof payload.company?.organization_number !== "string" ||
    typeof payload.currency !== "string" ||
    !MONTH.test(payload.requested_range?.from_month ?? "") ||
    !MONTH.test(payload.requested_range?.to_month ?? "") ||
    !payload.coverage ||
    typeof payload.coverage.complete !== "boolean" ||
    !Array.isArray(payload.coverage.uncovered_months) ||
    !Array.isArray(payload.columns) ||
    !Array.isArray(payload.rows)
  ) {
    return false;
  }
  const columns = new Set(
    payload.columns
      .filter(
        (column) =>
          column &&
          typeof column.id === "string" &&
          typeof column.label === "string" &&
          ["covered", "partially_covered", "not_covered"].includes(column.status),
      )
      .map(({ id }) => id),
  );
  if (columns.size !== payload.columns.length) return false;
  return payload.rows.every((row) => {
    if (!row || typeof row.id !== "string" || typeof row.label !== "string") return false;
    if (row.kind === "section") return true;
    if (!["account", "subtotal", "result"].includes(row.kind) || !row.values) return false;
    return [...columns].every((id) => {
      const amount = row.values?.[id];
      return amount === null || (typeof amount === "string" && CANONICAL_MONEY.test(amount));
    });
  });
}

function formatMonthRange(range: { from_month: string; to_month: string }) {
  const from = formatMonth(range.from_month);
  const to = formatMonth(range.to_month);
  return range.from_month === range.to_month ? from : `${from}–${to}`;
}

function formatMonth(month: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function coverageText(report: ResultReport) {
  const coveredStarts = report.payload.columns
    .map(({ coverage_start }) => coverage_start)
    .filter((value): value is string => Boolean(value))
    .sort();
  const coveredEnds = report.payload.columns
    .map(({ coverage_end }) => coverage_end)
    .filter((value): value is string => Boolean(value))
    .sort();
  if (!coveredStarts.length || !coveredEnds.length) return "Ingen godkänd täckning.";
  return `Godkänd täckning i visade belopp ${formatDate(coveredStarts[0])}–${formatDate(coveredEnds.at(-1)!)}.`;
}
