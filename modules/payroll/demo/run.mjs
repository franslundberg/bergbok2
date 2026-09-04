#!/usr/bin/env node

import { readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { consolidate } from "../src/index.mjs";
import { createStateEnvelope, parseMoney, sealContent, verifySealedContent } from "../../../contracts/src/index.mjs";
import { prettyCanonicalJson, sha256Bytes } from "../../../contracts/src/canonical.mjs";
import { allocateRunDirectory } from "../../../dev/demo-run-directory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..", "..", "..");
const defaultCase = path.join(here, "..", "cases", "simple-september");
const options = parseArguments(process.argv.slice(2));
await loadLocalEnvironment(path.join(repositoryRoot, ".env.local"));

const outputRoot = options.output
  ? path.resolve(options.output)
  : await allocateRunDirectory(path.join(here, "generated"));
await mkdir(outputRoot, { recursive: true });
const startedAt = new Date();
const events = [{ event: "payroll_demo_started", at: startedAt.toISOString(), run: path.basename(outputRoot) }];
let snapshot;

try {
  snapshot = await snapshotCase(path.resolve(options.case ?? defaultCase), outputRoot);
  events.push({
    event: "case_snapshotted",
    at: new Date().toISOString(),
    input_files: snapshot.inputFiles.map((item) => item.relative_path),
  });

  const outcome = await consolidate(snapshot.caseBundle, snapshot.manifest.variant_ref);
  if (outcome.kind !== "proposal") {
    throw demoError("BERGBOK_PAYROLL_DEMO_NOT_PROPOSAL", `Payroll demo expected a proposal, received ${outcome.kind}.`);
  }
  const assessment = outcome.canonical_outputs.payroll_assessment;
  if (!assessment) throw new Error("Model-backed demo did not produce a sealed payroll assessment.");
  const facts = outcome.canonical_outputs.payroll_accounting_facts;
  verifySealedContent(assessment, "PayrollAssessment");
  verifySealedContent(outcome.projected_state, "projected Payroll State");
  verifySealedContent(facts, "PayrollAccountingFacts");

  const payslip = outcome.canonical_outputs.payslip.payload;
  const agi = outcome.canonical_outputs.agi.payload;
  const expenseMinor = facts.payload.expense_facts.reduce((sum, fact) => sum + parseMoney(fact.amount).minorUnits, 0n);
  const liabilityMinor = facts.payload.liability_facts.reduce((sum, fact) => sum + parseMoney(fact.amount).minorUnits, 0n);
  const integrity = {
    copied_inputs_match_source_hashes: snapshot.inputFiles.every((item) => item.source_sha256 === item.snapshot_sha256),
    citations_are_validated: outcome.review.controls.assessment_citations_validated,
    economic_facts_reconcile: expenseMinor === liabilityMinor,
    assessment_sealed: verifySealedContent(assessment),
    projected_state_sealed: verifySealedContent(outcome.projected_state),
  };
  if (!Object.values(integrity).every(Boolean)) throw new Error("A Payroll demo integrity check failed.");

  const extracted = {
    employee: assessment.payload.employee,
    payment_date: assessment.payload.payment_date,
    pay_components: assessment.payload.pay_components,
    citations: assessment.payload.citations,
    questions: assessment.payload.questions,
    warnings: assessment.payload.warnings,
  };
  const summary = {
    contract_version: "1.0",
    kind: "payroll-evidence-demo",
    run: path.basename(outputRoot),
    output_directory: outputRoot,
    case_id: snapshot.manifest.case_id,
    company_id: snapshot.manifest.company_id,
    company_name: snapshot.manifest.company_name,
    period_id: snapshot.manifest.period.id,
    outcome: outcome.kind,
    assessment_ref: assessment.ref,
    projected_state_ref: outcome.projected_state.ref,
    accounting_facts_ref: facts.ref,
    model: outcome.provenance.assessment.model,
    reasoning_effort: outcome.provenance.assessment.reasoning_effort,
    response_ids: outcome.provenance.assessment.response_ids,
    usage: outcome.provenance.assessment.usage,
    extracted,
    calculated: {
      fixed_monthly_salary: payslip.fixed_monthly_salary,
      absence_deduction: payslip.absence_deduction,
      correction: payslip.correction,
      gross_pay: payslip.gross_pay,
      tax_withheld: payslip.tax_withheld,
      net_pay: payslip.net_pay,
      employer_contribution: agi.employer_contribution,
    },
    integrity,
    files: {
      assessment: path.join(outputRoot, "assessment.json"),
      payroll_result: path.join(outputRoot, "payroll-result.json"),
      report: path.join(outputRoot, "report.md"),
      manifest: path.join(outputRoot, "manifest.json"),
      events: path.join(outputRoot, "events.ndjson"),
    },
  };
  const report = renderReport({ snapshot, outcome, summary });
  await writeSafeJson(path.join(outputRoot, "assessment.json"), assessment);
  await writeSafeJson(path.join(outputRoot, "payroll-result.json"), outcome);
  await writeSafeText(path.join(outputRoot, "report.md"), report);
  await writeSafeJson(path.join(outputRoot, "summary.json"), summary);

  events.push({
    event: "payroll_demo_completed",
    at: new Date().toISOString(),
    outcome: outcome.kind,
    assessment_ref: assessment.ref,
    projected_state_ref: outcome.projected_state.ref,
  });
  await writeSafeText(path.join(outputRoot, "events.ndjson"), events.map(JSON.stringify).join("\n") + "\n");
  const outputFiles = await describeFiles(outputRoot, [
    "assessment.json",
    "payroll-result.json",
    "report.md",
    "summary.json",
    "events.ndjson",
  ]);
  const runManifest = {
    schema_version: "1.0",
    kind: "payroll-demo-run",
    run: summary.run,
    case_id: summary.case_id,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt.valueOf(),
    model: summary.model,
    reasoning_effort: summary.reasoning_effort,
    response_ids: summary.response_ids,
    usage: summary.usage,
    case_ref: snapshot.caseBundle.ref,
    docset_ref: snapshot.caseBundle.payload.docset.ref,
    input_files: snapshot.inputFiles,
    output_files: outputFiles,
    credentials_persisted: false,
  };
  await writeSafeJson(path.join(outputRoot, "manifest.json"), runManifest);

  if (options.json) process.stdout.write(prettyCanonicalJson(summary));
  else process.stdout.write(renderTerminal(summary, snapshot) + "\n");
} catch (error) {
  const failure = {
    contract_version: "1.0",
    kind: "payroll-demo-failure",
    run: path.basename(outputRoot),
    code: error?.code ?? "BERGBOK_PAYROLL_DEMO_ERROR",
    message: redact(error?.message ?? String(error)),
    at: new Date().toISOString(),
  };
  events.push({ event: "payroll_demo_failed", at: failure.at, code: failure.code, message: failure.message });
  await writeFile(path.join(outputRoot, "failure.json"), prettyCanonicalJson(failure), "utf8");
  await writeFile(path.join(outputRoot, "events.ndjson"), events.map(JSON.stringify).join("\n") + "\n", "utf8");
  process.stderr.write(`Payroll demo failed: ${failure.message}\nRun package: ${outputRoot}\n`);
  process.exitCode = 1;
}

async function snapshotCase(caseRoot, targetRoot) {
  const manifestPath = await pathWithin(caseRoot, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  validateManifest(manifest);
  const inputRoot = path.join(targetRoot, "input");
  await mkdir(path.join(inputRoot, "state"), { recursive: true });
  await mkdir(path.join(inputRoot, "docset"), { recursive: true });
  await writeFile(path.join(inputRoot, "case-manifest.json"), manifestBytes);

  const stateSource = await pathWithin(caseRoot, manifest.previous_state);
  const stateBytes = await readFile(stateSource);
  const statePayload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stateBytes));
  await writeFile(path.join(inputRoot, "state", "state.json"), stateBytes);
  const payrollState = sealContent({
    schemaId: "se.bergbok.payroll.state",
    schemaVersion: statePayload.schema_version ?? "1.0",
    stableId: `${manifest.company_id}:payroll-state`,
    version: 1,
    payload: statePayload,
  });
  const previousState = createStateEnvelope({
    companyId: manifest.company_id,
    sequence: 1,
    core: { organization: { name: manifest.company_name } },
    domains: { payroll: payrollState },
  });

  const documents = [];
  const inputFiles = [];
  inputFiles.push(fileDescriptor("input/case-manifest.json", manifestBytes));
  inputFiles.push(fileDescriptor("input/state/state.json", stateBytes));
  const usedNames = new Set();
  for (const item of manifest.documents) {
    const source = await pathWithin(caseRoot, item.path);
    const bytes = await readFile(source);
    const filename = path.basename(item.path);
    if (usedNames.has(filename)) throw new Error(`Duplicate Docset filename: ${filename}`);
    usedNames.add(filename);
    const relative = path.join("input", "docset", filename);
    await writeFile(path.join(targetRoot, relative), bytes);
    const digest = sha256Bytes(bytes);
    documents.push({
      document_id: item.document_id,
      filename,
      role: item.role,
      media_type: item.media_type,
      sha256: digest,
      byte_length: bytes.length,
      content_base64: bytes.toString("base64"),
    });
    inputFiles.push({
      relative_path: relative,
      byte_length: bytes.length,
      source_sha256: digest,
      snapshot_sha256: sha256Bytes(await readFile(path.join(targetRoot, relative))),
    });
  }
  const docset = sealContent({
    schemaId: "se.bergbok.docset",
    stableId: `${manifest.company_id}:${manifest.period.id}:docset`,
    version: 1,
    payload: { documents },
  });
  const caseBundle = sealContent({
    schemaId: "se.bergbok.consolidation-case",
    stableId: `${manifest.company_id}:${manifest.period.id}:payroll`,
    version: 1,
    payload: {
      contract_version: "1.0",
      company_id: manifest.company_id,
      domain: "payroll",
      period: manifest.period,
      docset,
      previous_state: previousState,
      upstream_results: [],
      effective_policies: manifest.effective_policies,
    },
  });
  return { manifest, caseBundle, inputFiles };
}

function renderTerminal(summary, snapshotValue) {
  const components = summary.extracted.pay_components;
  const salary = components.find((item) => item.type === "fixed_monthly_salary");
  const absence = components.find((item) => item.type === "ordinary_absence");
  const correction = components.find((item) => item.type === "correction");
  return [
    "Payroll evidence-to-proposal demo",
    `Run: ${summary.run}`,
    `Company: ${summary.company_name} (${summary.company_id})`,
    `Period: ${summary.period_id}`,
    `Assessment: ${summary.model}, reasoning ${summary.reasoning_effort}`,
    "",
    "Evidence",
    ...snapshotValue.manifest.documents.map((item) => `  - ${item.document_id}: ${path.basename(item.path)}`),
    "",
    "Extracted by the model",
    `  - Employee: ${summary.extracted.employee.name} (${summary.extracted.employee.employee_id})`,
    `  - Fixed salary: ${salary?.amount ?? "0.00 SEK"}`,
    `  - Unpaid absence: ${absence?.days ?? 0} full days`,
    `  - Prior-period correction: ${correction?.amount ?? "0.00 SEK"}`,
    `  - Payment date: ${summary.extracted.payment_date}`,
    `  - Evidence citations: ${summary.extracted.citations.length}`,
    "",
    "Calculated deterministically",
    `  - Absence deduction: ${summary.calculated.absence_deduction}`,
    `  - Gross pay: ${summary.calculated.gross_pay}`,
    `  - Withholding: ${summary.calculated.tax_withheld}`,
    `  - Net pay: ${summary.calculated.net_pay}`,
    `  - Employer contribution: ${summary.calculated.employer_contribution}`,
    "",
    "Safety checks",
    "  [OK] Input files were copied byte-for-byte and hash-checked",
    "  [OK] Every model citation was validated against document line bounds",
    "  [OK] Payroll economic facts reconcile without choosing ledger accounts",
    "  [OK] Assessment and projected State are sealed",
    "",
    "No State was written, payment sent, AGI filed, or external action performed.",
    "The tax, contribution, and absence settings are illustrative demo rules—not authoritative Swedish payroll law.",
    "",
    `Report: ${summary.files.report}`,
    `Assessment: ${summary.files.assessment}`,
    `JSON summary: ${path.join(summary.output_directory, "summary.json")}`,
    `Run manifest: ${summary.files.manifest}`,
  ].join("\n");
}

function renderReport({ snapshot: snapshotValue, outcome, summary }) {
  const assessment = outcome.canonical_outputs.payroll_assessment.payload;
  const citationText = assessment.citations.map((citation) =>
    `- \`${citation.fact_path}\`: \`${citation.document_id}\` lines ${citation.line_start}-${citation.line_end}`,
  );
  return [
    "# Payroll evidence-to-proposal demo",
    "",
    "## Scenario",
    "",
    `This synthetic case runs Payroll for ${summary.company_name} in ${summary.period_id}. GPT-5.6 Luna High assesses the immutable Markdown Docset; the private deterministic kernel then calculates the proposal.`,
    "",
    "The fixed 30-day absence divisor, 30% withholding, and 31.42% employer contribution are illustrative demo rules. They are not authoritative Swedish payroll law.",
    "",
    "## Source documents",
    "",
    ...snapshotValue.manifest.documents.map((item) => `- [${item.document_id}](input/docset/${path.basename(item.path)})`),
    "- [preceding Payroll State](input/state/state.json)",
    "- [case manifest](input/case-manifest.json)",
    "",
    "## Model assessment",
    "",
    `- Profile: ${outcome.provenance.assessment.profile_id}`,
    `- Model: ${summary.model}`,
    `- Reasoning effort: ${summary.reasoning_effort}`,
    `- Assessment calls: ${outcome.provenance.assessment.attempts}`,
    `- Tokens: ${summary.usage.input_tokens} input, ${summary.usage.output_tokens} output, ${summary.usage.total_tokens} total`,
    `- Employee: ${assessment.employee.name} (${assessment.employee.employee_id})`,
    `- Payment date: ${assessment.payment_date}`,
    `- Components: ${assessment.pay_components.map((item) => item.description).join("; ")}`,
    "",
    "### Evidence citations",
    "",
    ...citationText,
    "",
    "## Deterministic payroll result",
    "",
    `- Fixed salary: ${summary.calculated.fixed_monthly_salary}`,
    `- Absence deduction: ${summary.calculated.absence_deduction}`,
    `- Correction: ${summary.calculated.correction}`,
    `- Gross pay: ${summary.calculated.gross_pay}`,
    `- Withholding: ${summary.calculated.tax_withheld}`,
    `- Net pay: ${summary.calculated.net_pay}`,
    `- Employer contribution: ${summary.calculated.employer_contribution}`,
    "",
    "## Integrity checks",
    "",
    ...Object.entries(summary.integrity).map(([key, value]) => `- ${value ? "[OK]" : "[FAIL]"} ${key}`),
    "",
    "## Actions not performed",
    "",
    "Payroll produced reviewable canonical data only. It did not write authoritative State or ledger data, approve payroll, send salary, file AGI, submit reports, or perform any other external action.",
    "",
  ].join("\n");
}

function parseArguments(args) {
  const optionsValue = { json: false, case: null, output: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") optionsValue.json = true;
    else if (argument === "--case" || argument === "--output") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a directory.`);
      optionsValue[argument.slice(2)] = value;
      index += 1;
    } else throw new Error("Usage: node modules/payroll/demo/run.mjs [--case DIRECTORY] [--output DIRECTORY] [--json]");
  }
  return optionsValue;
}

async function loadLocalEnvironment(filename) {
  let text;
  try {
    text = await readFile(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const [lineNumber, sourceLine] of text.split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid .env.local line ${lineNumber + 1}.`);
    const [, name, raw] = match;
    if (!new Set(["OPENAI_API_KEY", "OPENAI_BASE_URL"]).has(name)) {
      throw new Error(`Unsupported .env.local setting ${name}.`);
    }
    if (process.env[name] !== undefined) continue;
    const value = raw.trim();
    process.env[name] = ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  }
}

async function pathWithin(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`Case path must be a non-empty relative path: ${relativePath}`);
  }
  const [realRoot, candidate] = await Promise.all([realpath(root), realpath(path.resolve(root, relativePath))]);
  if (candidate !== realRoot && !candidate.startsWith(realRoot + path.sep)) throw new Error(`Case path escapes its directory: ${relativePath}`);
  return candidate;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Case manifest must be an object.");
  for (const field of ["case_id", "company_id", "company_name", "previous_state"]) {
    if (typeof manifest[field] !== "string" || manifest[field].length === 0) throw new Error(`Case manifest is missing ${field}.`);
  }
  if (!/^\d{4}-\d{2}$/.test(manifest.period?.id ?? "")) throw new Error("Case manifest period.id must be YYYY-MM.");
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) throw new Error("Case manifest needs documents.");
  if (manifest.documents.some((item) => item.role !== "payroll-evidence")) throw new Error("Demo documents must have role payroll-evidence.");
}

async function describeFiles(root, relatives) {
  return Promise.all(relatives.map(async (relative) => fileDescriptor(relative, await readFile(path.join(root, relative)))));
}

function fileDescriptor(relativePath, bytes) {
  return {
    relative_path: relativePath,
    byte_length: bytes.length,
    source_sha256: sha256Bytes(bytes),
    snapshot_sha256: sha256Bytes(bytes),
  };
}

async function writeSafeJson(filename, value) {
  return writeSafeText(filename, prettyCanonicalJson(value));
}

async function writeSafeText(filename, text) {
  assertSecretAbsent(text);
  await writeFile(filename, text, "utf8");
}

function assertSecretAbsent(text) {
  const secret = process.env.OPENAI_API_KEY;
  if (typeof secret === "string" && secret.length >= 8 && text.includes(secret)) {
    throw demoError("BERGBOK_PAYROLL_SECRET_LEAK", "A generated artifact would contain OPENAI_API_KEY; it was not written.");
  }
}

function redact(message) {
  const secret = process.env.OPENAI_API_KEY;
  return typeof secret === "string" && secret.length > 0 ? String(message).split(secret).join("[REDACTED]") : String(message);
}

function demoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
