import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { consolidate, consolidateOffline } from "../../bookkeeping/src/index.mjs";
import { render } from "../src/index.mjs";
import { renderReportHtml } from "../src/private/report/html.mjs";
import { formatMoneyNumberDisplay } from "../src/private/report/money-format.mjs";
import { buildReportModel } from "../src/private/report/model.mjs";
import { renderReportPdf } from "../src/private/report/pdf.mjs";
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
      source_id: "coffee-1", date: "2026-05-12", description: "INTERNAL_CANONICAL_COFFEE_DESCRIPTION", evidence_document_ids: ["receipt.pdf"],
      lines: [
        { account: "7690", account_name: "Other personnel costs", debit: "25.00 SEK", credit: "0.00 SEK" },
        { account: "1930", account_name: "Bank", debit: "0.00 SEK", credit: "25.00 SEK" },
      ],
    }],
    open_item_changes: [{ action: "open", item_id: "supplier:coffee", kind: "supplier_payable", party: "Café AB", amount: "25.00 SEK", due_date: "2026-05-31", evidence_document_ids: ["receipt.pdf"] }],
    reconciliations: [{ account: "1930", external_closing_balance: "475.00 SEK", evidence_document_ids: ["receipt.pdf"] }],
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
  const outcome = structuredClone(await consolidate(caseBundle));
  outcome.review.transaction_summaries[0].summary = language === "sv"
    ? "Café AB tog 25,00 kr för kaffe, vilket bokförs på Övriga personalkostnader (7690) mot Företagskonto (1930). Momsen har inte lyfts eftersom underlaget saknar specificerad moms."
    : "Café AB charged SEK 25.00 for coffee, booked to Other personnel costs (7690) against Bank (1930).";
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

// A Start period is the only case that initializes core company facts, so it is the
// only way to reach the company-facts report section.
async function bookkeepingStartSnapshot(language = "sv", core = {}) {
  const previous = createStateEnvelope({ companyId: "example-ab", sequence: 0, core: {}, domains: {} });
  const input = {
    schema_id: "se.bergbok.bookkeeping-input", schema_version: "3.0", company_id: "example-ab", period_id: "Start", mode: "start",
    transactions: [],
  };
  const documents = [
    { document_id: "registration.pdf", filename: "registration.pdf", role: "evidence", media_type: "application/pdf", content_base64: Buffer.from("%PDF-demo").toString("base64") },
  ];
  const docset = sealContent({ schemaId: "se.bergbok.docset", stableId: "example-ab:Start:docset", version: 1, payload: { documents } });
  const caseBundle = sealContent({
    schemaId: "se.bergbok.consolidation-case", stableId: "example-ab:Start:bookkeeping", version: 1,
    payload: {
      contract_version: "1.0", company_id: "example-ab", domain: "bookkeeping", language,
      period: { id: "Start", kind: "start", end: "2026-05-11" }, docset, previous_state: previous,
      effective_policies: {
        core: { country: "SE", currency: "SEK", fiscal_year: { start: "2026-01-01", end: "2026-12-31" }, accounting_method: "invoice" },
        bookkeeping: { profile: "se-private-ab-invoice-calendar-demo-v1", verification_series: "A", chart_of_accounts: "BAS", vat_reporting: { frequency: "quarterly", input_accounts: ["2641"], output_accounts: ["2611"], settlement_account: "2650" } },
      },
      upstream_results: [],
    },
  });
  const outcome = structuredClone(consolidateOffline(caseBundle, "offline-deterministic-v3", {
    input,
    core: {
      organization: { name: "Fiktiv AB", organization_number: "559999-0008" },
      registrations: { vat_number: "SE559999000801", eori_number: "SE5599990008" },
      address: { street: "Karl Gerhards väg 27", postal_code: "133 35", city: "Saltsjöbaden", country: "SE" },
      policies: {
        bookkeeping: {
          chart_of_accounts: "BAS",
          vat_reporting: { frequency: "quarterly", input_accounts: ["2641"], output_accounts: ["2611"], settlement_account: "2650" },
        },
      },
      evidence_document_ids: ["registration.pdf"],
      ...core,
    },
  }));
  const runRef = createContentRef({ schemaId: "se.bergbok.consolidation-run", stableId: "example-ab:Start:bookkeeping:run", version: 1, payload: outcome });
  return sealContent({
    schemaId: "se.bergbok.output-snapshot", schemaVersion: "2.0", stableId: `${runRef.stable_id}:output-snapshot`, version: "preliminary",
    payload: {
      contract_version: "2.0", approval_status: "preliminary", language, run_ref: runRef,
      approval_receipt_ref: null, proposal_digest: proposalDigest(outcome), recorded_at: "2026-03-31T12:00:00.000Z",
      context: { company_id: "example-ab", domain: "bookkeeping", period: caseBundle.payload.period, docset_ref: docset.ref, previous_state_ref: previous.ref }, outcome,
    },
  });
}

test("all artifact profiles are asynchronous, deterministic, and sealed", async () => {
  const snapshot = await bookkeepingSnapshot("approved");
  for (const profile of ["sie4-v1", "report-source-json-v1", "report-html-v1", "report-pdf-v1"]) {
    const first = await render(snapshot, profile);
    const second = await render(snapshot, profile);
    assert.deepEqual(first, second, profile);
    verifySealedContent(first);
  }
});

test("the representative report snapshot and artifacts match their golden hashes", async () => {
  const snapshot = await bookkeepingSnapshot("approved");
  const golden = JSON.parse(await readFile(new URL("./golden/artifact-hashes.json", import.meta.url), "utf8"));
  const actual = { snapshot: snapshot.ref.sha256, artifacts: {} };
  for (const profile of ["report-source-json-v1", "report-html-v1", "report-pdf-v1"]) {
    actual.artifacts[profile] = (await render(snapshot, profile)).payload.artifacts[0].sha256;
  }
  assert.deepEqual(actual, golden);
});

test("report JSON is exact and HTML is semantic, collapsed, escaped, and complete", async () => {
  const snapshot = await bookkeepingSnapshot();
  const model = buildReportModel(snapshot);
  assert.equal(model.header.identity, "Example Ångström AB · 559999-9999 · Created 31 March 2026");
  assert.equal(model.header.context, "1–31 May 2026 · Proposal");
  assert.deepEqual(model.sections.map((section) => section.id), [
    "summary", "core", "transactions", "open_items", "balances",
    "verification", "reconciliations", "vat", "evidence", "provenance",
  ]);
  assert.equal(Object.hasOwn(model.transactions[0], "description"), false);
  const source = await render(snapshot, "report-source-json-v1");
  const sourceJson = artifactBytes(source.payload.artifacts[0]).toString("utf8");
  assert.equal(sourceJson, prettyCanonicalJson(snapshot));
  assert.match(sourceJson, /INTERNAL_CANONICAL_COFFEE_DESCRIPTION/);
  const html = artifactBytes((await render(snapshot, "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(html, /<details>/);
  assert.doesNotMatch(html, /<details open/);
  assert.match(html, /Example Ångström AB · 559999-9999 · Created 31 March 2026/);
  assert.match(html, /1–31 May 2026 · Proposal/);
  assert.match(html, /Café AB charged SEK 25\.00 for coffee, booked to Other personnel costs \(7690\) against Bank \(1930\)\./);
  assert.doesNotMatch(html, /INTERNAL_CANONICAL_COFFEE_DESCRIPTION/);
  assert.match(html, /7690/);
  assert.match(html, /SEK\u00a025\.00/);
  assert.doesNotMatch(html, /25\.00 SEK/);
  assert.match(html, /<td>2081<\/td><td>Share capital<\/td><td class="money">-500\.00<\/td>.*<td class="money">-500\.00<\/td>/);
  assert.match(html, /<td><code>7690<\/code><\/td><td>Other personnel costs<\/td><td class="money">25\.00<\/td><td class="money">0\.00<\/td>/);
  assert.doesNotMatch(html, /SEK\u00a0[\d,.]+ (Debit|Credit)/);
  assert.match(html, /Verification series A · A8 · 1 entry/);
  assert.match(html, /No input or output VAT was posted in the period\. The period is part of the VAT period 1 April–30 June 2026; no VAT return is due in May 2026\./);
  assert.doesNotMatch(html, /Quarterly|2641|2611|2650/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /Questions, warnings, and reasons/);
  assert.doesNotMatch(html, /Company facts/);
  assert.doesNotMatch(html, />Evidence<\/h2>/);
  assert.doesNotMatch(html, /<h2>Summary<\/h2>/);
  assert.match(html, /<section class="report-summary"><p>The bookkeeping for 2026-05 contains 1 verification \(A8\) totalling SEK 25\.00\./);
  const headings = [
    "Bookkeeping transactions", "Open items", "Account balances",
    "Reconciliations", "VAT", "Debug",
  ];
  let previousIndex = -1;
  for (const heading of headings) {
    const index = html.indexOf(`>${heading}</h2>`);
    assert.ok(index > previousIndex, `${heading} must occur in canonical section order`);
    previousIndex = index;
  }
  assert.match(html, /<section><h2>Debug<\/h2><details class="debug-details"><summary>Show<\/summary><pre class="debug">\{/);
  assert.doesNotMatch(html, /<details class="debug-details" open/);
  assert.match(html, /&quot;module_id&quot;: &quot;se\.bergbok\.bookkeeping&quot;/);

  const htmlWithCompanyFacts = renderReportHtml({
    ...model,
    sections: model.sections.map((section) => section.id === "core"
      ? { ...section, groups: [{ id: "company", title: "Company", rows: [{ label: "Name", value: "Changed AB" }] }] }
      : section),
  });
  assert.match(htmlWithCompanyFacts, /<h2>Company facts<\/h2>/);
  assert.match(htmlWithCompanyFacts, /<h3>Company<\/h3><dl class="meta"><dt>Name<\/dt><dd>Changed AB<\/dd><\/dl>/);

  const hostileSummaryHtml = renderReportHtml({
    ...model,
    transactions: model.transactions.map((transaction, index) => index === 0
      ? { ...transaction, summary: '<img src=x onerror="alert(1)">' }
      : transaction),
    sections: model.sections.map((section) => section.id === "transactions"
      ? {
          ...section,
          items: section.items.map((transaction, index) => index === 0
            ? { ...transaction, summary: '<img src=x onerror="alert(1)">' }
            : transaction),
        }
      : section),
  });
  assert.match(hostileSummaryHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(hostileSummaryHtml, /<img src=x/);

  const hostile = structuredClone(snapshot.payload);
  hostile.outcome.canonical_outputs.bookkeeping.ledger.transactions[0].description = "HOSTILE_CANONICAL_DESCRIPTION";
  hostile.outcome.canonical_outputs.period_delta.transactions[0].description = "HOSTILE_CANONICAL_DESCRIPTION";
  hostile.proposal_digest = proposalDigest(hostile.outcome);
  const hostileSnapshot = sealContent({ schemaId: snapshot.ref.schema_id, schemaVersion: "2.0", stableId: "hostile-source", version: 1, payload: hostile });
  const hostileHtml = artifactBytes((await render(hostileSnapshot, "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.doesNotMatch(hostileHtml, /HOSTILE_CANONICAL_DESCRIPTION/);
});

test("company facts are grouped, localized, and never drop an unreported field", async () => {
  const model = buildReportModel(await bookkeepingStartSnapshot("sv"));
  assert.deepEqual(model.coreFacts.map((group) => group.title), [
    "Företag", "Adress", "Registreringar", "Bokföring", "Moms",
  ]);
  assert.deepEqual(model.coreFacts[0].rows, [
    { label: "Namn", value: "Fiktiv AB" },
    { label: "Organisationsnummer", value: "559999-0008" },
  ]);
  assert.deepEqual(model.coreFacts[1].rows, [
    { label: "Adress", value: "Karl Gerhards väg 27\n133 35 Saltsjöbaden\nSE" },
  ]);
  assert.deepEqual(model.coreFacts[2].rows, [
    { label: "Momsregistreringsnummer", value: "SE559999000801" },
    { label: "EORI-nummer", value: "SE5599990008" },
  ]);
  assert.deepEqual(model.coreFacts[3].rows, [
    { label: "Bokföringen startar", value: "2026-05-12" },
    { label: "Aktiverade moduler", value: "Bokföring" },
    { label: "Land", value: "SE" },
    { label: "Valuta", value: "SEK" },
    { label: "Bokföringsmetod", value: "faktureringsmetoden" },
    { label: "Räkenskapsår", value: "2026-01-01 – 2026-12-31" },
    { label: "Kontoplan", value: "BAS" },
  ]);
  assert.deepEqual(model.coreFacts[4].rows, [
    { label: "Redovisningsintervall", value: "Kvartalsvis" },
    { label: "Konton för ingående moms", value: "2641" },
    { label: "Konton för utgående moms", value: "2611" },
    { label: "Momsredovisningskonto", value: "2650" },
  ]);
  const html = artifactBytes((await render(await bookkeepingStartSnapshot("sv"), "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(html, /<h2>Företagsuppgifter<\/h2><p class="section-meta">Företagsuppgifter som är nya eller uppdaterade under perioden\.<\/p><h3>Företag<\/h3><dl class="meta"><dt>Namn<\/dt><dd>Fiktiv AB<\/dd>/);
  assert.match(html, /<dd>Karl Gerhards väg 27<br>133 35 Saltsjöbaden<br>SE<\/dd>/);
  assert.doesNotMatch(html, /organization\.name|vat_reporting|input_accounts\[0\]/);
  const pdf = await pdfText(artifactBytes((await render(await bookkeepingStartSnapshot("sv"), "report-pdf-v1")).payload.artifacts[0]));
  assert.match(pdf, /^Företagsuppgifter$/m);
  assert.match(pdf.replace(/\s+/g, " "), /Företagsuppgifter som är nya eller uppdaterade under perioden\./);
  for (const row of model.coreFacts.flatMap((group) => [group.title, ...group.rows.map((item) => item.label)])) {
    assert.ok(pdf.includes(row), `PDF must contain ${row}`);
  }
  assert.match(pdf.replace(/\s+/g, " "), /Adress Karl Gerhards väg 27 133 35 Saltsjöbaden SE/);

  const english = buildReportModel(await bookkeepingStartSnapshot("en"));
  assert.deepEqual(english.coreFacts.map((group) => group.title), [
    "Company", "Address", "Registrations", "Bookkeeping", "VAT",
  ]);
  assert.deepEqual(english.coreFacts[3].rows[4], { label: "Accounting method", value: "Invoice method" });
  const englishHtml = artifactBytes((await render(await bookkeepingStartSnapshot("en"), "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(englishHtml, /<h2>Company facts<\/h2><p class="section-meta">Company facts that are new or updated in this period\.<\/p><h3>Company<\/h3>/);

  const extended = buildReportModel(await bookkeepingStartSnapshot("sv", {
    registrations: { vat_number: "SE559999000801", f_tax: true },
    address: { street: "Karl Gerhards väg 27", postal_code: "133 35", city: "Saltsjöbaden", country: "SE", care_of: "c/o Bergbok" },
  }));
  const address = extended.coreFacts.find((group) => group.id === "address");
  assert.deepEqual(address.rows[1], { label: "care_of", value: "c/o Bergbok" });
  const registrations = extended.coreFacts.find((group) => group.id === "registrations");
  assert.deepEqual(registrations.rows, [
    { label: "Momsregistreringsnummer", value: "SE559999000801" },
    { label: "f_tax", value: "true" },
  ]);
});

test("the PDF contains the reader-facing report with Unicode text", async () => {
  const snapshot = await bookkeepingSnapshot();
  const model = buildReportModel(snapshot);
  const bytes = artifactBytes((await render(snapshot, "report-pdf-v1")).payload.artifacts[0]);
  assert.match(bytes.subarray(0, 8).toString("latin1"), /^%PDF-/);
  const text = await pdfText(bytes);
  const normalizedText = text.replaceAll("\u00a0", " ");
  const compactText = normalizedText.replace(/\s+/g, " ");
  assert.match(text, /Example Ångström AB/);
  assert.match(text, /Created 31 March 2026/);
  assert.match(text, /1–31 May 2026 · Proposal/);
  assert.match(text, /Café AB charged SEK 25\.00 for coffee, booked to Other personnel costs \(7690\) against Bank \(1930\)\./);
  assert.doesNotMatch(text, /INTERNAL_CANONICAL_COFFEE_DESCRIPTION/);
  assert.match(text, /Other personnel costs/);
  assert.match(text, /supplier:coffee/);
  assert.match(text, /1930/);
  assert.match(text, /Verification series A · A8 · 1 entry/);
  assert.match(compactText, /No input or output VAT was posted in the period\. The period is part of the VAT period 1 April–30 June 2026; no VAT return is due in May 2026\./);
  assert.doesNotMatch(text, /Quarterly|2641|2611|2650/);
  assert.doesNotMatch(text.slice(text.lastIndexOf("\nVAT\n")), /2026-04-01|2026-06-30/);
  assert.doesNotMatch(text, /^Summary$/m);
  assert.doesNotMatch(text, /^Company facts$/m);
  assert.doesNotMatch(text, /^Debug$/m);
  assert.doesNotMatch(text, /"module_id": "se\.bergbok\.bookkeeping"/);
  assert.match(text, /SEK\s25\.00/);
  assert.doesNotMatch(text, /25\.00 SEK/);
  for (const label of [
    model.labels.transactions, model.labels.openItems, model.labels.balances,
    model.labels.reconciliations, model.labels.vat,
  ]) assert.ok(text.includes(label), `PDF must contain ${label}`);
  for (const transaction of model.transactions) {
    assert.ok(text.includes(transaction.sourceId));
    assert.ok(text.includes(transaction.summary));
    for (const line of transaction.lines) {
      assert.ok(text.includes(line.account));
      assert.ok(normalizedText.includes(formatMoneyNumberDisplay(line.debit, "en")));
      assert.ok(normalizedText.includes(formatMoneyNumberDisplay(line.credit, "en")));
    }
  }
  assert.match(compactText, /2081 Share capital -500\.00 0\.00 0\.00 -500\.00/);
  assert.match(compactText, /7690 Other personnel costs 25\.00 0\.00/);
  const suppressedSectionText = await pdfText(await renderReportPdf({
    ...model,
    sections: model.sections.map((section) => section.id === "evidence"
      ? { ...section, title: "STANDALONE EVIDENCE SECTION" }
      : section.id === "provenance"
        ? { ...section, title: "STANDALONE DEBUG SECTION", value: "DEBUG-ONLY-MARKER" }
        : section),
  }));
  assert.doesNotMatch(suppressedSectionText, /STANDALONE EVIDENCE SECTION|STANDALONE DEBUG SECTION|DEBUG-ONLY-MARKER/);
  const swedishBytes = artifactBytes((await render(await bookkeepingSnapshot("approved", "sv"), "report-pdf-v1")).payload.artifacts[0]);
  const swedishText = await pdfText(swedishBytes);
  const compactSwedishText = swedishText.replace(/\s+/g, " ");
  assert.match(swedishText, /25,00\s*kr/);
  assert.match(compactSwedishText, /7690 Other personnel costs 25,00 0,00/);
  assert.match(compactSwedishText, /Momsen har inte lyfts eftersom underlaget saknar specificerad moms\./);
  assert.doesNotMatch(swedishText, /INTERNAL_CANONICAL_COFFEE_DESCRIPTION/);

  const emptyOpenItemsModel = {
    ...model,
    sections: model.sections.map((section) => section.id === "open_items"
      ? { ...section, groups: section.groups.map((group) => ({ ...group, items: [] })) }
      : section),
  };
  const emptyOpenItemsText = await pdfText(await renderReportPdf(emptyOpenItemsModel));
  assert.match(emptyOpenItemsText, /No open items at the end of the period\./);
  assert.doesNotMatch(emptyOpenItemsText, /^Changes$/m);
  assert.doesNotMatch(emptyOpenItemsText, /^Closing items$/m);
});

test("the report model fails closed on summary and State inconsistencies", async () => {
  const snapshot = await bookkeepingSnapshot();
  const missingSummary = structuredClone(snapshot.payload);
  missingSummary.outcome.review.transaction_summaries = [];
  missingSummary.proposal_digest = proposalDigest(missingSummary.outcome);
  const invalidSummary = sealContent({ schemaId: snapshot.ref.schema_id, schemaVersion: "2.0", stableId: "missing-summary", version: 1, payload: missingSummary });
  assert.throws(() => buildReportModel(invalidSummary), /Missing transaction summary/);

  const inconsistent = structuredClone(snapshot.payload);
  inconsistent.outcome.canonical_outputs.bookkeeping.ledger.closing_balances[0].debit = "476.00 SEK";
  inconsistent.proposal_digest = proposalDigest(inconsistent.outcome);
  const invalidState = sealContent({ schemaId: snapshot.ref.schema_id, schemaVersion: "2.0", stableId: "bad-state", version: 1, payload: inconsistent });
  assert.throws(() => buildReportModel(invalidState), /projected closing balances/);

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
  assert.throws(() => buildReportModel(invalidStructure), /unreported fields: unreported_state/);
});

test("unapproved reports are explicitly marked and approved reports are not", async () => {
  const preview = artifactBytes((await render(await bookkeepingSnapshot("preliminary", "sv"), "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(preview, /Example Ångström AB · 559999-9999 · Skapad 31 mars 2026/);
  assert.match(preview, /1–31 maj 2026 · Förslag/);
  assert.match(preview, /Ingenting har godkänts/);
  assert.match(preview, /Ingen ingående eller utgående moms bokfördes i perioden/);
  assert.doesNotMatch(preview, /Kvartalsvis/);
  const approved = artifactBytes((await render(await bookkeepingSnapshot("approved", "sv"), "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(approved, /1–31 maj 2026 · Godkänd version 1/);
  assert.match(approved, /25,00\u00a0kr/);
  assert.match(approved, /Momsen har inte lyfts eftersom underlaget saknar specificerad moms\./);
  assert.doesNotMatch(approved, /INTERNAL_CANONICAL_COFFEE_DESCRIPTION/);
  assert.match(approved, /<section><h2>Debug<\/h2><details class="debug-details"><summary>Visa<\/summary>/);
  assert.doesNotMatch(approved, /Ingenting har godkänts/);
  assert.doesNotMatch(approved, /Frågor, varningar och orsaker/);
});

test("VAT artifacts use deterministic cycle dates from Bookkeeping v3", async () => {
  const source = await bookkeepingSnapshot("approved");
  const reportModel = buildReportModel(source);
  const reportHtml = renderReportHtml({
    ...reportModel,
    sections: reportModel.sections.map((section) => section.id === "vat"
      ? {
          ...section,
          value: {
            ...section.value,
            hasActivity: true,
            due_in_period: true,
            closing_transaction_source_id: "vat-close:2026-Q2",
            declaration_boxes: { "10": "25.00 SEK", "11": "0.00 SEK", "12": "0.00 SEK", "48": "0.00 SEK", "49": "25.00 SEK" },
          },
        }
      : section),
  });
  assert.match(reportHtml, /Reporting frequency/);
  assert.match(reportHtml, /Quarterly/);
  assert.match(reportHtml, /Declaration boxes/);
  const reportPdfText = await pdfText(await renderReportPdf({
    ...reportModel,
    sections: reportModel.sections.map((section) => section.id === "vat"
      ? {
          ...section,
          value: {
            ...section.value,
            hasActivity: true,
            due_in_period: true,
            closing_transaction_source_id: "vat-close:2026-Q2",
            declaration_boxes: { "10": "25.00 SEK", "11": "0.00 SEK", "12": "0.00 SEK", "48": "0.00 SEK", "49": "25.00 SEK" },
          },
        }
      : section),
  }));
  assert.match(reportPdfText, /Reporting frequency/);
  assert.match(reportPdfText, /Quarterly/);
  assert.match(reportPdfText, /Declaration boxes/);
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

test("needs-input and out-of-scope outcomes use the same complete report pipeline", async () => {
  const needsInput = buildReportModel(await classifiedSnapshot("needs_input"));
  assert.equal(needsInput.outcomeKind, "needs_input");
  assert.equal(needsInput.questions[0].text, "Vilket belopp gäller?");
  assert.deepEqual(needsInput.transactions, []);
  const needsHtml = artifactBytes((await render(await classifiedSnapshot("needs_input"), "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(needsHtml, /Frågor, varningar och orsaker/);
  assert.match(needsHtml, /Vilket belopp gäller\?/);
  assert.match(needsHtml, /Bokföringstransaktioner<\/h2><p class="empty">Inga\.<\/p>/);
  assert.match(needsHtml, /Öppna poster<\/h2><p>Inga öppna poster vid periodens slut\.<\/p>/);
  assert.doesNotMatch(needsHtml, /Förändringar<\/h3>|Kvarstående poster<\/h3>/);

  const outside = buildReportModel(await classifiedSnapshot("out_of_scope"));
  assert.equal(outside.outcomeKind, "out_of_scope");
  assert.equal(outside.reasons[0].text, "Ärendet kräver stöd utanför piloten.");
});

test("unrelated SIE and payslip profiles still render from OutputSnapshot v2", async () => {
  const sie = await render(await bookkeepingSnapshot("approved"), "sie4-v1");
  const sieText = artifactBytes(sie.payload.artifacts[0]).toString("utf8");
  assert.match(sieText, /#VER "A" 8 20260512/);
  assert.match(sieText, /INTERNAL_CANONICAL_COFFEE_DESCRIPTION/);
  const payslip = await render(payrollSnapshot(), "payslips-pdf-v1");
  assert.match(artifactBytes(payslip.payload.artifacts[0]).toString("latin1"), /Lönespecifikation/);
});

test("Artifacts rejects legacy OutputSnapshot shapes", async () => {
  const legacy = sealContent({ schemaId: "se.bergbok.output-snapshot", stableId: "legacy", version: 1, payload: { approval_status: "preliminary", canonical_outputs: {} } });
  await assert.rejects(render(legacy, "sie4-v1"), /output-snapshot 2.0/);
});

test("report rendering rejects Bookkeeping v2 structures", async () => {
  const source = await bookkeepingSnapshot();
  const payload = structuredClone(source.payload);
  payload.outcome.canonical_outputs.bookkeeping.schema_version = "2.0";
  payload.proposal_digest = proposalDigest(payload.outcome);
  const snapshot = sealContent({ schemaId: source.ref.schema_id, schemaVersion: "2.0", stableId: "bookkeeping-v2-snapshot", version: 1, payload });
  await assert.rejects(render(snapshot, "report-html-v1"), /Bookkeeping output and period delta schema 3\.0/);
});
