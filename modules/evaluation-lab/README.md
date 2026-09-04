# Evaluation Lab

Evaluation Lab is development-only. It owns immutable cases, independently
approved references, Grading Manuals, deterministic and semantic comparison,
and repeated-run experiment reporting.

```text
evaluate(testCase, candidate, gradingProfile?) -> EvaluationPackage
runTrials(testCase, variants, trialPlan) -> ExperimentPackage
```

Checked-in cases live under `cases/`; grading and report implementation remains
private under `src/private/`. Evaluation Lab is not on the production approval
path.

Run `npm run test:evaluation` or `npm run demo:evaluation` from the repository
root. See the root [module handbook](../../MODULES.md) for the full boundary.
