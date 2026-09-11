import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";

import { create, open, CompanyRecordError } from "../src/index.mjs";
import { createModuleOutcome, sealContent } from "../../../contracts/src/index.mjs";

const TEST_ROOT = path.resolve("modules/company-record/test/.tmp/company-record");
const COMPANY_ID = "company-record-test-ab";
const CLOCK = () => new Date("2026-09-03T10:00:00.000Z");

after(() => rm(TEST_ROOT, { recursive: true, force: true }));

async function freshRecord(name, options = {}) {
  const rootDir = path.join(TEST_ROOT, name);
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
  const record = await create({ rootDir, companyId: COMPANY_ID, clock: CLOCK, ...options });
  return { rootDir, record };
}

function domainProposal(caseBundle, domain, state = { marker: "approved" }, outputs = {}) {
  const projectedState = state?.ref && state?.payload ? state : sealContent({
    schemaId: `se.bergbok.${domain}.state`,
    schemaVersion: ["bookkeeping", "payroll"].includes(domain) ? "2.0" : "1.0",
    stableId: `${caseBundle.payload.company_id}:${domain}-state`,
    version: caseBundle.ref.version,
    payload: {
      contract_version: "1.0",
      ...(["bookkeeping", "payroll"].includes(domain) ? { schema_version: "2.0" } : {}),
      company_id: caseBundle.payload.company_id,
      through_period_id: caseBundle.payload.period.id,
      status: "projected",
      ...state,
    },
  });
  return createModuleOutcome({
    kind: "proposal",
    domain,
    caseRef: caseBundle.ref,
    projectedState,
    proposedChanges: [{ action: "replace_domain_state", domain }],
    canonicalOutputs: outputs,
    review: { summary: "Review the complete proposal" },
    provenance: { module_id: `test.${domain}`, module_version: "1" },
  });
}

function approvalDecision(id = "reviewer-1") {
  return {
    decision: "approved",
    actor: { id, role: "approver" },
    authority: { kind: "role", role: "approver" },
  };
}

async function ingestAndAssign(record, period, item, role = "bookkeeping-input", actor = "operator") {
  const definition = periodDefinition(period);
  const logItemRef = await record.ingest({ ...item, suggested_period: definition.id }, actor);
  const revision = await record.reviseDocset(definition, null, [{
    op: "add",
    log_item_ref: logItemRef,
    role,
  }]);
  return { logItemRef, revision, document: revision.added_documents[0], docset: revision.docset };
}

function periodDefinition(value) {
  if (typeof value !== "string") return value;
  const [year, month] = value.split("-").map(Number);
  return {
    id: value,
    kind: "ordinary",
    start: `${value}-01`,
    end: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
  };
}

test("ingest preserves bytes and cross-period copy receives a new stable document ID", async (t) => {
  const { rootDir, record } = await freshRecord("copy");
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const bytes = Buffer.from("same original evidence\n", "utf8");
  const januaryLogRef = await record.ingest({
    suggested_period: "2026-01",
    filename: "evidence.txt",
    mediaType: "text/plain",
    bytes,
  }, { id: "uploader-1", role: "operator" });
  assert.equal(januaryLogRef.schema_id, "se.bergbok.log-item");
  const january = await record.reviseDocset(periodDefinition("2026-01"), null, [{
    op: "add",
    log_item_ref: januaryLogRef,
    role: "bookkeeping-input",
  }]);
  const januaryDocument = january.added_documents[0];
  const february = await record.reviseDocset(periodDefinition("2026-02"), null, [{
    op: "copy",
    sourceRef: januaryDocument.ref,
    role: "bookkeeping-input",
  }]);

  const copied = february.added_documents[0];
  assert.notEqual(copied.payload.document_id, januaryDocument.payload.document_id);
  assert.equal(copied.payload.sha256, januaryDocument.payload.sha256);
  assert.deepEqual(copied.payload.log_item_ref, januaryLogRef);
  assert.equal(copied.payload.content_base64, bytes.toString("base64"));
  assert.deepEqual(copied.payload.copied_from_document_ref, januaryDocument.ref);
  assert.equal(february.docset.payload.documents[0].content_base64, bytes.toString("base64"));

  const reopened = await open({ rootDir, companyId: COMPANY_ID, clock: CLOCK });
  assert.deepEqual(await reopened.read(copied.ref), copied);
  const timelineJson = await reopened.read({ kind: "timeline", format: "json" });
  const timelineMarkdown = await reopened.read({ kind: "timeline", format: "markdown" });
  assert.ok(timelineJson.events.some((event) => event.type === "log-item.ingested"));
  assert.ok(timelineJson.events.some((event) => event.type === "docset.revised"));
  assert.match(timelineMarkdown, /^# Company Record timeline/m);
  assert.match(timelineMarkdown, /log-item\.ingested/);
});

test("Company Record persists language, prepares cases with a frozen copy, and leaves old cases unchanged", async (t) => {
  const { rootDir, record } = await freshRecord("language", { language: "en" });
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  assert.deepEqual(await record.read({ kind: "company_settings" }), {
    company_id: COMPANY_ID,
    language: "en",
  });
  const englishCase = await record.prepare("bookkeeping", periodDefinition("2026-03"));
  assert.equal(englishCase.payload.language, "en");

  const change = await record.setLanguage("sv", { id: "settings-admin", role: "operator" });
  assert.equal(change.changed, true);
  assert.equal(change.language, "sv");
  assert.deepEqual(await record.read({ kind: "company_settings" }), {
    company_id: COMPANY_ID,
    language: "sv",
  });
  assert.equal((await record.read(englishCase.ref)).payload.language, "en");

  const swedishCase = await record.prepare("payroll", periodDefinition("2026-04"));
  assert.equal(swedishCase.payload.language, "sv");
  const timeline = await record.read({ kind: "timeline", format: "json" });
  assert.ok(timeline.events.some((event) => event.type === "company.language_changed"));

  await assert.rejects(record.setLanguage("de", "settings-admin"), (error) => error.code === "BERGBOK_CONTRACT_ERROR");
});

test("Company Record defaults new records to Swedish", async (t) => {
  const { rootDir, record } = await freshRecord("language-default");
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  assert.deepEqual(await record.read({ kind: "company_settings" }), {
    company_id: COMPANY_ID,
    language: "sv",
  });
  const caseBundle = await record.prepare("bookkeeping", periodDefinition("2026-05"));
  assert.equal(caseBundle.payload.language, "sv");
});

test("prepare freezes exact inputs; record and approval publish only the proposed domain State", async (t) => {
  const { rootDir, record } = await freshRecord("approve", {
    initialState: { core: { legal_name: "Example AB" }, domains: { payroll: { untouched: true } } },
  });
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const logItemRef = await record.ingest({
    suggested_period: "2026-02",
    filename: "bookkeeping.json",
    media_type: "application/json",
    content: JSON.stringify({ example: true }),
  }, "operator-1");
  const assignment = await record.reviseDocset(
    periodDefinition("2026-02"),
    null,
    [{ op: "add", log_item_ref: logItemRef, role: "bookkeeping-input" }],
  );
  const caseBundle = await record.prepare("bookkeeping", "2026-02", {
    expectedDocsetHead: assignment.docset.ref,
    actor: "worker-1",
    effectivePolicies: { core: { country: "SE", currency: "SEK" } },
  });
  assert.equal(caseBundle.payload.docset.payload.documents[0].content_base64, Buffer.from(JSON.stringify({ example: true })).toString("base64"));
  assert.equal(caseBundle.payload.previous_state.payload.sequence, 0);

  const outcome = domainProposal(caseBundle, "bookkeeping", {
    through_period: "2026-02",
    balance: "123.00 SEK",
  }, { bookkeeping: { status: "proposed", transaction_count: 1 } });
  const run = await record.record(caseBundle.ref, outcome);
  const approval = await record.approve(run.ref, {
    ...approvalDecision(),
    expectedRunSha256: run.ref.sha256,
  });

  assert.equal(approval.receipt.payload.complete_run_sha256, run.ref.sha256);
  assert.deepEqual(approval.receipt.payload.authority, { kind: "role", role: "approver" });
  assert.equal(approval.receipt.payload.approval_scope.period_id, "2026-02");
  assert.equal(approval.receipt.payload.approval_scope.domain, "bookkeeping");
  assert.equal(approval.receipt.payload.timestamp, "2026-09-03T10:00:00.000Z");
  assert.deepEqual(approval.receipt.payload.resulting_state_ref, approval.state.ref);
  assert.equal(approval.state.payload.sequence, 1);
  assert.deepEqual(approval.state.payload.core, { legal_name: "Example AB" });
  assert.deepEqual(approval.state.payload.domains.payroll, { untouched: true });
  assert.deepEqual(approval.state.payload.domains.bookkeeping, {
    company_id: COMPANY_ID,
    contract_version: "1.0",
    schema_version: "2.0",
    status: "projected",
    through_period_id: "2026-02",
    through_period: "2026-02",
    balance: "123.00 SEK",
  });
  const snapshot = await record.read({ kind: "output_snapshot", runRef: run.ref });
  assert.equal(snapshot.ref.schema_id, "se.bergbok.output-snapshot");
  assert.equal(snapshot.ref.schema_version, "2.0");
  assert.deepEqual(Object.keys(snapshot.payload).sort(), [
    "approval_receipt_ref", "approval_status", "context", "contract_version", "language",
    "outcome", "proposal_digest", "recorded_at", "run_ref",
  ]);
  assert.equal(snapshot.payload.approval_status, "approved");
  assert.deepEqual(snapshot.payload.approval_receipt_ref, approval.receipt.ref);
  assert.equal(snapshot.ref.schema_version, "2.0");
  assert.equal(snapshot.payload.contract_version, "2.0");
  assert.deepEqual(snapshot.payload.outcome, outcome);
  assert.equal(snapshot.payload.language, "sv");
  assert.deepEqual(snapshot.payload.context.period, caseBundle.payload.period);
  assert.deepEqual(snapshot.payload.context.docset_ref, caseBundle.payload.docset.ref);
  assert.deepEqual(snapshot.payload.context.previous_state_ref, caseBundle.payload.previous_state.ref);
  assert.equal((await record.read({ kind: "period", period: "2026-02" })).status, "approved");
});

test("docset revision uses optimistic heads and makes an already recorded run stale", async (t) => {
  const { rootDir, record } = await freshRecord("stale-docset");
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const first = await ingestAndAssign(record, "2026-03", {
    filename: "first.json",
    media_type: "application/json",
    content: "{}",
  });
  const caseBundle = await record.prepare("bookkeeping", "2026-03");
  const run = await record.record(caseBundle.ref, domainProposal(caseBundle, "bookkeeping"));
  const secondLogRef = await record.ingest({ filename: "second.txt", content: "new evidence" }, "operator");
  const revised = await record.reviseDocset(periodDefinition("2026-03"), first.docset.ref, [{
    op: "add",
    log_item_ref: secondLogRef,
    role: "supporting-evidence",
  }]);
  assert.equal(revised.docset.ref.version, 2);

  const thirdLogRef = await record.ingest({ filename: "third.txt", content: "must not commit" }, "operator");
  await assert.rejects(
    record.reviseDocset(periodDefinition("2026-03"), first.docset.ref, [{
      op: "add",
      log_item_ref: thirdLogRef,
      role: "supporting-evidence",
    }]),
    (error) => error instanceof CompanyRecordError && error.code === "BERGBOK_STALE_DOCSET",
  );
  await assert.rejects(
    record.approve(run.ref, approvalDecision()),
    (error) => error instanceof CompanyRecordError && error.code === "BERGBOK_STALE_DOCSET",
  );
});

test("approval detects a tampered immutable run before trusting its outcome", async (t) => {
  const { rootDir, record } = await freshRecord("tamper");
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await ingestAndAssign(record, "2026-04", { filename: "input.txt", content: "evidence" });
  const caseBundle = await record.prepare("bookkeeping", "2026-04");
  const run = await record.record(caseBundle.ref, domainProposal(caseBundle, "bookkeeping"));

  const runPath = path.join(rootDir, "objects", run.ref.sha256.slice(0, 2), `${run.ref.sha256}.json`);
  const stored = JSON.parse(await readFile(runPath, "utf8"));
  stored.payload.outcome.review.summary = "silently changed after recording";
  await writeFile(runPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

  await assert.rejects(
    record.approve(run.ref, approvalDecision()),
    (error) => error instanceof CompanyRecordError && error.code === "BERGBOK_INTEGRITY_ERROR",
  );
});

test("only Company Record approval turns proposed Payroll facts into trusted upstream evidence", async (t) => {
  const { rootDir, record } = await freshRecord("payroll-upstream");
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const period = "2026-09";
  const payrollInput = {
    schema_version: "2.0",
    rules_profile: "simple-payroll-demo-v1",
    period_id: period,
    payment_date: "2026-09-25",
    employee: {
      employee_id: "employee-1",
      name: "Kim Example",
      personal_identity_number: "19900101-1234",
      payment_destination: "SE00-DEMO-PAYROLL-ACCOUNT",
    },
    pay_components: [{
      type: "fixed_monthly_salary",
      description: "Fixed monthly salary",
      amount: "40000.00 SEK",
    }],
  };
  const payrollLogRef = await record.ingest({
    suggested_period: period,
    filename: "payroll.json",
    media_type: "application/json",
    content: JSON.stringify(payrollInput),
  }, "payroll-operator");
  await record.reviseDocset(periodDefinition(period), null, [{
    op: "add",
    log_item_ref: payrollLogRef,
    role: "payroll-input",
  }]);
  const payrollCase = await record.prepare("payroll", period, {
    effective_policies: {
      core: { country: "SE", currency: "SEK" },
      payroll: {
        profile: "simple-payroll-demo-v1",
        daily_divisor: 30,
        withholding_basis_points: 3_000,
        employer_contribution_basis_points: 3_142,
      },
    },
  });
  const payrollFacts = sealContent({
    schemaId: "se.bergbok.bookkeeping.payroll-accounting-facts",
    schemaVersion: "2.0",
    stableId: `${COMPANY_ID}:${period}:payroll-accounting-facts`,
    version: 1,
    payload: {
      contract_version: "1.0",
      schema_version: "2.0",
      status: "proposed",
      company_id: COMPANY_ID,
      period_id: period,
      transactions: [],
    },
  });
  const payrollOutcome = domainProposal(
    payrollCase,
    "payroll",
    { employees: [{ employee_id: "employee-1" }] },
    { payroll_accounting_facts: payrollFacts },
  );
  assert.equal(payrollOutcome.canonical_outputs.payroll_accounting_facts.payload.status, "proposed");
  const payrollRun = await record.record(payrollCase.ref, payrollOutcome);
  const approval = await record.approve(payrollRun.ref, approvalDecision("payroll-reviewer"));

  const upstream = approval.upstream_result;
  assert.equal(upstream.ref.schema_id, "se.bergbok.upstream-result");
  assert.equal(upstream.payload.status, "approved");
  assert.equal(upstream.payload.trust, "approved_internal");
  assert.deepEqual(upstream.payload.output, payrollOutcome.canonical_outputs.payroll_accounting_facts);
  assert.deepEqual((await record.read(upstream.ref)), upstream);

  const bookkeepingCase = await record.prepare("bookkeeping", period, { upstreamRefs: [upstream.ref] });
  assert.deepEqual(bookkeepingCase.payload.upstream_results, [upstream]);
  assert.deepEqual(bookkeepingCase.payload.previous_state.ref, approval.state.ref);
});

test("Company Record replays approved v1 Payroll facts byte-for-byte without resealing them", async (t) => {
  const { rootDir, record } = await freshRecord("legacy-payroll-replay");
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const period = "2026-08";
  await ingestAndAssign(record, period, {
    filename: "legacy-payroll.json",
    media_type: "application/json",
    content: JSON.stringify({ schema_version: "1.0", amount_ore: 4_000_000 }),
  }, "payroll-input");
  const payrollCase = await record.prepare("payroll", period);
  const legacyState = sealContent({
    schemaId: "se.bergbok.payroll.state",
    schemaVersion: "1.0",
    stableId: `${COMPANY_ID}:legacy-payroll-state`,
    version: 1,
    payload: {
      contract_version: "1.0",
      schema_version: "1.0",
      company_id: COMPANY_ID,
      through_period_id: period,
      employees: [],
    },
  });
  const legacyFacts = sealContent({
    schemaId: "se.bergbok.bookkeeping.payroll-accounting-facts",
    schemaVersion: "1.0",
    stableId: `${COMPANY_ID}:${period}:legacy-payroll-facts`,
    version: 1,
    payload: {
      contract_version: "1.0",
      schema_version: "1.0",
      status: "proposed",
      company_id: COMPANY_ID,
      period_id: period,
      currency: "SEK",
      expense_facts: [{ fact_id: "legacy:gross", kind: "gross_cash_salary", amount_ore: 4_000_000 }],
      liability_facts: [{ fact_id: "legacy:net", kind: "net_salary_payable", amount_ore: 4_000_000 }],
    },
  });
  const originalFactsRef = structuredClone(legacyFacts.ref);
  const outcome = domainProposal(payrollCase, "payroll", legacyState, { payroll_accounting_facts: legacyFacts });
  const approval = await record.approve((await record.record(payrollCase.ref, outcome)).ref, approvalDecision());
  assert.deepEqual(approval.upstream_result.payload.output.ref, originalFactsRef);

  const reopened = await open({ rootDir, companyId: COMPANY_ID, clock: CLOCK });
  const replayed = await reopened.read(approval.upstream_result.ref);
  assert.deepEqual(replayed.payload.output, legacyFacts);
  const bookkeepingCase = await reopened.prepare("bookkeeping", period, { upstreamRefs: [replayed.ref] });
  assert.deepEqual(bookkeepingCase.payload.upstream_results[0].payload.output.ref, originalFactsRef);
});

test("late material uses Period dates instead of monthly IDs", async (t) => {
  const { rootDir, record } = await freshRecord("late-material");
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const later = { id: "quarter-tail", kind: "ordinary", start: "2026-03-01", end: "2026-03-31" };
  await ingestAndAssign(record, later, { filename: "march.json", content: "{}" });
  const marchCase = await record.prepare("bookkeeping", later.id);
  const marchRun = await record.record(marchCase.ref, domainProposal(marchCase, "bookkeeping"));
  await record.approve(marchRun.ref, approvalDecision());

  const lateLogRef = await record.ingest({
    filename: "late-february-evidence.txt",
    content: "Received after March approval",
    suggested_period: "week-eight",
  }, "operator");
  await assert.rejects(
    record.reviseDocset({ id: "week-eight", kind: "ordinary", start: "2026-02-16", end: "2026-02-22" }, null, [{
      op: "add",
      log_item_ref: lateLogRef,
      role: "bookkeeping-input",
    }]),
    (error) =>
      error instanceof CompanyRecordError &&
      error.code === "BERGBOK_OUT_OF_SEQUENCE" &&
      error.details.later_authoritative_period_id === later.id,
  );
});

test("an existing Period definition cannot be rebound and State lineage protects it", async (t) => {
  const { rootDir, record } = await freshRecord("period-lineage");
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const first = { id: "week-10", kind: "ordinary", start: "2026-03-02", end: "2026-03-08" };
  const second = { id: "week-11", kind: "ordinary", start: "2026-03-09", end: "2026-03-15" };
  await ingestAndAssign(record, first, { filename: "first.json", content: "{}" });
  const firstCase = await record.prepare("bookkeeping", first.id);
  await record.approve((await record.record(firstCase.ref, domainProposal(firstCase, "bookkeeping"))).ref, approvalDecision());
  await ingestAndAssign(record, second, { filename: "second.json", content: "{}" });
  const secondCase = await record.prepare("bookkeeping", second.id);
  await record.approve((await record.record(secondCase.ref, domainProposal(secondCase, "bookkeeping"))).ref, approvalDecision());

  const lateRef = await record.ingest({ filename: "late.txt", content: "late" }, "operator");
  await assert.rejects(
    record.reviseDocset(first, (await record.read({ kind: "docset", period: first.id })).ref, [{ op: "add", log_item_ref: lateRef }]),
    (error) => error.code === "BERGBOK_OUT_OF_SEQUENCE" && error.details.later_authoritative_period_id === second.id,
  );
  await assert.rejects(
    record.reviseDocset({ ...second, end: "2026-03-16" }, (await record.read({ kind: "docset", period: second.id })).ref, [{ op: "add", log_item_ref: lateRef }]),
    (error) => error.code === "BERGBOK_PERIOD_DEFINITION_MISMATCH",
  );
});

test("the first Bookkeeping approval may initialize core State exactly once", async (t) => {
  const { rootDir, record } = await freshRecord("start-core", { initialState: { core: {}, domains: {} } });
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const period = { id: "Start", kind: "start", end: "2026-05-31" };
  const assignment = await ingestAndAssign(record, period, {
    filename: "company.md",
    media_type: "text/markdown",
    content: "Fiktiv AB 559999-0008",
  }, "evidence");
  const caseBundle = await record.prepare("bookkeeping", period, { expectedDocsetHead: assignment.docset.ref });
  const projected = sealContent({
    schemaId: "se.bergbok.bookkeeping.state",
    stableId: `${COMPANY_ID}:bookkeeping-state`,
    version: 1,
    payload: { contract_version: "1.0", company_id: COMPANY_ID, status: "projected", through_period_id: period.id, through_date: period.end },
  });
  const core = {
    organization: { name: "Fiktiv AB", organization_number: "559999-0008" },
    enabled_modules: ["bookkeeping"],
    bookkeeping_start_date: "2026-06-01",
    policies: {
      bookkeeping: {
        chart_of_accounts: "BAS",
        vat_reporting: {
          frequency: "quarterly",
          chart: "BAS-2026",
          box_overrides: [],
          settlement_account: "2650",
        },
      },
    },
  };
  const outcome = createModuleOutcome({
    kind: "proposal",
    domain: "bookkeeping",
    caseRef: caseBundle.ref,
    projectedState: projected,
    proposedChanges: [
      { action: "initialize_core_state", core },
      { action: "replace_domain_state", domain: "bookkeeping", state_ref: projected.ref },
    ],
  });
  const stored = await record.record(caseBundle.ref, outcome);
  const approval = await record.approve(stored.ref, approvalDecision());
  assert.deepEqual(approval.state.payload.core, core);

  const juneAssignment = await ingestAndAssign(record, "2026-06", { filename: "june.txt", content: "June" }, "evidence");
  const juneCase = await record.prepare("bookkeeping", "2026-06", { expectedDocsetHead: juneAssignment.docset.ref });
  const illegal = createModuleOutcome({
    kind: "proposal",
    domain: "bookkeeping",
    caseRef: juneCase.ref,
    projectedState: sealContent({
      schemaId: "se.bergbok.bookkeeping.state",
      stableId: `${COMPANY_ID}:bookkeeping-state`,
      version: 2,
      payload: { contract_version: "1.0", company_id: COMPANY_ID, status: "projected", through_period_id: "2026-06" },
    }),
    proposedChanges: [{ action: "initialize_core_state", core }, { action: "replace_domain_state", domain: "bookkeeping" }],
  });
  const illegalRun = await record.record(juneCase.ref, illegal);
  await assert.rejects(record.approve(illegalRun.ref, approvalDecision()), (error) => error.code === "BERGBOK_INVALID_PROPOSAL");
});
