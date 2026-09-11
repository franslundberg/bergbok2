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
        vat: { frequency: "quarterly", cycle_start: "2026-04-01", cycle_end: "2026-06-30", due_in_period: false, input_accounts: ["2641"], output_accounts: ["2611"], settlement_account: "2650", status: "not_due", closing_transaction_source_id: null, declaration_boxes: {}, balances_at_cycle_start: [] },
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
    open_item_changes: [{ action: "open", item_id: "supplier:coffee", date: "2026-05-12", transaction_source_id: "coffee-1", kind: "supplier_payable", party: "Café AB", amount: "25.00 SEK", due_date: "2026-05-31", evidence_document_ids: ["receipt.pdf"] }],
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
        bookkeeping: { profile: "se-private-ab-invoice-calendar-demo-v1", verification_series: "A", chart_of_accounts: "BAS", vat_reporting: { frequency: "quarterly", chart: "BAS-2026", settlement_account: "2650", box_overrides: [] } },
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
    warnings: [{ code: "CHECK_SOURCE", message: "Kontrollera underlaget.", evidence_document_ids: ["receipt.pdf"] }],
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

async function classifiedSnapshotForPeriod(kind, language, period) {
  const source = await classifiedSnapshot(kind, language);
  const payload = structuredClone(source.payload);
  payload.context.period = period;
  return sealContent({
    schemaId: source.ref.schema_id,
    schemaVersion: source.ref.schema_version,
    stableId: `${kind}-${period.id}-snapshot`,
    version: 1,
    payload,
  });
}

function snapshotWithVatPeriod(source, vatPeriod, stableId) {
  const payload = structuredClone(source.payload);
  payload.outcome.canonical_outputs.bookkeeping.vat_period = structuredClone(vatPeriod);
  payload.outcome.canonical_outputs.period_delta.vat_period = structuredClone(vatPeriod);
  const projected = payload.outcome.projected_state;
  const resealedProjected = sealContent({
    schemaId: projected.ref.schema_id,
    schemaVersion: projected.ref.schema_version,
    stableId: projected.ref.stable_id,
    version: projected.ref.version,
    payload: { ...projected.payload, vat: structuredClone(vatPeriod) },
  });
  payload.outcome.projected_state = resealedProjected;
  payload.outcome.proposed_changes.find((change) => change.action === "replace_domain_state").state_ref = resealedProjected.ref;
  payload.proposal_digest = proposalDigest(payload.outcome);
  payload.run_ref = createContentRef({
    schemaId: payload.run_ref.schema_id,
    schemaVersion: payload.run_ref.schema_version,
    stableId: payload.run_ref.stable_id,
    version: payload.run_ref.version,
    payload: payload.outcome,
  });
  return sealContent({
    schemaId: source.ref.schema_id,
    schemaVersion: source.ref.schema_version,
    stableId,
    version: source.ref.version,
    payload,
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
        bookkeeping: { profile: "se-private-ab-invoice-calendar-demo-v1", verification_series: "A", chart_of_accounts: "BAS", vat_reporting: { frequency: "quarterly", chart: "BAS-2026", settlement_account: "2650", box_overrides: [] } },
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
          vat_reporting: { frequency: "quarterly", chart: "BAS-2026", settlement_account: "2650", box_overrides: [] },
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
  assert.equal(model.header.eyebrow, "Bookkeeping report");
  assert.equal(model.header.displayTitle, "Example Ångström AB, May 2026");
  assert.equal(model.header.organizationNumber, "559999-9999");
  assert.equal(model.header.coverage, "1–31 May 2026");
  assert.equal(model.header.status, "Proposal");
  assert.equal(model.header.statusTone, "attention");
  assert.equal(model.header.created, "31 March 2026");
  assert.equal(model.balances.find((item) => item.account === "1930").usedInPeriod, true);
  assert.equal(model.balances.find((item) => item.account === "2081").usedInPeriod, false);
  assert.deepEqual(model.sections.map((section) => section.id), [
    "summary", "core", "transactions", "reconciliations", "open_items",
    "verification", "vat", "balances", "evidence", "provenance",
  ]);
  assert.equal(Object.hasOwn(model.transactions[0], "description"), false);
  const source = await render(snapshot, "report-source-json-v1");
  const sourceJson = artifactBytes(source.payload.artifacts[0]).toString("utf8");
  assert.equal(sourceJson, prettyCanonicalJson(snapshot));
  assert.match(sourceJson, /INTERNAL_CANONICAL_COFFEE_DESCRIPTION/);
  const html = artifactBytes((await render(snapshot, "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(html, /<details class="transaction"/);
  assert.doesNotMatch(html, /<details open/);
  assert.match(html, /<p class="eyebrow">Bookkeeping report<\/p>/);
  assert.match(html, /<h1>Example Ångström AB, May 2026<\/h1>/);
  assert.match(html, /<p class="lede">The bookkeeping for 2026-05 contains 1 verification \(A8\) totalling SEK 25\.00\./);
  assert.match(html, /Organisation number <b>559999-9999<\/b>/);
  assert.match(html, /Period <b>1–31 May 2026<\/b>/);
  assert.match(html, /Status <span class="pill attention">Proposal<\/span>/);
  assert.match(html, /Created <b>31 March 2026<\/b>/);
  assert.match(html, /Café AB charged SEK 25\.00 for coffee, booked to Other personnel costs \(7690\) against Bank \(1930\)\./);
  assert.doesNotMatch(html, /INTERNAL_CANONICAL_COFFEE_DESCRIPTION/);
  assert.match(html, /7690/);
  assert.match(html, /SEK\u00a025\.00/);
  assert.doesNotMatch(html, /25\.00 SEK/);
  assert.match(html, /<td>2081<\/td><td>Share capital<\/td><td class="money">-500\.00<\/td>.*<td class="money">-500\.00<\/td>/);
  const balanceHtml = html.slice(html.indexOf("<h2>Account balances</h2>"), html.indexOf("<h2>Debug</h2>"));
  assert.match(balanceHtml, /2 accounts were used during the period · 3 accounts are included in balances through the period/);
  assert.match(balanceHtml, /<details class="history-details balance-details"><summary>Show 1 other account<\/summary>/);
  assert.doesNotMatch(balanceHtml.slice(0, balanceHtml.indexOf("<details class=\"history-details balance-details\">")), /<td>2081<\/td>/);
  assert.match(balanceHtml.slice(balanceHtml.indexOf("<details class=\"history-details balance-details\">")), /<td>2081<\/td>/);
  assert.match(html, /<td><code>7690<\/code><\/td><td>Other personnel costs<\/td><td class="money">25\.00<\/td><td class="money">0\.00<\/td>/);
  assert.doesNotMatch(html, /SEK\u00a0[\d,.]+ (Debit|Credit)/);
  assert.match(html, /1 entry · A8/);
  // Open items: Kvarstående poster reads as one sentence per item, linking to the
  // verification that created it; the raw open/settle log is folded into a details block.
  assert.match(html, /<p class="section-meta">Debts and claims unpaid at the end of the period\.<\/p><ul class="list"><li>Debt of SEK\u00a025\.00 to Café AB\. Due date: 2026-05-31\. See <a href="#verifikation-A8">A8<\/a>\.<\/li><\/ul>/);
  assert.match(html, /<details class="history-details"><summary>Details \(1\)<\/summary>/);
  assert.match(html, /<td>2026-05-12<\/td><td>open<\/td><td>supplier:coffee<\/td>/);
  // Reconciliation status is translated, not the raw canonical enum value.
  assert.match(html, /<td>1930<\/td><td><span class="pill ok">Reconciled<\/span><\/td>/);
  assert.doesNotMatch(html, />reconciled</);
  const attentionReconciliationHtml = renderReportHtml({
    ...model,
    sections: model.sections.map((section) => section.id === "reconciliations"
      ? {
          ...section,
          items: [
            { ...section.items[0], status: "mismatched", statusDisplay: "Mismatched" },
            { ...section.items[0], account: "1910", status: "missing_evidence", statusDisplay: "Evidence missing" },
          ],
        }
      : section),
  });
  assert.match(attentionReconciliationHtml, /<span class="pill attention">Mismatched<\/span>/);
  assert.match(attentionReconciliationHtml, /<span class="pill attention">Evidence missing<\/span>/);
  assert.match(html, /No input or output VAT was posted in the period\. The period is part of the VAT period 1 April–30 June 2026; no VAT return is due in May 2026\./);
  assert.doesNotMatch(html, /Quarterly|2641|2611|2650/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /font-src data:/);
  assert.match(html, /@font-face \{ font-family: "Source Serif 4";[^}]+data:font\/woff2;base64,/);
  assert.match(html, /@font-face \{ font-family: "IBM Plex Sans";[^}]+data:font\/woff2;base64,/);
  assert.match(html, /@font-face \{ font-family: "IBM Plex Mono";[^}]+data:font\/woff2;base64,/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /@import|src:\s*url\(["']?https?:/i);
  assert.doesNotMatch(html, /Questions, warnings, and reasons/);
  assert.doesNotMatch(html, /Company facts/);
  assert.doesNotMatch(html, />Evidence<\/h2>/);
  assert.doesNotMatch(html, /<h2>Summary<\/h2>/);
  assert.doesNotMatch(html, /report-summary/);
  assert.doesNotMatch(html, /How this report was built|model cost|run statistics|multi-period timeline/i);
  const headings = [
    "Bookkeeping transactions", "Reconciliations", "Open items",
    "VAT", "Account balances", "Debug",
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

  const hostileHeaderHtml = renderReportHtml({
    ...model,
    summary: '<img src=x onerror="alert(2)">',
    header: { ...model.header, displayTitle: '<script>alert("title")</script>' },
  });
  assert.match(hostileHeaderHtml, /&lt;script&gt;alert\(&quot;title&quot;\)&lt;\/script&gt;/);
  assert.match(hostileHeaderHtml, /&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt;/);
  assert.doesNotMatch(hostileHeaderHtml, /<script>|<img src=x/);

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
    { label: "Kontoplan för moms", value: "BAS-2026" },
    { label: "Momsredovisningskonto", value: "2650" },
  ]);
  const html = artifactBytes((await render(await bookkeepingStartSnapshot("sv"), "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(html, /<p class="eyebrow">Bokföringsrapport<\/p>\s+<h1>Fiktiv AB, Start<\/h1>/);
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
  assert.match(englishHtml, /<h1>Fiktiv AB, Start<\/h1>/);
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
  assert.match(text, /1 entry · A8/);
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
  assert.match(preview, /<p class="eyebrow">Bokföringsrapport<\/p>/);
  assert.match(preview, /<h1>Example Ångström AB, maj 2026<\/h1>/);
  assert.match(preview, /Period <b>1–31 maj 2026<\/b>/);
  assert.match(preview, /Status <span class="pill attention">Förslag<\/span>/);
  assert.match(preview, /Skapad <b>31 mars 2026<\/b>/);
  assert.doesNotMatch(preview, /class="notice"|Ingenting har godkänts/);
  assert.match(preview, /Ingen ingående eller utgående moms bokfördes i perioden/);
  assert.doesNotMatch(preview, /Kvartalsvis/);
  assert.match(preview, /<td>1930<\/td><td><span class="pill ok">Avstämd<\/span><\/td>/);
  const approved = artifactBytes((await render(await bookkeepingSnapshot("approved", "sv"), "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(approved, /Status <span class="pill ok">Godkänd version 1<\/span>/);
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
  const activeNotDueHtml = renderReportHtml({
    ...reportModel,
    sections: reportModel.sections.map((section) => section.id === "vat"
      ? { ...section, value: { ...section.value, hasActivity: true } }
      : section),
  });
  const activeNotDueVat = activeNotDueHtml.slice(
    activeNotDueHtml.indexOf("<h2>VAT</h2>"),
    activeNotDueHtml.indexOf("<h2>Account balances</h2>"),
  );
  assert.match(activeNotDueVat, /<dt>Reporting frequency<\/dt><dd>Quarterly<\/dd>/);
  assert.match(activeNotDueVat, /<dt>Reporting period<\/dt>/);
  assert.match(activeNotDueVat, /<dt>Due in this period<\/dt><dd>No<\/dd>/);
  assert.doesNotMatch(activeNotDueVat, /<dt>Status<\/dt>|Input VAT accounts|Output VAT accounts|VAT settlement account|VAT closing transaction|Declaration boxes|<table>/);
  const canonicalVat = source.payload.outcome.canonical_outputs.bookkeeping.vat_period;
  const positiveSnapshot = snapshotWithVatPeriod(source, {
    ...canonicalVat,
    due_in_period: true,
    status: "due",
    closing_transaction_source_id: "vat-close:2026-Q2",
    declaration_boxes: { "10": "25.00 SEK", "11": "0.00 SEK", "12": "0.00 SEK", "48": "0.00 SEK", "49": "25.00 SEK" },
  }, "positive-vat-snapshot");
  const positiveModel = buildReportModel(positiveSnapshot);
  const reportHtml = renderReportHtml(positiveModel);
  const dueVat = reportHtml.slice(
    reportHtml.indexOf("<h2>VAT</h2>"),
    reportHtml.indexOf("<h2>Account balances</h2>"),
  );
  assert.match(dueVat, /<dt>Reporting frequency<\/dt><dd>Quarterly<\/dd>/);
  assert.match(dueVat, /<dt>Due in this period<\/dt><dd>Yes<\/dd>/);
  assert.match(dueVat, /<th>Declaration box<\/th>/);
  assert.match(dueVat, /Box 10 — Output VAT 25%/);
  assert.doesNotMatch(dueVat, /Box 11|Box 12|Box 48/);
  assert.match(dueVat, /VAT to pay \(box 49\)<\/td><td class="money">SEK\u00a025\.00<\/td>/);
  assert.doesNotMatch(dueVat, /<dt>Status<\/dt>|Input VAT accounts|Output VAT accounts|VAT settlement account|VAT closing transaction/);

  const unknownSnapshot = snapshotWithVatPeriod(source, {
    ...canonicalVat,
    due_in_period: true,
    status: "due",
    closing_transaction_source_id: "vat-close:unknown-box",
    declaration_boxes: { "49": "1.00 SEK", "99": "1.00 SEK" },
  }, "unknown-html-vat-box-snapshot");
  assert.match(renderReportHtml(buildReportModel(unknownSnapshot)), /<td>Box 99<\/td>/);

  const swedishSource = await bookkeepingSnapshot("approved", "sv");
  const swedishVat = swedishSource.payload.outcome.canonical_outputs.bookkeeping.vat_period;
  const refundSnapshot = snapshotWithVatPeriod(swedishSource, {
    ...swedishVat,
    due_in_period: true,
    status: "due",
    closing_transaction_source_id: "vat-closing",
    declaration_boxes: {
      "10": "0.00 SEK", "22": "1749.00 SEK", "30": "437.00 SEK", "48": "1588.00 SEK",
      "49": "-400.00 SEK", "50": "0.00 SEK", "60": "751.00 SEK",
    },
  }, "refund-vat-snapshot");
  const refundHtml = renderReportHtml(buildReportModel(refundSnapshot));
  const refundVat = refundHtml.slice(refundHtml.indexOf("<h2>Moms</h2>"), refundHtml.indexOf("<h2>Kontosaldon</h2>"));
  assert.deepEqual([...refundVat.matchAll(/<tr><td>Ruta (\d{2}) —/g)].map((match) => match[1]), ["22", "30", "48", "60"]);
  assert.match(refundVat, /Ruta 22 — Inköp av tjänster från land utanför EU/);
  assert.match(refundVat, /Moms att få tillbaka \(ruta 49\)<\/td><td class="money">400,00\u00a0kr<\/td>/);

  const zeroSnapshot = snapshotWithVatPeriod(source, {
    ...canonicalVat,
    due_in_period: true,
    status: "due",
    closing_transaction_source_id: "vat-close:zero",
    declaration_boxes: { "10": "0.00 SEK", "49": "0.00 SEK" },
  }, "zero-vat-snapshot");
  const zeroHtml = renderReportHtml(buildReportModel(zeroSnapshot));
  const zeroVat = zeroHtml.slice(zeroHtml.indexOf("<h2>VAT</h2>"), zeroHtml.indexOf("<h2>Account balances</h2>"));
  assert.doesNotMatch(zeroVat, /<h3>Declaration boxes<\/h3>|<table>/);
  assert.match(zeroVat, /<strong>No VAT to pay or receive \(box 49\): SEK\u00a00\.00<\/strong>/);

  const reportPdfText = await pdfText(await renderReportPdf(positiveModel));
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

test("the eSKD file carries every box the mapping fills, not only domestic VAT", async () => {
  // A real quarter from the Fiktiv AB demo: no sales at all, reverse charge on
  // services from outside the EU, and imported goods. Before the mapping, a
  // declaration like this went out as domestic VAT and nothing else.
  const source = await bookkeepingSnapshot("approved");
  const payload = structuredClone(source.payload);
  payload.outcome.canonical_outputs.bookkeeping.vat_period = {
    frequency: "quarterly",
    chart: "BAS-2026",
    cycle_start: "2026-07-01",
    cycle_end: "2026-09-30",
    due_in_period: true,
    input_accounts: ["2641", "2645"],
    output_accounts: ["2614", "2615"],
    settlement_account: "2650",
    status: "due",
    closing_transaction_source_id: "vat-close:2026-Q3",
    notes: [],
    balances_at_cycle_start: [],
    declaration_boxes: {
      "10": "0.00 SEK",
      "22": "1749.00 SEK",
      "30": "437.00 SEK",
      "48": "1588.00 SEK",
      "49": "-400.00 SEK",
      "50": "3009.00 SEK",
      "60": "751.00 SEK",
    },
  };
  payload.proposal_digest = proposalDigest(payload.outcome);
  const snapshot = sealContent({ schemaId: source.ref.schema_id, schemaVersion: "2.0", stableId: "q3-vat-snapshot", version: "approved", payload });
  const xml = artifactBytes((await render(snapshot, "vat-xml-v1")).payload.artifacts[0]).toString("latin1");

  assert.match(xml, /<InkopTjanstUtomEg>1749<\/InkopTjanstUtomEg>/);
  assert.match(xml, /<MomsInkopUtgHog>437<\/MomsInkopUtgHog>/);
  assert.match(xml, /<MomsUlagImport>3009<\/MomsUlagImport>/);
  assert.match(xml, /<MomsImportUtgHog>751<\/MomsImportUtgHog>/);
  assert.match(xml, /<MomsIngAvdr>1588<\/MomsIngAvdr>/);
  assert.match(xml, /<MomsBetala>-400<\/MomsBetala>/);
  // A company with no sales must not claim domestic output VAT.
  assert.doesNotMatch(xml, /MomsUtgHog/);
  // Elements follow box order, which is the order the form is laid out in.
  const order = [...xml.matchAll(/<(\w+)>-?\d+<\/\1>/g)]
    .map((match) => match[1])
    .filter((element) => element !== "Period");
  assert.deepEqual(order, [
    "InkopTjanstUtomEg", "MomsInkopUtgHog", "MomsIngAvdr", "MomsUlagImport",
    "MomsImportUtgHog", "MomsBetala",
  ]);
});

test("a declaration box with no eSKD element fails rather than vanishing", async () => {
  const source = await bookkeepingSnapshot("approved");
  const payload = structuredClone(source.payload);
  payload.outcome.canonical_outputs.bookkeeping.vat_period = {
    frequency: "quarterly",
    chart: "BAS-2026",
    cycle_start: "2026-07-01",
    cycle_end: "2026-09-30",
    due_in_period: true,
    input_accounts: ["2641"],
    output_accounts: ["2611"],
    settlement_account: "2650",
    status: "due",
    closing_transaction_source_id: "vat-close:2026-Q3",
    notes: [],
    balances_at_cycle_start: [],
    declaration_boxes: { "49": "0.00 SEK", "99": "100.00 SEK" },
  };
  payload.proposal_digest = proposalDigest(payload.outcome);
  const snapshot = sealContent({ schemaId: source.ref.schema_id, schemaVersion: "2.0", stableId: "unknown-box-snapshot", version: "approved", payload });
  await assert.rejects(() => render(snapshot, "vat-xml-v1"), /VAT box 99 has no eSKD element/);
});

test("needs-input and out-of-scope outcomes use the same complete report pipeline", async () => {
  const needsInput = buildReportModel(await classifiedSnapshot("needs_input"));
  assert.equal(needsInput.outcomeKind, "needs_input");
  assert.equal(needsInput.questions[0].text, "Vilket belopp gäller?");
  assert.deepEqual(needsInput.transactions, []);
  const needsHtml = artifactBytes((await render(await classifiedSnapshot("needs_input"), "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(needsHtml, /<h1>example-ab, maj 2026<\/h1>/);
  assert.match(needsHtml, /Status <span class="pill attention">Behöver svar<\/span>/);
  assert.match(needsHtml, /<div class="attention-panel"><h3>Frågor<\/h3>/);
  assert.match(needsHtml, /Frågor, noteringar och orsaker/);
  assert.match(needsHtml, /Vilket belopp gäller\?/);
  assert.match(needsHtml, /<h3>Noteringar<\/h3>[\s\S]*Kontrollera underlaget\./);
  assert.doesNotMatch(needsHtml, /MISSING_AMOUNT|CHECK_SOURCE|receipt\.pdf/);
  assert.match(needsHtml, /Verifikationer<\/h2><p class="empty">Inga\.<\/p>/);
  assert.match(needsHtml, /Öppna poster<\/h2><p>Inga öppna poster vid periodens slut\.<\/p>/);
  assert.doesNotMatch(needsHtml, /Förändringar<\/h3>|Kvarstående poster<\/h3>/);

  const outside = buildReportModel(await classifiedSnapshot("out_of_scope"));
  assert.equal(outside.outcomeKind, "out_of_scope");
  assert.equal(outside.reasons[0].text, "Ärendet kräver stöd utanför piloten.");
  const outsideHtml = artifactBytes((await render(await classifiedSnapshot("out_of_scope"), "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(outsideHtml, /Status <span class="pill attention">Utanför stöd<\/span>/);
  const outsideNotices = outsideHtml.slice(
    outsideHtml.indexOf("<h2>Noteringar</h2>"),
    outsideHtml.indexOf("<h2>Verifikationer</h2>"),
  );
  assert.match(outsideNotices, /<h2>Noteringar<\/h2><ul class="list notes-list"><li>Kontrollera underlaget\.<\/li><li>Ärendet kräver stöd utanför piloten\.<\/li><\/ul><\/section>/);
  assert.doesNotMatch(outsideNotices, /<div class="attention-panel">|CHECK_SOURCE|OUTSIDE_PROFILE|receipt\.pdf/);

  const weekly = await classifiedSnapshotForPeriod("needs_input", "en", {
    id: "2026-W23", kind: "ordinary", start: "2026-06-01", end: "2026-06-07",
  });
  const weeklyHtml = artifactBytes((await render(weekly, "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(weeklyHtml, /<h1>example-ab, 2026-W23<\/h1>/);
  assert.doesNotMatch(weeklyHtml, /<h1>[^<]*June 2026<\/h1>/);

  const imported = await classifiedSnapshotForPeriod("needs_input", "sv", {
    id: "Import", kind: "import", end: "2026-04-30",
  });
  const importedHtml = artifactBytes((await render(imported, "report-html-v1")).payload.artifacts[0]).toString("utf8");
  assert.match(importedHtml, /<h1>example-ab, Import<\/h1>/);
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
