import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { create } from "../src/index.mjs";
import { createModuleOutcome, sealContent } from "../../../contracts/src/index.mjs";
import { allocateRunDirectory } from "../../../dev/demo-run-directory.mjs";

const COMPANY_ID = "demo-company-ab";
const COMPANY_NAME = "Demo Company AB";
const PERIOD = { id: "2026-02", kind: "ordinary", start: "2026-02-01", end: "2026-02-28" };
const PERIOD_ID = PERIOD.id;
const here = path.dirname(fileURLToPath(import.meta.url));
const generatedRoot = path.join(here, "generated");
const options = parseArguments(process.argv.slice(2));

await mkdir(generatedRoot, { recursive: true });
const outputDir = options.outputDirectory
  ? path.resolve(options.outputDirectory)
  : await allocateRunDirectory(generatedRoot);
const runId = path.basename(outputDir);
const inputDir = path.join(outputDir, "input");
const storeDir = path.join(outputDir, "store");
const clock = incrementingClock("2026-09-03T08:00:00.000Z");

await mkdir(inputDir, { recursive: true });

const invoiceFilename = "supplier-invoice-1042.txt";
const invoiceBytes = Buffer.from([
  "SYNTHETIC SUPPLIER INVOICE",
  "Supplier: Example Office Supplies AB",
  "Invoice number: 1042",
  "Invoice date: 2026-02-12",
  "Subtotal: 1 000.00 SEK",
  "VAT 25%: 250.00 SEK",
  "Total: 1 250.00 SEK",
  "Due date: 2026-03-14",
  "",
].join("\n"), "utf8");
await writeFile(path.join(inputDir, invoiceFilename), invoiceBytes);

const company = await create({
  rootDir: storeDir,
  companyId: COMPANY_ID,
  clock,
  actor: { id: "demo-bootstrap", role: "system" },
  initialState: {
    core: { legal_name: COMPANY_NAME, country: "SE", currency: "SEK" },
    domains: {},
  },
});

const invoiceLogRef = await company.ingest({
  suggested_period: PERIOD_ID,
  filename: invoiceFilename,
  media_type: "text/plain",
  bytes: invoiceBytes,
  metadata: { synthetic: true, evidence_type: "supplier_invoice" },
}, { id: "demo-uploader", role: "operator" });
const february = await company.reviseDocset(PERIOD, null, {
  actor: { id: "demo-uploader", role: "operator" },
  add: [{ log_item_ref: invoiceLogRef, role: "bookkeeping-input" }],
});
const invoiceDocument = february.added_documents[0];

const firstCase = await company.prepare("bookkeeping", PERIOD_ID, {
  expectedDocsetHead: february.docset.ref,
  actor: { id: "demo-worker", role: "worker" },
  effective_policies: {
    core: { country: "SE", currency: "SEK", accounting_method: "invoice" },
    bookkeeping: { profile: "demo" },
  },
});
const proposedBookkeepingState = sealContent({
  schemaId: "se.bergbok.bookkeeping.state",
  schemaVersion: "2.0",
  stableId: `${COMPANY_ID}:bookkeeping-state`,
  version: firstCase.ref.version,
  payload: {
    contract_version: "1.0",
    schema_version: "2.0",
    status: "projected",
    company_id: COMPANY_ID,
    through_period_id: PERIOD_ID,
    transaction_count: 1,
    supplier_liability: "1250.00 SEK",
  },
});
const proposal = createModuleOutcome({
  kind: "proposal",
  domain: "bookkeeping",
  caseRef: firstCase.ref,
  projectedState: proposedBookkeepingState,
  proposedChanges: [{ action: "record_supplier_invoice", amount: "1250.00 SEK" }],
  canonicalOutputs: {
    bookkeeping: {
      period_id: PERIOD_ID,
      status: "proposed",
      evidence_document_ids: [invoiceDocument.payload.document_id],
    },
  },
  review: { summary: "The supplier invoice is ready for review." },
  provenance: { module_id: "demo.offline-bookkeeping", module_version: "1" },
});
const approvedRun = await company.record(firstCase.ref, proposal);
const approval = await company.approve(approvedRun.ref, {
  decision: "approved",
  actor: { id: "demo-reviewer", role: "approver" },
  authority: { kind: "role", role: "approver" },
  expectedRunSha256: approvedRun.ref.sha256,
});

const staleCase = await company.prepare("bookkeeping", PERIOD_ID, { actor: "demo-worker" });
const staleRun = await company.record(
  staleCase.ref,
  createModuleOutcome({
    kind: "proposal",
    domain: "bookkeeping",
    caseRef: staleCase.ref,
    projectedState: sealContent({
      schemaId: "se.bergbok.bookkeeping.state",
      schemaVersion: "2.0",
      stableId: `${COMPANY_ID}:bookkeeping-state`,
      version: staleCase.ref.version,
      payload: {
        contract_version: "1.0",
        schema_version: "2.0",
        status: "projected",
        company_id: COMPANY_ID,
        through_period_id: PERIOD_ID,
        transaction_count: 1,
      },
    }),
    proposedChanges: [{ action: "record_supplier_invoice", amount: "1250.00 SEK" }],
    provenance: { module_id: "demo.offline-bookkeeping", module_version: "1" },
  }),
);

const paymentFilename = "supplier-invoice-1042-payment-confirmation.txt";
const paymentBytes = Buffer.from(
  "Synthetic bank confirmation: invoice 1042 paid 2026-02-27, 1 250.00 SEK.\n",
  "utf8",
);
await writeFile(path.join(inputDir, paymentFilename), paymentBytes);
const lateLogItemRef = await company.ingest({
  suggested_period: PERIOD_ID,
  filename: paymentFilename,
  media_type: "text/plain",
  bytes: paymentBytes,
  metadata: { synthetic: true, evidence_type: "payment_confirmation" },
}, { id: "demo-uploader", role: "operator" });
const revisedFebruary = await company.reviseDocset(PERIOD, february.docset.ref, [{
  op: "add",
  log_item_ref: lateLogItemRef,
  role: "supporting-evidence",
}]);
const paymentDocument = revisedFebruary.added_documents[0];

const staleRejection = await rejectedCode(() => company.approve(staleRun.ref, {
  decision: "approved",
  actor: { id: "demo-reviewer", role: "approver" },
  authority: { kind: "role", role: "approver" },
}));
const staleRunPath = path.join(
  storeDir,
  "objects",
  staleRun.ref.sha256.slice(0, 2),
  `${staleRun.ref.sha256}.json`,
);
const tamperedRun = JSON.parse(await readFile(staleRunPath, "utf8"));
tamperedRun.payload.outcome.review.summary = "Changed after recording";
await writeFile(staleRunPath, `${JSON.stringify(tamperedRun, null, 2)}\n`, "utf8");
const tamperRejection = await rejectedCode(() => company.read(staleRun.ref));

const timelineJson = await company.read({ kind: "timeline", format: "json" });
const timelineMarkdown = await company.read({ kind: "timeline", format: "markdown" });
const summary = {
  run_id: runId,
  output_directory: outputDir,
  company: {
    company_id: COMPANY_ID,
    legal_name: COMPANY_NAME,
  },
  period_id: PERIOD_ID,
  ingested_evidence: {
    filename: invoiceDocument.payload.filename,
    evidence_type: invoiceDocument.payload.metadata.evidence_type,
    period_id: invoiceDocument.payload.period_id,
    log_item_ref: invoiceLogRef,
    document_ref: invoiceDocument.ref,
    document_id: invoiceDocument.payload.document_id,
    byte_length: invoiceBytes.length,
    content_sha256: invoiceDocument.payload.sha256,
  },
  initial_docset_ref: february.docset.ref,
  consolidation_case_ref: firstCase.ref,
  approved_run_ref: approvedRun.ref,
  approval_receipt_ref: approval.receipt.ref,
  published_state_ref: approval.state.ref,
  newly_arrived_evidence: {
    filename: paymentDocument.payload.filename,
    evidence_type: paymentDocument.payload.metadata.evidence_type,
    period_id: paymentDocument.payload.period_id,
    log_item_ref: lateLogItemRef,
    document_ref: paymentDocument.ref,
    document_id: paymentDocument.payload.document_id,
    byte_length: paymentBytes.length,
    content_sha256: paymentDocument.payload.sha256,
  },
  newly_arrived_evidence_ref: lateLogItemRef,
  revised_docset_ref: revisedFebruary.docset.ref,
  stale_rejection: {
    ok: true,
    ...staleRejection,
    case_ref: staleCase.ref,
    run_ref: staleRun.ref,
  },
  tamper_rejection: {
    ok: true,
    ...tamperRejection,
    checked_ref: staleRun.ref,
  },
};

await writeFile(path.join(outputDir, "timeline.json"), `${JSON.stringify(timelineJson, null, 2)}\n`, "utf8");
await writeFile(path.join(outputDir, "timeline.md"), timelineMarkdown, "utf8");
await writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await writeFile(path.join(outputDir, "report.md"), renderReport(summary), "utf8");

if (options.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(renderTerminal(summary));
}

function parseArguments(args) {
  let json = false;
  let outputDirectory;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) usageError("--output requires a directory");
      if (outputDirectory) usageError("output directory was specified more than once");
      outputDirectory = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) usageError(`unknown option: ${argument}`);
    if (outputDirectory) usageError("output directory was specified more than once");
    outputDirectory = argument;
  }

  return { json, outputDirectory };
}

function usageError(message) {
  throw new Error(`${message}\nUsage: node modules/company-record/demo/run.mjs [--json] [--output DIRECTORY | DIRECTORY]`);
}

function renderTerminal(result) {
  return [
    "Bergbok — Company Record demo",
    "",
    `Run: ${result.run_id}`,
    `Company: ${result.company.legal_name} (${result.company.company_id})`,
    `Period: ${result.period_id}`,
    "",
    "Scenario",
    `[OK] Ingested supplier invoice 1042 — 1 250.00 SEK (${result.ingested_evidence.filename})`,
    `[OK] Assigned the invoice to Docset v${result.initial_docset_ref.version}`,
    "[OK] Recorded and approved the synthetic bookkeeping proposal",
    `[OK] Published Company State v${result.published_state_ref.version}`,
    `[OK] Added the payment confirmation; Docset advanced to v${result.revised_docset_ref.version}`,
    "",
    "Safety checks",
    `[OK] Stale approval rejected — ${result.stale_rejection.code}`,
    `[OK] Tampering detected — ${result.tamper_rejection.code}`,
    "",
    "Files",
    `Report:       ${path.join(result.output_directory, "report.md")}`,
    `Timeline:     ${path.join(result.output_directory, "timeline.md")}`,
    `Summary JSON: ${path.join(result.output_directory, "summary.json")}`,
    `Store:        ${path.join(result.output_directory, "store")}`,
  ].join("\n");
}

function renderReport(result) {
  return `# Company Record demo — ${result.run_id}

This developer demo exercises Company Record's public interface for ${result.company.legal_name} in ${result.period_id}.

## Scenario

A synthetic supplier invoice for office supplies is ingested and assigned to the February Docset. A synthetic bookkeeping proposal is recorded and approved, which publishes a new Company State. A payment confirmation then arrives and creates Docset version ${result.revised_docset_ref.version}.

## Input evidence

| Evidence | Visible input | Period | Document | Bytes |
| --- | --- | --- | --- | ---: |
| Supplier invoice 1042, 1 250.00 SEK | [${result.ingested_evidence.filename}](input/${result.ingested_evidence.filename}) | ${result.ingested_evidence.period_id} | ${shortReference(result.ingested_evidence.document_ref)} | ${result.ingested_evidence.byte_length} |
| Payment confirmation for invoice 1042 | [${result.newly_arrived_evidence.filename}](input/${result.newly_arrived_evidence.filename}) | ${result.newly_arrived_evidence.period_id} | ${shortReference(result.newly_arrived_evidence.document_ref)} | ${result.newly_arrived_evidence.byte_length} |

The files under \`input/\` contain the exact bytes passed to \`CompanyRecord.ingest\`. Company Record's authoritative preserved copies are under \`store/\`.

## Lifecycle

| Step | Result | Reference |
| --- | --- | --- |
| Ingest supplier invoice | Recorded in the immutable Log | ${shortReference(result.ingested_evidence.log_item_ref)} |
| Create working Docset | Invoice assigned to version ${result.initial_docset_ref.version} | ${shortReference(result.initial_docset_ref)} |
| Prepare consolidation case | Exact Docset and preceding State frozen | ${shortReference(result.consolidation_case_ref)} |
| Record proposal | Complete proposal sealed | ${shortReference(result.approved_run_ref)} |
| Approve proposal | Exact proposal approved | ${shortReference(result.approval_receipt_ref)} |
| Publish State | Bookkeeping domain State published | ${shortReference(result.published_state_ref)} |
| Ingest payment confirmation | New evidence recorded in the Log | ${shortReference(result.newly_arrived_evidence.log_item_ref)} |
| Revise working Docset | Payment evidence added in version ${result.revised_docset_ref.version} | ${shortReference(result.revised_docset_ref)} |

## Safety checks

| Check | Result | Detail |
| --- | --- | --- |
| Approve a proposal prepared before the Docset revision | **[OK] Rejected** | \`${result.stale_rejection.code}\`: ${result.stale_rejection.message} |
| Read a stored proposal after its bytes were changed | **[OK] Detected** | \`${result.tamper_rejection.code}\`: ${result.tamper_rejection.message} |

## Inspect the run

- [Detailed timeline](timeline.md)
- [Complete machine-readable summary](summary.json)
- [Machine-readable timeline](timeline.json)
- [Inspectable Company Record store](store/)

## Module boundary

The bookkeeping \`ModuleOutcome\` in this scenario is synthetic. The demo does not call the Bookkeeping module: it tests Company Record independently as the authority for evidence, Docsets, proposals, approvals, State, integrity, and history.
`;
}

function shortReference(reference) {
  return `\`${reference.schema_id}:${reference.stable_id}@${reference.version} (${reference.sha256.slice(0, 12)}…)\``;
}

async function rejectedCode(operation) {
  try {
    await operation();
    throw new Error("Expected operation to be rejected");
  } catch (error) {
    if (!error?.code?.startsWith("BERGBOK_")) throw error;
    return { code: error.code, message: error.message };
  }
}

function incrementingClock(start) {
  let value = new Date(start).valueOf();
  return () => {
    const result = new Date(value);
    value += 1_000;
    return result;
  };
}
