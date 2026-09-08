import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { consolidate } from "../../bookkeeping/src/index.mjs";
import { render } from "../src/index.mjs";
import { prettyCanonicalJson } from "../../../contracts/src/canonical.mjs";
import {
  createContentRef,
  createModuleOutcome,
  createStateEnvelope,
  proposalDigest,
  sealContent,
} from "../../../contracts/src/index.mjs";
import { allocateRunDirectory } from "../../../dev/demo-run-directory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : await allocateRunDirectory(path.join(here, "generated"));

const previous = createStateEnvelope({
  companyId: "example-ab",
  sequence: 2,
  core: { organization: { name: "Example Ångström AB", organization_number: "559999-9999" } },
  domains: {
    bookkeeping: {
      contract_version: "1.0",
      status: "approved",
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
const bookkeepingInput = {
  schema_id: "se.bergbok.bookkeeping-input",
  schema_version: "3.0",
  company_id: "example-ab",
  period_id: "2026-03",
  mode: "ordinary",
  transactions: [
    {
      source_id: "sale-1",
      date: "2026-03-12",
      description: "Customer payment",
      evidence_document_ids: ["bank.pdf"],
      lines: [
        { account: "1930", account_name: "Bank", debit: "125.00 SEK", credit: "0.00 SEK" },
        { account: "3001", account_name: "Sales", debit: "0.00 SEK", credit: "100.00 SEK" },
        { account: "2611", account_name: "Output VAT", debit: "0.00 SEK", credit: "25.00 SEK" },
      ],
    },
    {
      source_id: "vat-close:2026-Q1",
      date: "2026-03-31",
      description: "Close quarterly VAT",
      evidence_document_ids: ["bank.pdf"],
      lines: [
        { account: "2611", account_name: "Output VAT", debit: "25.00 SEK", credit: "0.00 SEK" },
        { account: "2650", account_name: "VAT settlement", debit: "0.00 SEK", credit: "25.00 SEK" },
      ],
    },
  ],
  open_item_changes: [],
  reconciliations: [{ account: "1930", external_closing_balance: "625.00 SEK", evidence_document_ids: ["bank.pdf"] }],
  vat: {
    status: "due",
    closing_transaction_source_id: "vat-close:2026-Q1",
    declaration_boxes: { "10": "25.00 SEK", "11": "0.00 SEK", "12": "0.00 SEK", "48": "0.00 SEK", "49": "25.00 SEK" },
  },
};
const documents = [
  { document_id: "bank.pdf", filename: "bank.pdf", role: "evidence", media_type: "application/pdf", content_base64: Buffer.from("%PDF-demo").toString("base64") },
  { document_id: "input.json", filename: "input.json", role: "bookkeeping-input", media_type: "application/json", content_base64: Buffer.from(JSON.stringify(bookkeepingInput)).toString("base64") },
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
    language: "sv",
    period: { id: "2026-03", kind: "ordinary", start: "2026-03-01", end: "2026-03-31" },
    docset,
    previous_state: previous,
    effective_policies: {
      core: { country: "SE", currency: "SEK", fiscal_year: { start: "2026-01-01", end: "2026-12-31" }, accounting_method: "invoice" },
      bookkeeping: { profile: "se-private-ab-invoice-calendar-demo-v1", verification_series: "A", chart_of_accounts: "BAS", vat_reporting: { frequency: "quarterly", input_accounts: ["2641"], output_accounts: ["2611"], settlement_account: "2650" }, open_items: { supplier_payable: { accounts: ["2440"], side: "credit" }, customer_receivable: { accounts: ["1510"], side: "debit" }, related_party_payable: { accounts: ["2893"], side: "credit" }, other_current_payable: { accounts: ["2890"], side: "credit" }, other_current_receivable: { accounts: ["1680"], side: "debit" } } },
    },
    upstream_results: [],
  },
});
const bookkeepingOutcome = await consolidate(caseBundle);
if (bookkeepingOutcome.kind !== "proposal") throw new Error(`Expected proposal, received ${bookkeepingOutcome.kind}`);
const bookkeepingRunRef = createContentRef({
  schemaId: "se.bergbok.consolidation-run",
  stableId: "example-ab:2026-03:bookkeeping:run",
  version: 1,
  payload: bookkeepingOutcome,
});
const approvedSnapshot = outputSnapshot({ status: "approved", runRef: bookkeepingRunRef, sourceCase: caseBundle, outcome: bookkeepingOutcome });
const previewSnapshot = outputSnapshot({ status: "preliminary", runRef: bookkeepingRunRef, sourceCase: caseBundle, outcome: bookkeepingOutcome });

const payrollCaseRef = createContentRef({ schemaId: "se.bergbok.consolidation-case", stableId: "example-ab:2026-03:payroll", version: 1, payload: {} });
const payrollState = sealContent({
  schemaId: "se.bergbok.payroll.state",
  schemaVersion: "2.0",
  stableId: "example-ab:payroll-state",
  version: 1,
  payload: { schema_version: "2.0", company_id: "example-ab", through_period_id: "2026-03" },
});
const payrollOutcome = createModuleOutcome({
  kind: "proposal",
  domain: "payroll",
  caseRef: payrollCaseRef,
  proposedChanges: [{ action: "replace_domain_state", domain: "payroll", state_ref: payrollState.ref }],
  projectedState: payrollState,
  canonicalOutputs: {
    payroll: {
      schema_version: "2.0",
      period_id: "2026-03",
      payslips: [{ employee_id: "employee-1", employee_name: "Demo Employee", period_id: "2026-03", gross_pay: "30000.00 SEK", tax_withheld: "9000.00 SEK", net_pay: "21000.00 SEK" }],
    },
  },
  review: { language: "sv", summary: "Löneunderlaget behöver kompletteras." },
});
const payrollRunRef = createContentRef({ schemaId: "se.bergbok.consolidation-run", stableId: "example-ab:2026-03:payroll:run", version: 1, payload: payrollOutcome });
const payrollSnapshot = sealContent({
  schemaId: "se.bergbok.output-snapshot",
  schemaVersion: "2.0",
  stableId: "example-ab:2026-03:payroll:snapshot",
  version: "approved",
  payload: {
    contract_version: "2.0",
    approval_status: "approved",
    language: "sv",
    run_ref: payrollRunRef,
    approval_receipt_ref: receiptRef("payroll"),
    proposal_digest: proposalDigest(payrollOutcome),
    recorded_at: "2026-03-31T12:00:00.000Z",
    context: { company_id: "example-ab", domain: "payroll", period: caseBundle.payload.period, docset_ref: payrollCaseRef, previous_state_ref: previous.ref },
    outcome: payrollOutcome,
  },
});

const jobs = [
  ["approved-sie", approvedSnapshot, "sie4-v1"],
  ["approved-vat-xml", approvedSnapshot, "vat-xml-v1"],
  ["approved-vat-pdf", approvedSnapshot, "vat-verification-pdf-v1"],
  ["approved-payslips", payrollSnapshot, "payslips-pdf-v1"],
  ["preview-report-source", previewSnapshot, "report-source-json-v1"],
  ["preview-report-html", previewSnapshot, "report-html-v1"],
  ["preview-report-pdf", previewSnapshot, "report-pdf-v1"],
  ["preview-sie", previewSnapshot, "sie4-v1"],
];
const reportRows = [];
await mkdir(outputRoot, { recursive: true });
for (const [name, snapshot, profile] of jobs) {
  const first = await render(snapshot, profile);
  const second = await render(snapshot, profile);
  if (first.ref.sha256 !== second.ref.sha256) throw new Error(`${profile} was not reproducible`);
  const directory = path.join(outputRoot, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "bundle.json"), prettyCanonicalJson(first));
  for (const artifact of first.payload.artifacts) {
    await writeFile(path.join(directory, artifact.filename), Buffer.from(artifact.content_base64, "base64"));
    reportRows.push(`| ${profile} | ${first.payload.language ?? "—"} | ${first.payload.preview ? "yes" : "no"} | ${artifact.filename} | \`${artifact.sha256}\` |`);
  }
}

await writeFile(path.join(outputRoot, "manifest.json"), prettyCanonicalJson({
  schema_id: "se.bergbok.demo-run",
  schema_version: "1.0",
  module: "artifacts",
  source_refs: [approvedSnapshot.ref, previewSnapshot.ref, payrollSnapshot.ref],
  profiles: jobs.map(([, , profile]) => profile),
}));
await writeFile(path.join(outputRoot, "report.md"), [
  "# Artifacts demo",
  "",
  "Every profile was rendered twice through the public `Artifacts.render` interface and produced the same bundle digest.",
  "",
  "| Profile | Language | Preview | File | SHA-256 |",
  "|---|---|---:|---|---|",
  ...reportRows,
  "",
  "Preview material is visibly marked. No artifact was submitted, filed, emailed, or paid.",
  "",
].join("\n"));

console.log(outputRoot);

function outputSnapshot({ status, runRef, sourceCase, outcome }) {
  return sealContent({
    schemaId: "se.bergbok.output-snapshot",
    schemaVersion: "2.0",
    stableId: `${runRef.stable_id}:output-snapshot`,
    version: status,
    payload: {
      contract_version: "2.0",
      approval_status: status,
      language: outcome.review.language,
      run_ref: runRef,
      approval_receipt_ref: status === "approved" ? receiptRef("bookkeeping") : null,
      proposal_digest: proposalDigest(outcome),
      recorded_at: "2026-03-31T12:00:00.000Z",
      context: {
        company_id: sourceCase.payload.company_id,
        domain: sourceCase.payload.domain,
        period: sourceCase.payload.period,
        docset_ref: sourceCase.payload.docset.ref,
        previous_state_ref: sourceCase.payload.previous_state.ref,
      },
      outcome,
    },
  });
}

function receiptRef(domain) {
  return createContentRef({ schemaId: "se.bergbok.approval-receipt", stableId: `example-ab:2026-03:${domain}:receipt`, version: 1, payload: {} });
}
