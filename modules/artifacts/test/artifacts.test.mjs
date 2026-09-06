import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { consolidate } from "../../bookkeeping/src/index.mjs";
import { render } from "../src/index.mjs";
import { buildReviewModel } from "../src/private/review/model.mjs";
import { prettyCanonicalJson, sha256Bytes } from "../../../contracts/src/canonical.mjs";
import { createContentRef, createModuleOutcome, createStateEnvelope, proposalDigest, sealContent, verifySealedContent } from "../../../contracts/src/index.mjs";

async function bookkeepingSnapshot(status = "preliminary", language = "en") {
  const previous = createStateEnvelope({
    companyId: "example-ab",
    sequence: 2,
    core: { organization: { name: "Example Ångström AB", organization_number: "559999-9999" } },
    domains: {
      bookkeeping: {
        contract_version: "1.0", status: "projected", schema_id: "se.bergbok.bookkeeping.state", schema_version: "3.0",
        company_id: "example-ab", through_period_id: "2026-04", through_date: "2026-04-30", currency: "SEK",
        ledger: {
          balances: [
            { account: "1930", account_name: "Bank", debit: "500.00 SEK", credit: "0.00 SEK" },
            { account: "2081", account_name: "Share capital", debit: "0.00 SEK", credit: "500.00 SEK" },
          ],
          verification_series: { series: "A", last_number: 7 },
        },
        open_items: { items: [], totals: { count: 0, by_kind: {} } },
        reconciliation: { period_id: "2026-04", accounts: [] },
        vat: { frequency: "quarterly", cycle_start: "2026-04-01", cycle_end: "2026-06-30", due_in_period: false, input_accounts: ["2641"], output_accounts: ["2611"], settlement_account: "2650", status: "not_due", closing_transaction_source_id: null, declaration_boxes: {} },
      },
    },
  });
  const input = {
    schema_id: "se.bergbok.bookkeeping-input", schema_version: "3.0", company_id: "example-ab", period_id: "2026-05", mode: "ordinary",
    transactions: [{
      source_id: "coffee-1", date: "2026-05-12", description: "Coffee & supplies", evidence_document_ids: ["receipt.pdf"],
      lines: [
        { account: "7690", account_name: "Other personnel costs", debit: "25.00 SEK", credit: "0.00 SEK" },
        { account: "1930", account_name: "Bank", debit: "0.00 SEK", credit: "25.00 SEK" },
      ],
    }],
    open_item_changes: [{ action: "open", item_id: "supplier:coffee", kind: "supplier_payable", party: "Café AB", amount: "25.00 SEK", due_date: "2026-05-31", evidence_document_ids: ["receipt.pdf"] }],
    reconciliations: [{ account: "1930", external_closing_balance: "475.00 SEK", evidence_document_ids: ["receipt.pdf"] }],
    vat: { status: "not_due", closing_transaction_source_id: null, declaration_boxes: null },
  };
  const documents = [
    { document_id: "receipt.pdf", filename: "receipt.pdf", role: "evidence", media_type: "application/pdf", content_base64: Buffer.from("%PDF-demo").toString("base64") },
    { document_id: "input.json", filename: "input.json", role: "bookkeeping-input", media_type: "application/json", content_base64: Buffer.from(JSON.stringify(input)).toString("base64") },
  ];
  const docset = sealContent({ schemaId: "se.bergbok.docset", stableId: "example-ab:2026-05:docset", version: 1, payload: { documents } });
  const caseBundle = sealContent({
    schemaId: "se.bergbok.consolidation-case", stableId: "example-ab:2026-05:bookkeeping", version: 1,
    payload: {
      contract_version: "1.0", company_id: "example-ab", domain: "bookkeeping", language,
      period: { id: "2026-05", kind: "ordinary", start: "2026-05-01", end: "2026-05-31" }, docset, previous_state: previous,
      effective_policies: {
        core: { country: "SE", currency: "SEK", fiscal_year: { start: "2026-01-01", end: "2026-12-31" }, accounting_method: "invoice" },
        bookkeeping: { profile: "se-private-ab-invoice-calendar-demo-v1", verification_series: "A", chart_of_accounts: "BAS", vat_reporting: { frequency: "quarterly", input_accounts: ["2641"], output_accounts: ["2611"], settlement_account: "2650" } },
      },
      upstream_results: [],
    },
  });
  const outcome = await consolidate(caseBundle);
  const runRef = createContentRef({ schemaId: "se.bergbok.consolidation-run", stableId: "example-ab:2026-05:bookkeeping:run", version: 1, payload: outcome });
  return sealContent({
    schemaId: "se.bergbok.output-snapshot", schemaVersion: "2.0", stableId: `${runRef.stable_id}:output-snapshot`, version: status === "approved" ? "approved:test" : "preliminary",
    payload: {
      contract_version: "2.0", approval_status: status, language, run_ref: runRef,
      approval_receipt_ref: status === "approved" ? createContentRef({ schemaId: "se.bergbok.approval-receipt", stableId: "receipt", version: 1, payload: {} }) : null,
      proposal_digest: proposalDigest(outcome), recorded_at: "2026-03-31T12:00:00.000Z",
      context: { company_id: "example-ab", domain: "bookkeeping", period: caseBundle.payload.period, docset_ref: docset.ref, previous_state_ref: previous.ref }, outcome,
    },
  });
}

function payrollSnapshot() {
  const caseRef = createContentRef({ schemaId: "se.bergbok.consolidation-case", stableId: "example:payroll", version: 1, payload: {} });
  const outcome = createModuleOutcome({
    kind: "needs_input", domain: "payroll", caseRef, questions: [{ question_id: "P1", prompt: "test" }],
    canonicalOutputs: { payroll: { schema_version: "2.0", period_id: "2026-03", payslips: [{ employee_id: "employee-1", employee_name: "Demo Employee", period_id: "2026-03", gross_pay: "30000.00 SEK", tax_withheld: "9000.00 SEK", net_pay: "21000.00 SEK" }] } },
    review: { language: "sv", summary: "Löneunderlaget behöver kompletteras." },
  });
  const runRef = createContentRef({ schemaId: "se.bergbok.consolidation-run", stableId: "example:payroll:run", version: 1, payload: outcome });
  return sealContent({
    schemaId: "se.bergbok.output-snapshot", schemaVersion: "2.0", stableId: "example:payroll:snapshot", version: "preliminary",
    payload: { contract_version: "2.0", approval_status: "preliminary", language: "sv", run_ref: runRef, approval_receipt_ref: null, proposal_digest: null, recorded_at: "2026-03-31T12:00:00.000Z", context: { company_id: "example", domain: "payroll", period: { id: "2026-03", kind: "ordinary", start: "2026-03-01", end: "2026-03-31" }, docset_ref: caseRef, previous_state_ref: caseRef }, outcome },
  });
}

async function classifiedSnapshot(kind, language = "sv") {
  const source = await bookkeepingSnapshot("preliminary", language);
  const outcome = createModuleOutcome({
    kind,
    domain: "bookkeeping",
    caseRef: source.payload.outcome.case_ref,
    questions: kind === "needs_input" ? [{ question_id: "BKQ1", code: "MISSING_AMOUNT", prompt: "Vilket belopp gäller?" }] : [],
    reasons: kind === "out_of_scope" ? [{ code: "OUTSIDE_PROFILE", message: "Ärendet kräver stöd utanför piloten." }] : [],
    warnings: [{ code: "CHECK_SOURCE", message: "Kontrollera underlaget." }],
    review: {
      schema_version: "1.0",
      language,
      narrative_source: "ai",
      summary: kind === "needs_input" ? "En fråga behöver besvaras." : "Ärendet ligger utanför stöd.",
      transaction_summaries: [],
    },
    provenance: { module_id: "test.bookkeeping", module_version: "3.0.0" },
  });
  const runRef = createContentRef({
    schemaId: "se.bergbok.consolidation-run",
    stableId: `example-ab:2026-03:bookkeeping:${kind}`,
    version: 1,
    payload: outcome,
  });
  return sealContent({
    schemaId: source.ref.schema_id,
    schemaVersion: "2.0",
    stableId: `${kind}-snapshot`,
    version: 1,
    payload: { ...structuredClone(source.payload), run_ref: runRef, outcome, proposal_digest: null },
  });
}

function artifactBytes(artifact) {
  const bytes = Buffer.from(artifact.content_base64, "base64");
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(sha256Bytes(bytes), artifact.sha256);
  return bytes;
}

async function pdfText(bytes) {
  return new Promise((resolve, reject) => {
    const process = spawn("pdftotext", ["-", "-"]);
    const output = [];
    const errors = [];
    process.stdout.on("data", (chunk) => output.push(chunk));
    process.stderr.on("data", (chunk) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => code === 0
      ? resolve(Buffer.concat(output).toString("utf8"))
      : reject(new Error(Buffer.concat(errors).toString("utf8") || `pdftotext exited ${code}`)));
    process.stdin.end(bytes);
  });
}

test("all artifact profiles are asynchronous, deterministic, and sealed", async () => {
  const snapshot = await bookkeepingSnapshot("approved");
  for (const profile of ["sie4-v1", "review-source-json-v1", "review-html-v1", "review-pdf-v1"]) {
    const first = await render(snapshot, profile);
    const second = await render(snapshot, profile);
    assert.deepEqual(first, second, profile);
    verifySealedContent(first);
  }
});

test("the representative review snapshot and artifacts match their golden hashes", async () => {
  const snapshot = await bookkeepingSnapshot("approved");
  const golden = JSON.parse(await readFile(new URL("./golden/artifact-hashes.json", import.meta.url), "utf8"));
  const actual = { snapshot: snapshot.ref.sha256, artifacts: {} };
  for (const profile of ["review-source-json-v1", "review-html-v1", "review-pdf-v1"]) {
    actual.artifacts[profile] = (await render(snapshot, profile)).payload.artifacts[0].sha256;
  }
  assert.deepEqual(actual, golden);
});

test("review JSON is exact and HTML is semantic, collapsed, escaped, and complete", async () => {
  const snapshot = await bookkeepingSnapshot();
  const model = buildReviewModel(snapshot);
  assert.deepEqual(model.sections.map((section) => section.id), [
    "summary", "notices", "core", "transactions", "open_items", "balances",
    "verification", "reconciliations", "vat", "evidence", "provenance",
  ]);
  const source = await render(snapshot, "review-source-json-v1");
  assert.equal(artifactBytes(source.payload.artifacts[0]).toString("utf8"), prettyCanonicalJson(snapshot));
  const html = artifactBytes((await render(snapshot, "review-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(html, /<details>/);
  assert.doesNotMatch(html, /<details open/);
  assert.match(html, /Coffee &amp; supplies/);
  assert.match(html, /7690/);
  assert.match(html, /25\.00 SEK/);
  assert.match(html, /Quarterly/);
  assert.match(html, /2641/);
  assert.match(html, /2611/);
  assert.match(html, /2650/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script/i);
  const headings = [
    "Summary", "Questions, warnings, and reasons", "Company facts",
    "Bookkeeping transactions", "Open items", "Account balances",
    "Verification series", "Reconciliations", "VAT", "Evidence", "Provenance",
  ];
  let previousIndex = -1;
  for (const heading of headings) {
    const index = html.indexOf(`>${heading}</h2>`);
    assert.ok(index > previousIndex, `${heading} must occur in canonical section order`);
    previousIndex = index;
  }

  const hostile = structuredClone(snapshot.payload);
  hostile.outcome.canonical_outputs.bookkeeping.ledger.transactions[0].description = '<img src=x onerror="alert(1)">';
  hostile.outcome.canonical_outputs.period_delta.transactions[0].description = '<img src=x onerror="alert(1)">';
  hostile.proposal_digest = proposalDigest(hostile.outcome);
  const hostileSnapshot = sealContent({ schemaId: snapshot.ref.schema_id, schemaVersion: "2.0", stableId: "hostile-source", version: 1, payload: hostile });
  const hostileHtml = artifactBytes((await render(hostileSnapshot, "review-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(hostileHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(hostileHtml, /<img src=x/);
});

test("the PDF contains the complete expanded review with Unicode text", async () => {
  const snapshot = await bookkeepingSnapshot();
  const model = buildReviewModel(snapshot);
  const bytes = artifactBytes((await render(snapshot, "review-pdf-v1")).payload.artifacts[0]);
  assert.match(bytes.subarray(0, 8).toString("latin1"), /^%PDF-/);
  const text = await pdfText(bytes);
  assert.match(text, /Example Ångström AB/);
  assert.match(text, /Coffee & supplies/);
  assert.match(text, /Other personnel costs/);
  assert.match(text, /supplier:coffee/);
  assert.match(text, /1930/);
  assert.match(text, /Quarterly/);
  assert.match(text, /2026-04-01/);
  assert.match(text, /2026-06-30/);
  for (const label of [
    model.labels.summary, model.labels.notices, model.labels.core,
    model.labels.transactions, model.labels.openItems, model.labels.balances,
    model.labels.verification, model.labels.reconciliations, model.labels.vat,
    model.labels.evidence, model.labels.provenance,
  ]) assert.ok(text.includes(label), `PDF must contain ${label}`);
  for (const transaction of model.transactions) {
    assert.ok(text.includes(transaction.sourceId));
    assert.ok(text.includes(transaction.summary));
    for (const line of transaction.lines) {
      assert.ok(text.includes(line.account));
      assert.ok(text.includes(line.debit));
      assert.ok(text.includes(line.credit));
    }
  }
});

test("the review model fails closed on summary and State inconsistencies", async () => {
  const snapshot = await bookkeepingSnapshot();
  const missingSummary = structuredClone(snapshot.payload);
  missingSummary.outcome.review.transaction_summaries = [];
  missingSummary.proposal_digest = proposalDigest(missingSummary.outcome);
  const invalidSummary = sealContent({ schemaId: snapshot.ref.schema_id, schemaVersion: "2.0", stableId: "missing-summary", version: 1, payload: missingSummary });
  assert.throws(() => buildReviewModel(invalidSummary), /Missing transaction summary/);

  const inconsistent = structuredClone(snapshot.payload);
  inconsistent.outcome.canonical_outputs.bookkeeping.ledger.closing_balances[0].debit = "476.00 SEK";
  inconsistent.proposal_digest = proposalDigest(inconsistent.outcome);
  const invalidState = sealContent({ schemaId: snapshot.ref.schema_id, schemaVersion: "2.0", stableId: "bad-state", version: 1, payload: inconsistent });
  assert.throws(() => buildReviewModel(invalidState), /projected closing balances/);

  const unreported = structuredClone(snapshot.payload);
  const projected = unreported.outcome.projected_state;
  const resealedProjected = sealContent({
    schemaId: projected.ref.schema_id,
    schemaVersion: projected.ref.schema_version,
    stableId: projected.ref.stable_id,
    version: projected.ref.version,
    payload: { ...projected.payload, unreported_state: true },
  });
  unreported.outcome.projected_state = resealedProjected;
  unreported.outcome.proposed_changes.find((change) => change.action === "replace_domain_state").state_ref = resealedProjected.ref;
  unreported.proposal_digest = proposalDigest(unreported.outcome);
  const invalidStructure = sealContent({ schemaId: snapshot.ref.schema_id, schemaVersion: "2.0", stableId: "unreported-state", version: 1, payload: unreported });
  assert.throws(() => buildReviewModel(invalidStructure), /unreported fields: unreported_state/);
});

test("preliminary reports are marked and approved reports are not", async () => {
  const preview = artifactBytes((await render(await bookkeepingSnapshot("preliminary", "sv"), "review-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(preview, /Förhandsvisning/);
  assert.match(preview, /Kvartalsvis/);
  const approved = artifactBytes((await render(await bookkeepingSnapshot("approved", "sv"), "review-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.doesNotMatch(approved, /Förhandsvisning/);
});

test("VAT artifacts use deterministic cycle dates from Bookkeeping v3", async () => {
  const source = await bookkeepingSnapshot("approved");
  const payload = structuredClone(source.payload);
  payload.outcome.canonical_outputs.bookkeeping.vat_period = {
    frequency: "quarterly",
    cycle_start: "2026-04-01",
    cycle_end: "2026-06-30",
    due_in_period: true,
    input_accounts: ["2641"],
    output_accounts: ["2611"],
    settlement_account: "2650",
    status: "due",
    closing_transaction_source_id: "vat-close:2026-Q2",
    declaration_boxes: { "10": "25.00 SEK", "11": "0.00 SEK", "12": "0.00 SEK", "48": "0.00 SEK", "49": "25.00 SEK" },
  };
  payload.proposal_digest = proposalDigest(payload.outcome);
  const snapshot = sealContent({ schemaId: source.ref.schema_id, schemaVersion: "2.0", stableId: "due-vat-snapshot", version: "approved", payload });
  const xml = artifactBytes((await render(snapshot, "vat-xml-v1")).payload.artifacts[0]).toString("latin1");
  assert.match(xml, /<Period>202606<\/Period>/);
  const pdf = artifactBytes((await render(snapshot, "vat-verification-pdf-v1")).payload.artifacts[0]);
  const text = await pdfText(pdf);
  assert.match(text, /2026-04-01 - 2026-06-30/);
  assert.match(text, /vat-close:2026-Q2/);
});

test("needs-input and out-of-scope outcomes use the same complete review pipeline", async () => {
  const needsInput = buildReviewModel(await classifiedSnapshot("needs_input"));
  assert.equal(needsInput.outcomeKind, "needs_input");
  assert.equal(needsInput.questions[0].text, "Vilket belopp gäller?");
  assert.deepEqual(needsInput.transactions, []);
  const needsHtml = artifactBytes((await render(await classifiedSnapshot("needs_input"), "review-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(needsHtml, /Vilket belopp gäller\?/);
  assert.match(needsHtml, /Bokföringstransaktioner<\/h2><p class="empty">Inga\.<\/p>/);

  const outside = buildReviewModel(await classifiedSnapshot("out_of_scope"));
  assert.equal(outside.outcomeKind, "out_of_scope");
  assert.equal(outside.reasons[0].text, "Ärendet kräver stöd utanför piloten.");
});

test("unrelated SIE and payslip profiles still render from OutputSnapshot v2", async () => {
  const sie = await render(await bookkeepingSnapshot("approved"), "sie4-v1");
  assert.match(artifactBytes(sie.payload.artifacts[0]).toString("utf8"), /#VER "A" 8 20260512/);
  const payslip = await render(payrollSnapshot(), "payslips-pdf-v1");
  assert.match(artifactBytes(payslip.payload.artifacts[0]).toString("latin1"), /Lönespecifikation/);
});

test("Artifacts rejects legacy OutputSnapshot shapes", async () => {
  const legacy = sealContent({ schemaId: "se.bergbok.output-snapshot", stableId: "legacy", version: 1, payload: { approval_status: "preliminary", canonical_outputs: {} } });
  await assert.rejects(render(legacy, "sie4-v1"), /output-snapshot 2.0/);
});

test("review rendering rejects Bookkeeping v2 structures", async () => {
  const source = await bookkeepingSnapshot();
  const payload = structuredClone(source.payload);
  payload.outcome.canonical_outputs.bookkeeping.schema_version = "2.0";
  payload.proposal_digest = proposalDigest(payload.outcome);
  const snapshot = sealContent({ schemaId: source.ref.schema_id, schemaVersion: "2.0", stableId: "bookkeeping-v2-snapshot", version: 1, payload });
  await assert.rejects(render(snapshot, "review-html-v1"), /Bookkeeping output and period delta schema 3\.0/);
});
