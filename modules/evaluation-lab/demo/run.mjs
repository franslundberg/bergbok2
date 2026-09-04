import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCaseDirectory } from "../src/directory-adapter.mjs";
import { evaluate, runTrials } from "../src/index.mjs";
import { createModuleOutcome, sealContent } from "../../../contracts/src/index.mjs";
import { prettyCanonicalJson } from "../../../contracts/src/canonical.mjs";
import { allocateRunDirectory } from "../../../dev/demo-run-directory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const caseDirectory = path.join(here, "..", "cases", "evaluation-equivalent");
const outputRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : await allocateRunDirectory(path.join(here, "generated"));
const testCase = await loadCaseDirectory(caseDirectory);

const makeCandidate = (account, extraTransactions = []) => createModuleOutcome({
  kind: "proposal",
  domain: "bookkeeping",
  caseRef: testCase.input.ref,
  proposedChanges: [{ kind: "transaction", verification_id: "A1" }],
  projectedState: sealContent({
    schemaId: "se.bergbok.bookkeeping.state",
    schemaVersion: "2.0",
    stableId: "example-ab:bookkeeping-candidate-state",
    version: 1,
    payload: {
      schema_version: "2.0",
      currency: "SEK",
      ledger_balances: { "1930": "900.00 SEK", [account]: "100.00 SEK" },
      last_verification: { series: "A", number: 1 },
    },
  }),
  canonicalOutputs: {
    bookkeeping: {
      schema_version: "2.0",
      ledger: {
        currency: "SEK",
        transactions: [{
          verification_id: "A1",
          date: "2026-03-03",
          description: "Software service",
          evidence_ids: ["260303-1"],
          lines: [
            { account, debit: "100.00 SEK", credit: "0.00 SEK" },
            { account: "1930", debit: "0.00 SEK", credit: "100.00 SEK" },
          ],
        }, ...extraTransactions],
      },
    },
  },
  provenance: { module_version: "demo-candidate-v2" },
});

const equivalent = makeCandidate("6550");
const invented = makeCandidate("6540", [{
  verification_id: "A2",
  date: "2026-03-04",
  description: "Invented purchase",
  evidence_ids: ["invented-document"],
  lines: [
    { account: "6110", debit: "50.00 SEK", credit: "0.00 SEK" },
    { account: "1930", debit: "0.00 SEK", credit: "50.00 SEK" },
  ],
}]);

const results = [
  ["equivalent", equivalent, evaluate(testCase, equivalent, testCase.grading_profile)],
  ["invented", invented, evaluate(testCase, invented, testCase.grading_profile)],
];
for (const [name, candidate, result] of results) {
  const directory = path.join(outputRoot, name);
  await mkdir(path.join(directory, "result"), { recursive: true });
  await writeFile(path.join(directory, "manifest.json"), prettyCanonicalJson({
    schema_id: "se.bergbok.demo-run",
    schema_version: "1.0",
    module: "evaluation-lab",
    case_id: testCase.case_id,
    candidate: name,
    evaluation_ref: result.ref,
  }));
  await writeFile(path.join(directory, "result", "candidate.json"), prettyCanonicalJson(candidate));
  await writeFile(path.join(directory, "evaluation.json"), prettyCanonicalJson(result.payload.evaluation));
  await writeFile(path.join(directory, "comparison.md"), result.payload.comparison_md);
  await writeFile(path.join(directory, "report.md"), `# Evaluation Lab demo\n\nCandidate: **${name}**\n\nResult: **${result.payload.evaluation.passed ? "PASS" : "FAIL"}**\n\nSee \`comparison.md\` for the human-readable grading trace.\n`);
}

const experiment = await runTrials(testCase, [{
  id: "equivalent-account",
  run: async () => ({ candidate: equivalent, metrics: { cost_usd_micros: 0, duration_ms: 1, steps: 1 } }),
}], { id: "offline-two-trials", version: "1", repetitions: 2, grading_profile: testCase.grading_profile });
await writeFile(path.join(outputRoot, "experiment.json"), prettyCanonicalJson(experiment));
await writeFile(path.join(outputRoot, "experiment-comparison.md"), experiment.payload.comparison_md);

console.log(outputRoot);
