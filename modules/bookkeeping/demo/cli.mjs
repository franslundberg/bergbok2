#!/usr/bin/env node

import { approve, beginImport, run, setup, start, status } from "./workflow.mjs";

const HELP = `Bergbok AI Bookkeeping demo

Usage:
  npm run demo:bookkeeping -- setup
  npm run demo:bookkeeping
  npm run demo:bookkeeping -- start [--start-date YYYY-MM-DD] [--docset DIR] [--output DIR]
  npm run demo:bookkeeping -- import --start-date YYYY-MM-DD --docset DIR [--output DIR]
  npm run demo:bookkeeping -- run --workspace DIR --period ID [--period-start YYYY-MM-DD --period-end YYYY-MM-DD] [--docset DIR]
  npm run demo:bookkeeping -- approve --workspace DIR --run RUN_ID [--actor NAME]
  npm run demo:bookkeeping -- status --workspace DIR

Options:
  --model gpt-5.6-luna   Default, high reasoning
  --model gpt-5.6-sol    Stronger production-oriented option, high reasoning
  --actor NAME           Approver; default: Filippa Stark
  --allow-web            Enable filtered public egress for the document worker

Without arguments, a new Fiktiv AB workspace is created with Uppstart, 2026-05,
2026-06, 2026-07, and 2026-08 Documents, and only Uppstart is run. Fixture
periods use their stored dates, so ordinary fixture runs need only --period.
Approval is always separate.
`;

function parse(argv) {
  const args = [...argv];
  const command = args[0]?.startsWith("-") ? "start" : (args.shift() ?? "start");
  const options = {};
  while (args.length) {
    const name = args.shift();
    if (name === "--allow-web") { options.allowWeb = true; continue; }
    const value = args.shift();
    if (!value) throw new Error(`${name} requires a value`);
    if (name === "--workspace") options.workspace = value;
    else if (name === "--output") options.output = value;
    else if (name === "--start-date") options.startDate = value;
    else if (name === "--period-start") options.periodStart = value;
    else if (name === "--period-end") options.periodEnd = value;
    else if (name === "--docset") options.docset = value;
    else if (name === "--period") options.period = value;
    else if (name === "--run") options.run = value;
    else if (name === "--actor") options.actor = value;
    else if (name === "--model") options.model = value;
    else if (name === "--company-id") options.companyId = value;
    else throw new Error(`Unknown option ${name}`);
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (["help", "--help", "-h"].includes(argv[0])) { console.log(HELP); return 0; }
    const { command, options } = parse(argv);
    if (command === "setup") await setup();
    else if (command === "start") await start(options);
    else if (command === "import") await beginImport(options);
    else if (command === "run") await run(options);
    else if (command === "approve") await approve(options);
    else if (command === "status") await status(options);
    else throw new Error(`Unknown command ${command}`);
    return 0;
  } catch (error) {
    console.error(`bookkeeping demo: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) process.exitCode = await main();
