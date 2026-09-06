#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { consolidate } from "../src/index.mjs";
import { render as renderArtifacts } from "../../artifacts/src/index.mjs";
import { prettyCanonicalJson } from "../../../contracts/src/canonical.mjs";
import { createContentRef, createStateEnvelope, proposalDigest, sealContent } from "../../../contracts/src/index.mjs";
import { allocateRunDirectory } from "../../../dev/demo-run-directory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : await allocateRunDirectory(path.join(here, "generated"));
const runId = path.basename(outputDirectory);

const structuredInput = {
  schema_id: "se.bergbok.bookkeeping-input",
  schema_version: "3.0",
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
    {
      source_id: "vat-close:2026-Q1",
      date: "2026-03-31",
      description: "Close quarterly VAT",
      evidence_document_ids: ["invoice-101.pdf"],
      lines: [
        { account: "2611", account_name: "Output VAT", debit: "25.00 SEK", credit: "0.00 SEK" },
        { account: "2650", account_name: "VAT settlement", debit: "0.00 SEK", credit: "25.00 SEK" },
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
    closing_transaction_source_id: "vat-close:2026-Q1",
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
      schema_version: "3.0",
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
      reconciliation: { period_id: "2026-02", accounts: [] },
      vat: { frequency: "quarterly", cycle_start: "2026-01-01", cycle_end: "2026-03-31", due_in_period: false, input_accounts: ["2641"], output_accounts: ["2611"], settlement_account: "2650", status: "not_due", closing_transaction_source_id: null, declaration_boxes: {} },
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
        chart_of_accounts: "BAS",
        vat_reporting: { frequency: "quarterly", input_accounts: ["2641"], output_accounts: ["2611"], settlement_account: "2650" },
      },
    },
    upstream_results: [],
  },
});

const outcome = await consolidate(caseBundle);
const demoFinishedAt = new Date();
const runRef = createContentRef({
  schemaId: "se.bergbok.consolidation-run",
  stableId: runId,
  version: 1,
  payload: { outcome },
});
const outputSnapshot = sealContent({
  schemaId: "se.bergbok.output-snapshot",
  schemaVersion: "2.0",
  stableId: `${runId}:output-snapshot`,
  version: "preliminary",
  payload: {
    contract_version: "2.0",
    approval_status: "preliminary",
    language: outcome.review.language,
    run_ref: runRef,
    approval_receipt_ref: null,
    proposal_digest: outcome.kind === "proposal" ? proposalDigest(outcome) : null,
    recorded_at: demoFinishedAt.toISOString(),
    context: {
      company_id: caseBundle.payload.company_id,
      domain: caseBundle.payload.domain,
      period: caseBundle.payload.period,
      docset_ref: caseBundle.payload.docset.ref,
      previous_state_ref: caseBundle.payload.previous_state.ref,
    },
    outcome,
  },
});
const reviewBundles = await Promise.all([
  "review-source-json-v1",
  "review-html-v1",
  "review-pdf-v1",
].map((profile) => renderArtifacts(outputSnapshot, profile)));
const reviewArtifacts = reviewBundles.flatMap((bundle) => bundle.payload.artifacts);
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, "case.json"), prettyCanonicalJson(caseBundle), "utf8"),
  writeFile(path.join(outputDirectory, "outcome.json"), prettyCanonicalJson(outcome), "utf8"),
  ...reviewArtifacts.map((artifact) => writeFile(path.join(outputDirectory, artifact.filename), Buffer.from(artifact.content_base64, "base64"))),
]);

console.log(`Bookkeeping demo: ${outcome.kind}`);
console.log(`Output: ${outputDirectory}`);
