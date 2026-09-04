import assert from "node:assert/strict";
import test from "node:test";

import { createModuleOutcome, sealContent } from "../../../contracts/src/index.mjs";
import { createTestCase, evaluate, runTrials } from "../src/index.mjs";
import { loadCaseDirectory } from "../src/directory-adapter.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const input = sealContent({
  schemaId: "se.bergbok.consolidation-case",
  stableId: "lab:2026-03:bookkeeping",
  version: 1,
  payload: { fixed_input: true },
});

function outcome(account = "6540", extra = [], schemaVersion = "2.0") {
  const legacy = schemaVersion === "1.0";
  const projectedState = sealContent({
    schemaId: "se.bergbok.bookkeeping.state",
    schemaVersion,
    stableId: "lab:bookkeeping-state",
    version: 1,
    payload: { schema_version: schemaVersion, currency: "SEK", ledger: { account } },
  });
  return createModuleOutcome({
    kind: "proposal",
    domain: "bookkeeping",
    caseRef: input.ref,
    projectedState,
    canonicalOutputs: {
      bookkeeping: {
        schema_version: schemaVersion,
        ledger: {
          currency: "SEK",
          transactions: [{
            verification_id: "A1",
            evidence_ids: ["doc-1"],
            lines: [
              legacy
                ? { account, debit_ore: 10001, credit_ore: 0 }
                : { account, debit: "100.00 SEK", credit: "0.00 SEK" },
              legacy
                ? { account: "1930", debit_ore: 0, credit_ore: 10001 }
                : { account: "1930", debit: "0.00 SEK", credit: "100.00 SEK" },
            ],
          }, ...extra],
        },
      },
    },
  });
}

const gradingProfile = {
  id: "ordinary-month-v2",
  version: "2",
  account_tolerance: "0.00 SEK",
  account_equivalence_groups: [["6540", "6550"]],
  decision: { max_deterministic_failures: 0, max_semantic_errors: 0 },
};
const testCase = createTestCase({ caseId: "ordinary-month", input, reference: outcome(), gradingProfile });

test("Evaluation Lab accepts an explicitly equivalent account alternative", () => {
  const result = evaluate(testCase, outcome("6550"), gradingProfile);
  assert.equal(result.payload.evaluation.passed, true);
  assert.equal(result.ref.schema_version, "2.0");
  assert.equal(result.payload.schema_version, "2.0");
  assert.match(result.payload.comparison_md, /Result:\*\* PASS/);
});

test("a contract-valid semantic account error is distinguished from deterministic failure", () => {
  const result = evaluate(testCase, outcome("6990"), gradingProfile);
  assert.equal(result.payload.evaluation.passed, false);
  assert.equal(result.payload.evaluation.deterministic_failure_count, 0);
  assert.ok(result.payload.evaluation.semantic_error_count > 0);
});

test("an invented balanced transaction is rejected semantically", () => {
  const invented = {
    verification_id: "A2",
    evidence_ids: ["invented-doc"],
    lines: [
      { account: "6110", debit: "50.00 SEK", credit: "0.00 SEK" },
      { account: "1930", debit: "0.00 SEK", credit: "50.00 SEK" },
    ],
  };
  const result = evaluate(testCase, outcome("6540", [invented]), gradingProfile);
  assert.equal(result.payload.evaluation.passed, false);
  assert.ok(result.payload.evaluation.semantic_findings.some((item) => item.id === "transaction-count"));
  assert.ok(result.payload.evaluation.semantic_findings.some((item) => item.id === "invented-evidence"));
});

test("Evaluation Lab normalizes legacy v1 ore and reports canonical Money differences", () => {
  const legacy = outcome("6540", [], "1.0");
  const result = evaluate(testCase, legacy, { ...gradingProfile, account_tolerance: "0.00 SEK" });
  assert.equal(result.payload.evaluation.passed, false);
  assert.ok(result.payload.evaluation.account_comparison.some((row) => row.difference === "0.01 SEK"));
});

test("Money-valued account tolerance applies exactly across v1 and v2", () => {
  const legacy = outcome("6540", [], "1.0");
  const result = evaluate(testCase, legacy, { ...gradingProfile, account_tolerance: "0.01 SEK" });
  assert.equal(result.payload.evaluation.passed, true);
  assert.ok(result.payload.evaluation.account_comparison.every((row) => row.difference.endsWith(" SEK")));
});

test("Evaluation Lab rejects a candidate that mixes v1 and v2 line fields", () => {
  const mixed = outcome("6540", [{
    verification_id: "A2",
    evidence_ids: ["doc-1"],
    lines: [
      { account: "6540", debit_ore: 1, credit_ore: 0 },
      { account: "1930", debit_ore: 0, credit_ore: 1 },
    ],
  }]);
  const result = evaluate(testCase, mixed, { ...gradingProfile, allow_transaction_count_difference: true });
  assert.equal(result.payload.evaluation.passed, false);
  assert.ok(result.payload.evaluation.semantic_findings.some((item) => item.id === "money-schema"));
});

test("non-proposal references are graded without pretending they need transactions", () => {
  const question = createModuleOutcome({
    kind: "needs_input",
    domain: "bookkeeping",
    caseRef: input.ref,
    questions: [{ id: "q1", prompt: "Which period does this invoice belong to?" }],
  });
  const questionCase = createTestCase({
    caseId: "question-case",
    input,
    reference: question,
    gradingProfile,
  });
  const result = evaluate(questionCase, question, gradingProfile);
  assert.equal(result.payload.evaluation.passed, true);
  assert.ok(result.payload.evaluation.deterministic_checks.some((item) => item.id === "questions-present"));
});

test("runTrials keeps the reference hidden and uses the declared repetition count", async () => {
  let calls = 0;
  const experiment = await runTrials(testCase, [{
    id: "candidate-a",
    run: async (visibleInput) => {
      calls += 1;
      assert.equal(Object.hasOwn(visibleInput, "reference"), false);
      return { candidate: outcome("6550"), metrics: { cost_usd_micros: 1200, duration_ms: 25, steps: 3 } };
    },
  }], { id: "two-trials", repetitions: 2, grading_profile: gradingProfile });
  assert.equal(calls, 2);
  assert.equal(experiment.payload.experiment.variants[0].pass_rate, 1);
  assert.equal(experiment.payload.experiment.variants[0].mean_steps, 3);
  assert.match(experiment.payload.comparison_md, /two-trials/);
});

test("the common directory case layout is executable", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const loaded = await loadCaseDirectory(path.join(here, "..", "cases", "evaluation-equivalent"));
  assert.equal(loaded.case_id, "evaluation-equivalent");
  assert.equal(loaded.input.payload.previous_state.payload.sequence, 0);
  assert.match(loaded.grading_manual_md, /reference is hidden/i);
});
