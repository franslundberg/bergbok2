#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Artifacts,
  Bookkeeping,
  CompanyRecord,
  EvaluationLab,
  Payroll,
  createModuleOutcome,
  sealContent,
} from "../../index.mjs";
import { loadCaseDirectory } from "../../modules/evaluation-lab/src/directory-adapter.mjs";
import { prettyCanonicalJson, sha256Bytes } from "../../contracts/src/canonical.mjs";
import { allocateRunDirectory } from "../../dev/demo-run-directory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const generatedRoot = path.join(here, "generated");
await mkdir(generatedRoot, { recursive: true });
const outputRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : await allocateRunDirectory(generatedRoot);
await mkdir(outputRoot, { recursive: true });

const newCompany = await CompanyRecord.create({
  rootDir: path.join(outputRoot, "stores", "new-company"),
  companyId: "new-company-ab",
  clock: incrementingClock("2026-09-03T08:00:00.000Z"),
  initialState: {
    core: { organization: { name: "New Company AB", organization_number: "559991-0001" } },
    domains: {},
  },
});
const newStart = await bookPeriod({
  record: newCompany,
  period: { id: "Start", kind: "start", end: "2025-12-31" },
  input: bookkeepingInput("new-company-ab", "Start", {
    mode: "start",
  }),
  label: "new-company-start",
});

const company = await CompanyRecord.create({
  rootDir: path.join(outputRoot, "stores", "operating-company"),
  companyId: "operating-company-ab",
  clock: incrementingClock("2026-09-03T09:00:00.000Z"),
  initialState: {
    core: { organization: { name: "Operating Company AB", organization_number: "559991-0002" } },
    domains: {},
  },
});
const importedState = await bookPeriod({
  record: company,
  period: { id: "Import", kind: "import", end: "2026-01-31" },
  input: bookkeepingInput("operating-company-ab", "Import", {
    mode: "import",
    imported_balances: [
      { account: "1930", account_name: "Bank", debit: "10000.00 SEK", credit: "0.00 SEK" },
      { account: "2081", account_name: "Share capital", debit: "0.00 SEK", credit: "10000.00 SEK" },
    ],
    imported_open_items: [],
    imported_verification_series: { series: "A", last_number: 4 },
  }),
  label: "imported-state",
});
const ordinaryMonth = await bookPeriod({
  record: company,
  period: period("2026-02"),
  input: bookkeepingInput("operating-company-ab", "2026-02", {
    mode: "ordinary",
    transactions: [{
      source_id: "materials-1",
      date: "2026-02-12",
      description: "Materials paid from bank",
      lines: [
        { account: "4000", account_name: "Purchases", debit: "250.00 SEK", credit: "0.00 SEK" },
        { account: "1930", account_name: "Bank", debit: "0.00 SEK", credit: "250.00 SEK" },
      ],
    }],
    reconciliations: [{ account: "1930", external_closing_balance: "9750.00 SEK" }],
  }),
  label: "ordinary-month",
});

const march = period("2026-03");
const payrollInput = {
  schema_version: "2.0",
  rules_profile: "simple-payroll-demo-v1",
  period_id: march.id,
  payment_date: "2026-03-25",
  employee: {
    employee_id: "employee-1",
    name: "Kim Example",
    personal_identity_number: "19900101-1234",
    payment_destination: "SE00-DEMO-PAYROLL-ACCOUNT",
  },
  pay_components: [
    { type: "fixed_monthly_salary", description: "Fixed monthly salary", amount: "40000.00 SEK" },
    { type: "ordinary_absence", description: "One unpaid absence day", days: 1 },
  ],
};
const payrollAssignment = await assignJson(company, march, "payroll-input.json", "payroll-input", payrollInput);
const payrollCase = await company.prepare("payroll", march.id, {
  expectedDocsetHead: payrollAssignment.docset.ref,
  actor: { id: "payroll-worker", role: "worker" },
  effective_policies: payrollPolicies(),
});
const payrollOutcome = await Payroll.consolidate(payrollCase);
assertProposal(payrollOutcome, "Payroll");
const payrollRun = await company.record(payrollCase.ref, payrollOutcome);
const payrollApproval = await company.approve(payrollRun.ref, approvalDecision("payroll-approver"));
if (!payrollApproval.upstream_result) throw new Error("Approved Payroll did not produce an upstream handoff");

const bookkeepingAssignment = await assignJson(
  company,
  march,
  "bookkeeping-input.json",
  "bookkeeping-input",
  bookkeepingInput("operating-company-ab", march.id, {
    mode: "ordinary",
    payroll_postings: [payrollPosting(payrollApproval.upstream_result.payload.output)],
    reconciliations: [{ account: "1930", external_closing_balance: "9750.00 SEK" }],
  }),
);
const payrollBookkeepingCase = await company.prepare("bookkeeping", march.id, {
  expectedDocsetHead: bookkeepingAssignment.docset.ref,
  upstreamRefs: [payrollApproval.upstream_result.ref],
  actor: { id: "bookkeeping-worker", role: "worker" },
  effective_policies: bookkeepingPolicies(),
});
const payrollBookkeepingOutcome = await Bookkeeping.consolidate(payrollBookkeepingCase);
assertProposal(payrollBookkeepingOutcome, "Bookkeeping after Payroll");
const payrollBookkeepingRun = await company.record(payrollBookkeepingCase.ref, payrollBookkeepingOutcome);
const payrollBookkeepingApproval = await company.approve(
  payrollBookkeepingRun.ref,
  approvalDecision("bookkeeping-approver"),
);

const bookkeepingArtifacts = Artifacts.render(payrollBookkeepingApproval.output_snapshot, "sie4-v1");
const payrollArtifacts = Artifacts.render(payrollApproval.output_snapshot, "payslips-pdf-v1");
await writeArtifacts(path.join(outputRoot, "artifacts", "bookkeeping"), bookkeepingArtifacts);
await writeArtifacts(path.join(outputRoot, "artifacts", "payroll"), payrollArtifacts);

const labCase = await loadCaseDirectory(path.join(
  here,
  "..",
  "..",
  "evaluation-lab",
  "cases",
  "evaluation-equivalent",
));
const labCandidateState = sealContent({
  schemaId: "se.bergbok.bookkeeping.state",
  schemaVersion: "2.0",
  stableId: "example-ab:bookkeeping-candidate-state",
  version: 1,
  payload: { schema_version: "2.0", ledger_balances: { "1930": "900.00 SEK", "6550": "100.00 SEK" } },
});
const labCandidate = createModuleOutcome({
  kind: "proposal",
  domain: "bookkeeping",
  caseRef: labCase.input.ref,
  proposedChanges: [{ kind: "transaction", verification_id: "A1" }],
  projectedState: labCandidateState,
  canonicalOutputs: {
    bookkeeping: {
      schema_version: "2.0",
      ledger: {
        transactions: [{
          verification_id: "A1",
          date: "2026-03-03",
          description: "Software service",
          evidence_ids: ["260303-1"],
          lines: [
            { account: "6550", debit: "100.00 SEK", credit: "0.00 SEK" },
            { account: "1930", debit: "0.00 SEK", credit: "100.00 SEK" },
          ],
        }],
      },
    },
  },
  provenance: { module_version: "composed-demo-candidate-v2" },
});
const evaluation = EvaluationLab.evaluate(labCase, labCandidate, labCase.grading_profile);

const flows = [
  newStart,
  importedState,
  ordinaryMonth,
  {
    label: "payroll",
    caseBundle: payrollCase,
    outcome: payrollOutcome,
    run: payrollRun,
    approval: payrollApproval,
  },
  {
    label: "payroll-to-bookkeeping",
    caseBundle: payrollBookkeepingCase,
    outcome: payrollBookkeepingOutcome,
    run: payrollBookkeepingRun,
    approval: payrollBookkeepingApproval,
  },
];
for (const flow of flows) await writeFlow(outputRoot, flow);
await mkdir(path.join(outputRoot, "evaluation"), { recursive: true });
await writeFile(path.join(outputRoot, "evaluation", "evaluation.json"), prettyCanonicalJson(evaluation));
await writeFile(path.join(outputRoot, "evaluation", "comparison.md"), evaluation.payload.comparison_md);

const finalState = await company.read({ kind: "state" });
const summary = {
  contract_version: "1.0",
  kind: "thin-workflow-demo",
  modules: ["Company Record", "Bookkeeping", "Payroll", "Artifacts", "Evaluation Lab"],
  flows: flows.map((flow) => ({
    label: flow.label,
    outcome: flow.outcome.kind,
    case_ref: flow.caseBundle.ref,
    run_ref: flow.run.ref,
    approval_receipt_ref: flow.approval.receipt.ref,
    resulting_state_ref: flow.approval.state.ref,
  })),
  final_state_ref: finalState.ref,
  payroll_upstream_ref: payrollApproval.upstream_result.ref,
  bookkeeping_artifact_ref: bookkeepingArtifacts.ref,
  payroll_artifact_ref: payrollArtifacts.ref,
  evaluation_ref: evaluation.ref,
  checks: {
    new_company_start_from_empty_state: newStart.caseBundle.payload.previous_state.payload.sequence === 0,
    imported_state_from_empty_state: importedState.caseBundle.payload.previous_state.payload.sequence === 0,
    ordinary_month_uses_preceding_state: ordinaryMonth.caseBundle.payload.previous_state.payload.sequence === 1,
    payroll_facts_authorized_by_company_record: payrollApproval.upstream_result.payload.trust === "approved_internal",
    bookkeeping_consumed_exact_payroll_wrapper:
      payrollBookkeepingCase.payload.upstream_results[0].ref.sha256 === payrollApproval.upstream_result.ref.sha256,
    final_state_keeps_both_domains:
      Boolean(finalState.payload.domains.payroll && finalState.payload.domains.bookkeeping),
    artifacts_are_approved_not_previews:
      !bookkeepingArtifacts.payload.preview && !payrollArtifacts.payload.preview,
    evaluation_accepts_declared_equivalent: evaluation.payload.evaluation.passed,
  },
};
await writeFile(path.join(outputRoot, "manifest.json"), prettyCanonicalJson(summary));
await writeFile(path.join(outputRoot, "report.md"), renderSummary(summary, payrollBookkeepingOutcome));

console.log(outputRoot);

async function bookPeriod({ record, period: periodValue, input, label }) {
  const assignment = await assignJson(record, periodValue, `${label}.json`, "bookkeeping-input", input);
  const caseBundle = await record.prepare("bookkeeping", periodValue.id, {
    expectedDocsetHead: assignment.docset.ref,
    actor: { id: "bookkeeping-worker", role: "worker" },
    effective_policies: bookkeepingPolicies(),
  });
  const outcome = await Bookkeeping.consolidate(caseBundle);
  assertProposal(outcome, label);
  const run = await record.record(caseBundle.ref, outcome);
  const approval = await record.approve(run.ref, approvalDecision(`${label}-approver`));
  return { label, caseBundle, outcome, run, approval };
}

async function assignJson(record, periodValue, filename, role, value) {
  const current = await record.read({ kind: "docset", period: periodValue.id });
  const logItemRef = await record.ingest({
    filename,
    media_type: "application/json",
    content: JSON.stringify(value),
    suggested_period: periodValue.id,
  }, { id: "document-uploader", role: "operator" });
  return record.reviseDocset(periodValue, current?.ref ?? null, {
    actor: { id: "document-uploader", role: "operator" },
    add: [{ log_item_ref: logItemRef, role }],
  });
}

function bookkeepingInput(companyId, periodId, overrides) {
  return {
    schema_id: "se.bergbok.bookkeeping-input",
    schema_version: "2.0",
    company_id: companyId,
    period_id: periodId,
    mode: "ordinary",
    transactions: [],
    open_item_changes: [],
    reconciliations: [],
    vat: { status: "not_due" },
    ...overrides,
  };
}

function bookkeepingPolicies() {
  return {
    core: {
      country: "SE",
      currency: "SEK",
      fiscal_year: { start: "2026-01-01", end: "2026-12-31" },
      accounting_method: "invoice",
    },
    bookkeeping: {
      profile: "se-private-ab-invoice-calendar-demo-v1",
      verification_series: "A",
    },
  };
}

function payrollPolicies() {
  return {
    core: { country: "SE", currency: "SEK" },
    payroll: {
      profile: "simple-payroll-demo-v1",
      daily_divisor: 30,
      withholding_basis_points: 3000,
      employer_contribution_basis_points: 3142,
    },
  };
}

function payrollPosting(facts) {
  const accounts = {
    gross_cash_salary: ["7010", "Salaries"],
    employer_contribution: ["7510", "Employer contributions"],
    withholding_tax_payable: ["2710", "Employee withholding tax"],
    employer_contribution_payable: ["2731", "Employer contributions payable"],
    net_salary_payable: ["2910", "Accrued salaries"],
  };
  return {
    payroll_facts_ref: facts.ref,
    date: facts.payload.liability_facts.find((fact) => fact.kind === "net_salary_payable").due_date,
    description: `Payroll ${facts.payload.period_id} - Kim Example`,
    assignments: [...facts.payload.expense_facts, ...facts.payload.liability_facts].map((fact) => ({
      fact_id: fact.fact_id,
      account: accounts[fact.kind][0],
      account_name: accounts[fact.kind][1],
    })),
  };
}

function period(id) {
  const [year, month] = id.split("-").map(Number);
  return {
    id,
    kind: "ordinary",
    start: `${id}-01`,
    end: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
  };
}

function approvalDecision(id) {
  return {
    decision: "approved",
    actor: { id, role: "approver" },
    authority: { kind: "role", role: "approver" },
  };
}

function assertProposal(outcome, label) {
  if (outcome.kind !== "proposal") {
    throw new Error(`${label} expected Proposal, received ${outcome.kind}: ${JSON.stringify(outcome.questions ?? outcome.reasons)}`);
  }
}

async function writeFlow(root, flow) {
  const directory = path.join(root, "runs", flow.label);
  await mkdir(path.join(directory, "result"), { recursive: true });
  await writeFile(path.join(directory, "manifest.json"), prettyCanonicalJson({
    contract_version: "1.0",
    label: flow.label,
    case_ref: flow.caseBundle.ref,
    run_ref: flow.run.ref,
    approval_receipt_ref: flow.approval.receipt.ref,
    resulting_state_ref: flow.approval.state.ref,
  }));
  await writeFile(path.join(directory, "result", "case.json"), prettyCanonicalJson(flow.caseBundle));
  await writeFile(path.join(directory, "result", "outcome.json"), prettyCanonicalJson(flow.outcome));
  await writeFile(path.join(directory, "result", "approval.json"), prettyCanonicalJson(flow.approval.receipt));
  const moduleReport = flow.outcome.review?.report_markdown
    ?? `# ${flow.label}\n\nOutcome: **${flow.outcome.kind}**\n\nProposal digest: \`${flow.run.payload.proposal_digest}\`\n`;
  await writeFile(path.join(directory, "report.md"), `${moduleReport.trimEnd()}\n`);
}

async function writeArtifacts(directory, bundle) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "bundle.json"), prettyCanonicalJson(bundle));
  for (const artifact of bundle.payload.artifacts) {
    const bytes = Buffer.from(artifact.content_base64, "base64");
    if (bytes.length !== artifact.byte_length || sha256Bytes(bytes) !== artifact.sha256) {
      throw new Error(`Artifact ${artifact.filename} failed its bundle hash`);
    }
    await writeFile(path.join(directory, artifact.filename), bytes);
  }
}

function renderSummary(summary, bookkeepingOutcome) {
  return [
    "# Bergbok composed module demo",
    "",
    "This is a thin workflow above exactly five modules. The workflow contains no accounting, payroll, persistence, rendering, or grading implementation of its own.",
    "",
    "## Modules",
    "",
    ...summary.modules.map((module) => `- ${module}${module === "Evaluation Lab" ? " (development only)" : ""}`),
    "",
    "## Flows",
    "",
    "| Flow | Outcome | Resulting State |",
    "|---|---|---|",
    ...summary.flows.map((flow) => `| ${flow.label} | ${flow.outcome} | \`${flow.resulting_state_ref.sha256.slice(0, 16)}\` |`),
    "",
    "## Cross-module handoff",
    "",
    `Payroll facts wrapper: \`${summary.payroll_upstream_ref.sha256}\``,
    "",
    `Bookkeeping accepted ${bookkeepingOutcome.evidence.filter((item) => item.kind === "authoritative_upstream_result").length} authoritative Payroll result and assigned its transaction the next verification number.`,
    "",
    "## Checks",
    "",
    ...Object.entries(summary.checks).map(([name, passed]) => `- ${passed ? "PASS" : "FAIL"}: ${name.replaceAll("_", " ")}`),
    "",
    "Artifacts were rendered but not delivered. No payment, filing, submission, or email action exists in this workflow.",
    "",
  ].join("\n");
}

function incrementingClock(start) {
  let milliseconds = new Date(start).valueOf();
  return () => {
    const value = new Date(milliseconds);
    milliseconds += 1000;
    return value;
  };
}
