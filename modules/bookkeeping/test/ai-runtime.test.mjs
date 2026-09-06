import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createStateEnvelope, sealContent } from "../../../contracts/src/index.mjs";
import { runAgent } from "../src/private/ai/agent.mjs";
import { parseCandidate, validateCandidate } from "../src/private/ai/candidate.mjs";
import { startWorkspace } from "../src/private/ai/docker.mjs";
import { MAX_RUN_MS, MAX_STEPS } from "../src/private/ai/constants.mjs";

function caseBundle() {
  const previous = createStateEnvelope({ companyId: "example-ab", sequence: 0, core: {}, domains: {} });
  const docset = sealContent({
    schemaId: "se.bergbok.docset",
    stableId: "example-ab:start:docset",
    version: 1,
    payload: { documents: [{ document_id: "D1", filename: "company.md", media_type: "text/markdown", role: "evidence", content_base64: Buffer.from("Example AB").toString("base64") }] },
  });
  return sealContent({
    schemaId: "se.bergbok.consolidation-case",
    stableId: "example-ab:start:bookkeeping",
    version: 1,
    payload: {
      contract_version: "1.0",
      company_id: "example-ab",
      domain: "bookkeeping",
      period: { id: "Start", kind: "start", end: "2025-12-31" },
      docset,
      previous_state: previous,
      effective_policies: {
        core: {
          country: "SE",
          currency: "SEK",
          fiscal_year: { start: "2025-01-01", end: "2025-12-31" },
          accounting_method: "invoice",
        },
        bookkeeping: {
          profile: "se-private-ab-invoice-calendar-demo-v1",
          verification_series: "A",
          chart_of_accounts: "BAS",
          vat_reporting: {
            frequency: "quarterly",
            input_accounts: ["2641"],
            output_accounts: ["2611"],
            settlement_account: "2650",
          },
        },
      },
      upstream_results: [],
    },
  });
}

function candidate() {
  return {
    schema_id: "se.bergbok.bookkeeping-ai-candidate",
    schema_version: "4.0",
    status: "proposal",
    core: {
      organization: { name: "Example AB", organization_number: "559999-9999" },
      registrations: {},
      address: {},
      policies: {
        bookkeeping: {
          chart_of_accounts: "BAS",
          vat_reporting: {
            frequency: "quarterly",
            input_accounts: ["2641"],
            output_accounts: ["2611"],
            settlement_account: "2650",
          },
        },
      },
      evidence_document_ids: ["D1"],
    },
    bookkeeping_input: {
      schema_id: "se.bergbok.bookkeeping-input",
      schema_version: "3.0",
      company_id: "example-ab",
      period_id: "Start",
      mode: "start",
      transactions: [], open_item_changes: [], reconciliations: [], vat: { status: "not_due" },
    },
    review: { summary: "No transactions are needed for Start.", transaction_summaries: [] },
    questions: [], warnings: [], reasons: [],
  };
}

test("AI runtime permits the configured assessment budget", () => {
  assert.equal(MAX_STEPS, 100);
  assert.equal(MAX_RUN_MS, 60 * 60_000);
});

test("AI candidate parser rejects malformed or untyped output", () => {
  assert.equal(parseCandidate("not json").ok, false);
  assert.equal(parseCandidate(JSON.stringify({ schema_id: "wrong" })).ok, false);
  assert.equal(parseCandidate(JSON.stringify(candidate())).ok, true);
  const multiline = candidate();
  multiline.review.transaction_summaries = [{ source_id: "T1", summary: "two\nlines" }];
  assert.equal(parseCandidate(JSON.stringify(multiline)).ok, false);
  const obsolete = candidate();
  obsolete.schema_version = "2.0";
  assert.equal(parseCandidate(JSON.stringify(obsolete)).ok, false);
});

test("AI candidate mode must match the fixed Period kind", () => {
  const value = candidate();
  value.bookkeeping_input.mode = "ordinary";
  const result = validateCandidate({
    source: JSON.stringify(value),
    caseBundle: caseBundle(),
    evaluate: () => { throw new Error("mode mismatch must stop before evaluation"); },
    provenance: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /must be start/);
});

test("initial AI candidate must propose the evidence-backed fixed VAT policy", () => {
  const missing = candidate();
  delete missing.core.policies;
  const missingResult = validateCandidate({
    source: JSON.stringify(missing),
    caseBundle: caseBundle(),
    evaluate: () => { throw new Error("missing policy must stop before evaluation"); },
    provenance: {},
  });
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.errors[0], /BAS chart of accounts/);

  const wrong = candidate();
  wrong.core.policies.bookkeeping.vat_reporting.settlement_account = "2660";
  const wrongResult = validateCandidate({
    source: JSON.stringify(wrong),
    caseBundle: caseBundle(),
    evaluate: () => { throw new Error("wrong policy must stop before evaluation"); },
    provenance: {},
  });
  assert.equal(wrongResult.ok, false);
  assert.match(wrongResult.errors[0], /controller-owned onboarding policy/);
});

test("agent dispatches custom tools, replays call IDs, disables storage, and stops on validation", async () => {
  const bodies = [];
  const responses = [
    { status: "completed", output: [{ type: "function_call", name: "shell", call_id: "call-shell", arguments: JSON.stringify({ command: "find /workspace/input -type f", timeout_ms: 1000, max_output_chars: 1000 }) }], usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } },
    { status: "completed", output: [{ type: "function_call", name: "validate_bookkeeping_candidate", call_id: "call-validate", arguments: "{}" }], usage: { input_tokens: 12, output_tokens: 2, input_tokens_details: { cached_tokens: 5 } } },
  ];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    const value = responses.shift();
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(value) };
  };
  const value = candidate();
  const result = await runAgent({
    apiKey: "test-key",
    apiUrl: "https://example.invalid/responses",
    caseBundle: caseBundle(),
    variant: { id: "test", allow_web: false },
    price: { model: "test-model", reasoning_effort: "high", input_usd_per_million: 1, cached_input_usd_per_million: 0.1, output_usd_per_million: 2 },
    workspace: {
      executeShell: async () => ({ exit_code: 0, stdout: "company.md", stderr: "" }),
      listOutputFiles: async () => ["candidate.json"],
      readCandidate: async () => JSON.stringify(value),
    },
    evaluate: () => ({ kind: "proposal" }),
    fetchImpl,
  });
  assert.equal(result.validation.ok, true);
  assert.equal(result.steps, 2);
  assert.equal(bodies[0].store, false);
  assert.equal(bodies[0].parallel_tool_calls, false);
  assert.deepEqual(bodies[0].include, ["reasoning.encrypted_content"]);
  assert.ok(bodies[1].input.some((item) => item.type === "function_call_output" && item.call_id === "call-shell"));
});

test("Docker worker mounts inputs read-only and has no network by default", { skip: process.env.RUN_DOCKER_TESTS !== "1" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-ai-docker-test-"));
  const input = path.join(root, "input");
  const context = path.join(root, "context");
  await Promise.all([mkdir(input), mkdir(context)]);
  await Promise.all([writeFile(path.join(input, "evidence.txt"), "fixed"), writeFile(path.join(context, "case.json"), "{}")]);
  const workspace = await startWorkspace({ runId: `test-${process.pid}-${Date.now()}`, docsetPath: input, contextPath: context, allowWeb: false });
  try {
    assert.equal((await workspace.executeShell({ command: "cat /workspace/input/evidence.txt", timeout_ms: 1000, max_output_chars: 1000 })).stdout, "fixed");
    assert.notEqual((await workspace.executeShell({ command: "touch /workspace/input/changed", timeout_ms: 1000, max_output_chars: 1000 })).exit_code, 0);
    assert.notEqual((await workspace.executeShell({ command: "curl --max-time 2 -fsS https://example.com", timeout_ms: 4000, max_output_chars: 1000 })).exit_code, 0);
  } finally {
    await workspace.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
