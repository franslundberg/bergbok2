import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { sha256Bytes } from "../../../contracts/src/canonical.mjs";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const caseRoot = path.join(repositoryRoot, "modules", "payroll", "cases", "simple-september");
const TEST_KEY = "fake-demo-key-that-must-not-appear";

test("Payroll demo presents a human walkthrough and a complete JSON mode using a fake Responses endpoint", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bergbok-payroll-demo-"));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp-demo-${requests.length}`,
      status: "completed",
      output_text: JSON.stringify(demoAssessment()),
      usage: { input_tokens: 700, output_tokens: 300, total_tokens: 1000 },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const environment = {
    ...process.env,
    OPENAI_API_KEY: TEST_KEY,
    OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  };
  try {
    const humanRoot = path.join(temporaryRoot, "human");
    const human = await execute(process.execPath, ["modules/payroll/demo/run.mjs", "--output", humanRoot], {
      cwd: repositoryRoot,
      env: environment,
    });
    assert.match(human.stdout, /^Payroll evidence-to-proposal demo/);
    assert.doesNotMatch(human.stdout, /^\s*\{/);
    assert.match(human.stdout, /\[OK\] Input files were copied byte-for-byte/);
    assert.match(human.stdout, /economic facts reconcile without choosing ledger accounts/);
    assert.match(human.stdout, /not authoritative Swedish payroll law/);
    await verifyRunPackage(humanRoot);

    const jsonRoot = path.join(temporaryRoot, "json");
    const json = await execute(process.execPath, ["modules/payroll/demo/run.mjs", "--output", jsonRoot, "--json"], {
      cwd: repositoryRoot,
      env: environment,
    });
    const summary = JSON.parse(json.stdout);
    assert.equal(summary.kind, "payroll-evidence-demo");
    assert.equal(summary.outcome, "proposal");
    assert.equal(summary.model, "gpt-5.6-luna");
    assert.equal(summary.reasoning_effort, "high");
    assert.equal(summary.calculated.gross_pay, "36833.33 SEK");
    await verifyRunPackage(jsonRoot);

    assert.equal(requests.length, 2);
    for (const item of requests) {
      assert.equal(item.url, "/v1/responses");
      assert.equal(item.body.model, "gpt-5.6-luna");
      assert.deepEqual(item.body.reasoning, { effort: "high" });
      assert.equal(item.body.store, false);
      assert.deepEqual(item.body.tools, []);
      assert.equal(item.body.text.format.type, "json_schema");
      assert.equal(item.body.text.format.strict, true);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function verifyRunPackage(root) {
  const files = [
    "input/case-manifest.json",
    "input/state/state.json",
    "input/docset/employment-agreement.md",
    "input/docset/absence-report.md",
    "input/docset/employee-messages.md",
    "assessment.json",
    "payroll-result.json",
    "report.md",
    "summary.json",
    "manifest.json",
    "events.ndjson",
  ];
  for (const filename of files) assert.equal((await stat(path.join(root, filename))).isFile(), true, filename);
  for (const filename of ["employment-agreement.md", "absence-report.md", "employee-messages.md"]) {
    const [source, copied] = await Promise.all([
      readFile(path.join(caseRoot, "input", "docset", filename)),
      readFile(path.join(root, "input", "docset", filename)),
    ]);
    assert.deepEqual(copied, source);
  }
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  for (const file of manifest.input_files) {
    const bytes = await readFile(path.join(root, file.relative_path));
    assert.equal(bytes.length, file.byte_length);
    assert.equal(sha256Bytes(bytes), file.snapshot_sha256);
    assert.equal(file.source_sha256, file.snapshot_sha256);
  }
  const assessment = JSON.parse(await readFile(path.join(root, "assessment.json"), "utf8"));
  assert.equal(assessment.ref.schema_id, "se.bergbok.payroll.assessment");
  const report = await readFile(path.join(root, "report.md"), "utf8");
  assert.match(report, /GPT-5\.6 Luna High assesses/);
  assert.match(report, /`payment_date`: `employee-messages` lines 5-5/);
  const allText = (await Promise.all(files.map((filename) => readFile(path.join(root, filename), "utf8")))).join("\n");
  assert.doesNotMatch(allText, new RegExp(TEST_KEY));
}

function demoAssessment() {
  return {
    schema_version: "2.0",
    status: "ready",
    employee: {
      employee_id: "employee-1",
      name: "Kim Example",
      personal_identity_number: "19900101-0000",
      payment_destination: "SE00-DEMO-PAYROLL-ACCOUNT",
    },
    payment_date: "2026-09-25",
    pay_components: [
      { type: "fixed_monthly_salary", description: "Fixed monthly salary", amount: "40000.00 SEK", days: null, relates_to_period: null },
      { type: "ordinary_absence", description: "Two approved full days of unpaid absence", amount: null, days: 2, relates_to_period: null },
      { type: "correction", description: "August overpayment correction", amount: "-500.00 SEK", days: null, relates_to_period: "2026-08" },
    ],
    citations: [
      citation("employee.employee_id", "employment-agreement", 4),
      citation("employee.name", "employment-agreement", 5),
      citation("employee.personal_identity_number", "employment-agreement", 6),
      citation("employee.payment_destination", "employment-agreement", 7),
      citation("payment_date", "employee-messages", 5),
      citation("pay_components[0]", "employment-agreement", 10),
      { fact_path: "pay_components[1]", document_id: "absence-report", line_start: 6, line_end: 10 },
      { fact_path: "pay_components[2]", document_id: "employee-messages", line_start: 3, line_end: 4 },
    ],
    questions: [],
    warnings: [{
      code: "SYNTHETIC_CASE",
      message: "The identifiers and payment destination are explicitly synthetic.",
      related_document_ids: ["employment-agreement"],
    }],
    reasons: [],
  };
}

function citation(factPath, documentId, line) {
  return { fact_path: factPath, document_id: documentId, line_start: line, line_end: line };
}
