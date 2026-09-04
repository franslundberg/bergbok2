export function renderComparison(evaluation) {
  const status = evaluation.passed ? "PASS" : "FAIL";
  const lines = [
    `# Evaluation: ${evaluation.case_id}`,
    "",
    `**Result:** ${status}`,
    "",
    `Candidate: \`${evaluation.candidate_sha256}\``,
    "",
    "## Deterministic checks",
    "",
    "| Check | Result | Detail |",
    "|---|---:|---|",
    ...evaluation.deterministic_checks.map((item) =>
      `| ${escapeCell(item.id)} | ${item.passed ? "PASS" : "FAIL"} | ${escapeCell(item.detail)} |`,
    ),
    "",
    "## Semantic findings",
    "",
    ...(evaluation.semantic_findings.length === 0
      ? ["No semantic differences outside the Grading Manual were found."]
      : evaluation.semantic_findings.map((item) => `- **${item.severity.toUpperCase()} ${escapeInline(item.id)}:** ${item.detail}`)),
    "",
    "## Economic comparison",
    "",
    "| Account or allowed group | Reference | Candidate | Difference |",
    "|---|---:|---:|---:|",
    ...evaluation.account_comparison.map((row) =>
      `| ${escapeCell(row.account)} | ${row.expected_net} | ${row.candidate_net} | ${row.difference} |`,
    ),
    "",
    "The reference was supplied only to Evaluation Lab, after candidate generation.",
    "",
  ];
  return lines.join("\n");
}

export function renderExperiment(experiment) {
  return [
    `# Experiment: ${experiment.plan_id}`,
    "",
    `Case: \`${experiment.case_id}\``,
    "",
    "| Variant | Trials | Passed | Pass rate | Mean cost, USD | Mean time, ms | Mean steps |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...experiment.variants.map((variant) =>
      `| ${escapeCell(variant.variant_id)} | ${variant.trials} | ${variant.passed} | ${formatRate(variant.pass_rate)} | ${formatUsd(variant.mean_cost_usd_micros)} | ${formatNumber(variant.mean_duration_ms)} | ${formatNumber(variant.mean_steps)} |`,
    ),
    "",
    `Trial count and pass rule come from grading profile \`${experiment.grading_profile.id}@${experiment.grading_profile.version}\`; no global repetition count is assumed.`,
    "",
  ].join("\n");
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function escapeInline(value) {
  return String(value).replaceAll("*", "\\*");
}

function formatRate(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(micros) {
  return (micros / 1_000_000).toFixed(4);
}

function formatNumber(value) {
  return Number(value.toFixed(1)).toString();
}
