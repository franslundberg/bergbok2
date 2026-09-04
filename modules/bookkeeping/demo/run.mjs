#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { consolidate } from "../src/index.mjs";
import { prettyCanonicalJson } from "../../../contracts/src/canonical.mjs";
import { createStateEnvelope, sealContent } from "../../../contracts/src/index.mjs";
import { allocateRunDirectory } from "../../../dev/demo-run-directory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const demoStartedAt = new Date();
const outputDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : await allocateRunDirectory(path.join(here, "generated"));
const runId = path.basename(outputDirectory);

const structuredInput = {
  schema_id: "se.bergbok.bookkeeping-input",
  schema_version: "2.0",
  company_id: "example-ab",
  period_id: "2026-03",
  mode: "ordinary",
  transactions: [
    {
      source_id: "invoice-101",
      date: "2026-03-10",
      description: "Customer invoice 101",
      evidence_document_ids: ["invoice-101.pdf"],
      lines: [
        { account: "1510", account_name: "Accounts receivable", debit: "125.00 SEK", credit: "0.00 SEK" },
        { account: "3001", account_name: "Sales", debit: "0.00 SEK", credit: "100.00 SEK" },
        { account: "2611", account_name: "Output VAT", debit: "0.00 SEK", credit: "25.00 SEK" },
      ],
    },
    {
      source_id: "payment-101",
      date: "2026-03-20",
      description: "Payment of customer invoice 101",
      evidence_document_ids: ["bank-statement.pdf"],
      lines: [
        { account: "1930", account_name: "Bank", debit: "125.00 SEK", credit: "0.00 SEK" },
        { account: "1510", account_name: "Accounts receivable", debit: "0.00 SEK", credit: "125.00 SEK" },
      ],
    },
  ],
  open_item_changes: [
    { action: "open", item_id: "customer:invoice-101", kind: "customer_receivable", party: "Customer AB", amount: "125.00 SEK", due_date: "2026-03-20", evidence_document_ids: ["invoice-101.pdf"] },
    { action: "settle", item_id: "customer:invoice-101", amount: "125.00 SEK", evidence_document_ids: ["bank-statement.pdf"] },
  ],
  reconciliations: [{ account: "1930", external_closing_balance: "625.00 SEK", evidence_document_ids: ["bank-statement.pdf"] }],
  vat: {
    status: "due",
    reporting_period_start: "2026-01-01",
    reporting_period_end: "2026-03-31",
    declaration_boxes: { "10": "25.00 SEK", "11": "0.00 SEK", "12": "0.00 SEK", "48": "0.00 SEK", "49": "25.00 SEK" },
  },
};

const previousState = createStateEnvelope({
  companyId: "example-ab",
  sequence: 2,
  core: { organization: { name: "Example AB", organization_number: "559999-9999" } },
  domains: {
    bookkeeping: {
      contract_version: "1.0",
      status: "projected",
      schema_id: "se.bergbok.bookkeeping.state",
      schema_version: "2.0",
      company_id: "example-ab",
      through_period_id: "2026-02",
      through_date: "2026-02-28",
      currency: "SEK",
      ledger: {
        balances: [
          { account: "1930", account_name: "Bank", debit: "500.00 SEK", credit: "0.00 SEK" },
          { account: "2081", account_name: "Share capital", debit: "0.00 SEK", credit: "500.00 SEK" },
        ],
        verification_series: { series: "A", last_number: 7 },
      },
      open_items: { items: [], totals: { count: 0, by_kind: {} } },
    },
  },
});

const documents = [
  { document_id: "invoice-101.pdf", role: "evidence", media_type: "application/pdf", content_base64: Buffer.from("Human-scale demo invoice evidence").toString("base64") },
  { document_id: "bank-statement.pdf", role: "evidence", media_type: "application/pdf", content_base64: Buffer.from("Human-scale demo bank evidence").toString("base64") },
  { document_id: "bookkeeping-input.json", role: "bookkeeping-input", media_type: "application/json", content_base64: Buffer.from(JSON.stringify(structuredInput)).toString("base64") },
];
const docset = sealContent({
  schemaId: "se.bergbok.docset",
  stableId: "example-ab:2026-03:docset",
  version: 1,
  payload: { documents },
});
const caseBundle = sealContent({
  schemaId: "se.bergbok.consolidation-case",
  stableId: "example-ab:2026-03:bookkeeping",
  version: 1,
  payload: {
    contract_version: "1.0",
    company_id: "example-ab",
    domain: "bookkeeping",
    period: { id: "2026-03", kind: "ordinary", start: "2026-03-01", end: "2026-03-31" },
    docset,
    previous_state: previousState,
    effective_policies: {
      core: {
        country: "SE",
        currency: "SEK",
        fiscal_year: { start: "2026-01-01", end: "2026-12-31" },
        accounting_method: "invoice",
      },
      bookkeeping: {
        profile: "se-private-ab-invoice-calendar-demo-v1",
        verification_series: "A",
        vat_reporting: { frequency: "quarterly", period_end: "2026-03-31" },
      },
    },
    upstream_results: [],
  },
});

const outcome = await consolidate(caseBundle);
const demoFinishedAt = new Date();
const bookkeepingOutput = outcome.canonical_outputs?.bookkeeping;
const ledgerTransactions = bookkeepingOutput?.ledger?.transactions ?? [];
const totalDebit = bookkeepingOutput?.ledger?.totals?.debit ?? "0.00 SEK";
const totalCredit = bookkeepingOutput?.ledger?.totals?.credit ?? "0.00 SEK";
const reconciliationSummary = bookkeepingOutput?.reconciliations
  ?.map((item) => `${item.account} ${item.status}`)
  .join(", ") || "none";
const demoReport = `# Bookkeeping demo — ${runId}

This report describes the executable Bookkeeping module demo and the result of
one call to the public \`consolidate(ConsolidationCase)\` operation. The demo
uses fixed, offline input from \`modules/bookkeeping/demo/run.mjs\`; it does not read
customer files, call a model, persist State, approve a run, post transactions,
file VAT, or submit anything externally.

## Run

- Run ID: \`${runId}\`
- Started (UTC): ${demoStartedAt.toISOString()}
- Finished (UTC): ${demoFinishedAt.toISOString()}
- Duration: ${demoFinishedAt.getTime() - demoStartedAt.getTime()} ms
- Module entry point: \`modules/bookkeeping/src/index.mjs\`
- Public operation: \`consolidate(ConsolidationCase)\`
- Execution: \`${outcome.provenance?.execution ?? "unknown"}\`
- Variant: \`${outcome.provenance?.variant_ref?.id ?? "unknown"}\`

## Input

- Case contract: \`${caseBundle.ref.schema_id}\`, version ${caseBundle.payload.contract_version}
- Company: \`${caseBundle.payload.company_id}\`
- Period: \`${caseBundle.payload.period.id}\` (${caseBundle.payload.period.start} to ${caseBundle.payload.period.end})
- Mode: \`${structuredInput.mode}\`
- Accounting method: \`${caseBundle.payload.effective_policies.core.accounting_method}\`
- Bookkeeping profile: \`${caseBundle.payload.effective_policies.bookkeeping.profile}\`
- Preceding Bookkeeping State: through \`${previousState.payload.domains.bookkeeping.through_period_id}\`, verification series \`${previousState.payload.domains.bookkeeping.ledger.verification_series.series}\` ending at ${previousState.payload.domains.bookkeeping.ledger.verification_series.last_number}
- Docset: ${documents.length} documents — ${documents.filter((document) => document.role === "evidence").length} evidence documents and one structured \`bookkeeping-input\` document
- Structured bookkeeping input: ${structuredInput.transactions.length} transactions, ${structuredInput.open_item_changes.length} open-item changes, ${structuredInput.reconciliations.length} reconciliation, VAT status \`${structuredInput.vat.status}\`, and ${caseBundle.payload.upstream_results.length} upstream results

## Output

- Outcome: \`${outcome.kind}\` for domain \`${outcome.domain}\`
- Proposal: ${outcome.proposed_changes.length} proposed State change and ${outcome.projected_state ? "one sealed projected Bookkeeping State" : "no projected State"}
- Ledger: ${ledgerTransactions.length} balanced transactions, total debit ${totalDebit}, total credit ${totalCredit}
- Verification numbering: ${ledgerTransactions.map((transaction) => transaction.verification_id).join(", ") || "none"}
- Closing open items: ${bookkeepingOutput?.open_items?.closing?.length ?? 0}
- Reconciliation: ${reconciliationSummary}
- VAT: \`${bookkeepingOutput?.vat_period?.status ?? "not available"}\`
- Generated files: \`case.json\` (sealed input), \`outcome.json\` (sealed module outcome), and \`report.md\` (this developer report plus the proposal review)

## Proposal review returned by Bookkeeping

${outcome.review.report_markdown.trimEnd()}
`;
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, "case.json"), prettyCanonicalJson(caseBundle), "utf8"),
  writeFile(path.join(outputDirectory, "outcome.json"), prettyCanonicalJson(outcome), "utf8"),
  writeFile(path.join(outputDirectory, "report.md"), demoReport, "utf8"),
]);

console.log(`Bookkeeping demo: ${outcome.kind}`);
console.log(`Output: ${outputDirectory}`);
