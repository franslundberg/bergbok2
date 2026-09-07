#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { approve, run, start } from "./workflow.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERIODS_FILE = path.join(HERE, "fixtures", "fiktiv-ab", "periods.json");
const DEFAULT_MODEL = "gpt-5.6-luna";

const HELP = `Run the Fiktiv AB Bookkeeping demo through every fixture period.

Usage:
  npm run demo:bookkeeping:complete
  npm run demo:bookkeeping:complete -- --model gpt-5.6-luna
  npm run demo:bookkeeping:complete -- --output DIR --actor NAME --allow-web

The command creates a fresh workspace, runs periods in catalog order, approves
each complete proposal, and continues to the next period. It stops without
approving when a period returns needs_input, out_of_scope, or another failure.
`;

function parse(argv) {
  const options = { model: DEFAULT_MODEL };
  const args = [...argv];
  while (args.length) {
    const name = args.shift();
    if (name === "--help" || name === "-h") return { help: true };
    if (name === "--allow-web") {
      options.allowWeb = true;
      continue;
    }
    const value = args.shift();
    if (!value) throw new Error(`${name} requires a value`);
    if (name === "--model") options.model = value;
    else if (name === "--output") options.output = value;
    else if (name === "--actor") options.actor = value;
    else throw new Error(`Unknown option ${name}`);
  }
  return { options };
}

async function fixturePeriods() {
  const catalog = JSON.parse(await readFile(PERIODS_FILE, "utf8"));
  if (catalog.schema_version !== "1.0" || !Array.isArray(catalog.periods) || !catalog.periods.length) {
    throw new Error(`Invalid fixture period catalog: ${PERIODS_FILE}`);
  }
  return catalog.periods;
}

function assertCompleteProposal(result, periodId) {
  if (result?.outcome?.kind !== "proposal") {
    throw new Error(`Period ${periodId} returned ${result?.outcome?.kind ?? "no outcome"}; stopped without approval`);
  }
  if (!result.runId) throw new Error(`Period ${periodId} returned a proposal without a run ID`);
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parse(argv);
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }

  const { options } = parsed;
  const periods = await fixturePeriods();
  const first = periods[0];
  const created = await start(options);
  assertCompleteProposal(created, first.id);
  await approve({ workspace: created.workspaceRoot, run: created.runId, actor: options.actor });
  console.log(`[complete] approved ${first.id}`);

  for (const period of periods.slice(1)) {
    const result = await run({
      workspace: created.workspaceRoot,
      period: period.id,
      model: options.model,
      allowWeb: options.allowWeb,
    });
    assertCompleteProposal(result, period.id);
    await approve({ workspace: created.workspaceRoot, run: result.runId, actor: options.actor });
    console.log(`[complete] approved ${period.id}`);
  }

  console.log(`[complete] workspace=${created.workspaceRoot}`);
  return 0;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`bookkeeping complete demo: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
