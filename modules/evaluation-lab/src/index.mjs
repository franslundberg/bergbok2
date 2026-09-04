import { cloneJson, sha256Json } from "../../../contracts/src/canonical.mjs";
import {
  ContractError,
  assertModuleOutcome,
  sealContent,
  verifySealedContent,
} from "../../../contracts/src/index.mjs";
import { deterministicChecks, semanticComparison } from "./private/compare.mjs";
import { renderComparison, renderExperiment } from "./private/report.mjs";

export function evaluate(testCase, candidateValue, gradingProfile) {
  const normalizedCase = normalizeTestCase(testCase);
  const profile = normalizeGradingProfile(gradingProfile ?? normalizedCase.grading_profile);
  const candidate = unwrapOutcome(candidateValue) ?? {};
  const reference = unwrapOutcome(normalizedCase.reference);
  const contractChecks = [];
  try {
    assertModuleOutcome(candidate, { caseRef: normalizedCase.input.ref, domain: reference.domain });
    contractChecks.push({ id: "module-outcome-contract", passed: true, detail: "Candidate obeys the public outcome contract and case binding" });
  } catch (error) {
    contractChecks.push({ id: "module-outcome-contract", passed: false, detail: error.message });
  }

  const deterministic = deterministicChecks(candidate);
  const semantic = semanticComparison(reference, candidate, profile);
  const deterministicChecksAll = [...contractChecks, ...deterministic.checks];
  const deterministicFailures = deterministicChecksAll.filter((item) => !item.passed).length;
  const semanticErrors = semantic.findings.filter((item) => item.severity === "error").length;
  const passed =
    deterministicFailures <= profile.decision.max_deterministic_failures &&
    semanticErrors <= profile.decision.max_semantic_errors;
  const evaluation = {
    contract_version: "1.0",
    schema_version: "2.0",
    case_id: normalizedCase.case_id,
    grading_profile: { id: profile.id, version: profile.version },
    candidate_sha256: sha256Json(candidate),
    reference_sha256: sha256Json(reference),
    passed,
    deterministic_failure_count: deterministicFailures,
    semantic_error_count: semanticErrors,
    deterministic_checks: deterministicChecksAll,
    semantic_findings: semantic.findings,
    account_comparison: semantic.accountComparison,
  };
  const comparisonMarkdown = renderComparison(evaluation);
  return sealContent({
    schemaId: "se.bergbok.evaluation-package",
    schemaVersion: "2.0",
    stableId: `${normalizedCase.case_id}:evaluation:${evaluation.candidate_sha256.slice(0, 16)}`,
    version: profile.version,
    payload: {
      schema_version: "2.0",
      evaluation,
      comparison_md: comparisonMarkdown,
      reference_visibility: "hidden_from_candidate_runner",
    },
  });
}

export async function runTrials(testCase, variants, trialPlan) {
  const normalizedCase = normalizeTestCase(testCase);
  if (!Array.isArray(variants) || variants.length === 0) throw new ContractError("runTrials requires at least one variant");
  if (!Number.isSafeInteger(trialPlan?.repetitions) || trialPlan.repetitions < 1) {
    throw new ContractError("trialPlan.repetitions must be a positive integer");
  }
  const profile = normalizeGradingProfile(trialPlan.grading_profile ?? normalizedCase.grading_profile);
  const planId = String(trialPlan.id ?? "trial-plan");
  const trials = [];
  for (const variant of variants) {
    if (typeof variant?.id !== "string" || typeof variant.run !== "function") {
      throw new ContractError("Each variant must contain id and run(input, context)");
    }
    for (let repetition = 1; repetition <= trialPlan.repetitions; repetition += 1) {
      const trialId = `trial-${sha256Json({ case: normalizedCase.input.ref, planId, variant: variant.id, repetition }).slice(0, 16)}`;
      const started = process.hrtime.bigint();
      const raw = await variant.run(cloneJson(normalizedCase.input), { trial_id: trialId, repetition });
      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
      const candidate = raw?.candidate ?? raw;
      const metrics = raw?.metrics ?? {};
      const evaluationPackage = evaluate(normalizedCase, candidate, profile);
      trials.push({
        trial_id: trialId,
        variant_id: variant.id,
        repetition,
        passed: evaluationPackage.payload.evaluation.passed,
        evaluation_ref: cloneJson(evaluationPackage.ref),
        evaluation: cloneJson(evaluationPackage.payload.evaluation),
        metrics: {
          cost_usd_micros: nonNegativeInteger(metrics.cost_usd_micros ?? 0, "cost_usd_micros"),
          duration_ms: nonNegativeNumber(metrics.duration_ms ?? elapsed, "duration_ms"),
          steps: nonNegativeInteger(metrics.steps ?? 1, "steps"),
        },
      });
    }
  }
  const summaries = variants.map((variant) => summarizeVariant(variant.id, trials));
  const experiment = {
    contract_version: "1.0",
    schema_version: "2.0",
    plan_id: planId,
    case_id: normalizedCase.case_id,
    repetitions: trialPlan.repetitions,
    grading_profile: { id: profile.id, version: profile.version },
    variants: summaries,
    trials,
  };
  return sealContent({
    schemaId: "se.bergbok.experiment-package",
    schemaVersion: "2.0",
    stableId: `${normalizedCase.case_id}:experiment:${planId}`,
    version: String(trialPlan.version ?? "1"),
    payload: {
      schema_version: "2.0",
      experiment,
      comparison_md: renderExperiment(experiment),
      blinding: "Candidate runners received input only; reference and Grading Manual remained in Evaluation Lab",
    },
  });
}

export function createTestCase({ caseId, input, reference, gradingProfile, gradingManual = "" }) {
  if (typeof caseId !== "string" || caseId.length === 0) throw new ContractError("caseId is required");
  verifySealedContent(input, "test case input");
  const referenceOutcome = unwrapOutcome(reference);
  assertModuleOutcome(referenceOutcome, { caseRef: input.ref });
  return Object.freeze({
    case_id: caseId,
    input: cloneJson(input),
    reference: cloneJson(referenceOutcome),
    grading_profile: cloneJson(normalizeGradingProfile(gradingProfile)),
    grading_manual_md: String(gradingManual),
  });
}

function normalizeTestCase(value) {
  if (!value || typeof value.case_id !== "string") throw new ContractError("testCase.case_id is required");
  verifySealedContent(value.input, "testCase.input");
  if (!value.reference) throw new ContractError("testCase.reference is required by Evaluation Lab");
  return value;
}

function normalizeGradingProfile(value) {
  if (!value || typeof value !== "object") throw new ContractError("A versioned grading profile is required");
  if (typeof value.id !== "string" || typeof value.version !== "string") {
    throw new ContractError("grading profile requires string id and version");
  }
  return {
    ...cloneJson(value),
    decision: {
      max_deterministic_failures: nonNegativeInteger(value.decision?.max_deterministic_failures ?? 0, "max_deterministic_failures"),
      max_semantic_errors: nonNegativeInteger(value.decision?.max_semantic_errors ?? 0, "max_semantic_errors"),
    },
  };
}

function unwrapOutcome(value) {
  if (value?.ref && value?.payload) {
    verifySealedContent(value);
    return value.payload.outcome ?? value.payload.module_outcome ?? value.payload;
  }
  return value;
}

function summarizeVariant(variantId, trials) {
  const selected = trials.filter((trial) => trial.variant_id === variantId);
  const passed = selected.filter((trial) => trial.passed).length;
  return {
    variant_id: variantId,
    trials: selected.length,
    passed,
    pass_rate: passed / selected.length,
    mean_cost_usd_micros: mean(selected.map((trial) => trial.metrics.cost_usd_micros)),
    mean_duration_ms: mean(selected.map((trial) => trial.metrics.duration_ms)),
    mean_steps: mean(selected.map((trial) => trial.metrics.steps)),
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ContractError(`${label} must be a non-negative integer`);
  return value;
}

function nonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new ContractError(`${label} must be a non-negative finite number`);
  return value;
}
