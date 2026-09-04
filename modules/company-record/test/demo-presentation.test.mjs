import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(here, "../../..");
const DEMO_SCRIPT = path.join(REPOSITORY_ROOT, "modules/company-record/demo/run.mjs");
const TEST_ROOT = path.join(here, ".tmp/demo-presentation");

after(() => rm(TEST_ROOT, { recursive: true, force: true }));

test("default demo output is human-readable and produces an inspectable run package", async () => {
  const outputDir = path.join(TEST_ROOT, "human-run");
  await rm(outputDir, { recursive: true, force: true });

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [DEMO_SCRIPT, "--output", outputDir],
    { cwd: REPOSITORY_ROOT },
  );

  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /^\s*\{/);
  assert.match(stdout, /Bergbok — Company Record demo/);
  assert.match(stdout, /supplier invoice 1042/i);
  assert.match(stdout, /\[OK\] Stale approval rejected — BERGBOK_STALE_DOCSET/);
  assert.match(stdout, /\[OK\] Tampering detected — BERGBOK_INTEGRITY_ERROR/);
  assert.match(stdout, /Report:/);
  assert.match(stdout, /Timeline:/);
  assert.match(stdout, /Summary JSON:/);
  assert.match(stdout, /Store:/);

  for (const relativePath of [
    "report.md",
    "summary.json",
    "timeline.json",
    "timeline.md",
    "input/supplier-invoice-1042.txt",
    "input/supplier-invoice-1042-payment-confirmation.txt",
  ]) {
    await access(path.join(outputDir, relativePath));
  }
  assert.equal((await stat(path.join(outputDir, "store"))).isDirectory(), true);

  const summary = JSON.parse(await readFile(path.join(outputDir, "summary.json"), "utf8"));
  assert.equal(summary.run_id, "human-run");
  assert.equal(summary.company.legal_name, "Demo Company AB");
  assert.equal(summary.period_id, "2026-02");
  assert.equal(summary.stale_rejection.ok, true);
  assert.equal(summary.stale_rejection.code, "BERGBOK_STALE_DOCSET");
  assert.equal(summary.tamper_rejection.ok, true);
  assert.equal(summary.tamper_rejection.code, "BERGBOK_INTEGRITY_ERROR");

  await assertEvidenceMatches(outputDir, summary.ingested_evidence);
  await assertEvidenceMatches(outputDir, summary.newly_arrived_evidence);

  const report = await readFile(path.join(outputDir, "report.md"), "utf8");
  assert.match(report, /synthetic supplier invoice/i);
  assert.match(report, /\[Detailed timeline\]\(timeline\.md\)/);
  assert.match(report, /bookkeeping `ModuleOutcome`.*synthetic/i);
  assert.match(report, /tests Company Record independently/i);
  assert.match(report, /BERGBOK_STALE_DOCSET/);
  assert.match(report, /BERGBOK_INTEGRITY_ERROR/);
});

test("--json prints the complete summary and positional output directories remain supported", async () => {
  const outputDir = path.join(TEST_ROOT, "json-run");
  await rm(outputDir, { recursive: true, force: true });

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [DEMO_SCRIPT, outputDir, "--json"],
    { cwd: REPOSITORY_ROOT },
  );

  assert.equal(stderr, "");
  const printed = JSON.parse(stdout);
  const stored = JSON.parse(await readFile(path.join(outputDir, "summary.json"), "utf8"));
  assert.deepEqual(printed, stored);
  assert.equal(printed.output_directory, outputDir);
  assert.equal(printed.ingested_evidence.content_sha256.length, 64);
  assert.equal(printed.newly_arrived_evidence.content_sha256.length, 64);
  assert.ok(printed.approved_run_ref.sha256);
  assert.ok(printed.approval_receipt_ref.sha256);
  assert.ok(printed.published_state_ref.sha256);
});

async function assertEvidenceMatches(outputDir, evidence) {
  const bytes = await readFile(path.join(outputDir, "input", evidence.filename));
  assert.equal(bytes.length, evidence.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), evidence.content_sha256);
}
