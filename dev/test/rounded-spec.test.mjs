import assert from "node:assert/strict";
import { once } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import { createDurationFormatter } from "../rounded-spec-reporter.mjs";

async function format(chunks) {
  const formatter = Readable.from(chunks).pipe(createDurationFormatter());
  const output = [];
  formatter.on("data", (chunk) => output.push(chunk.toString()));
  await once(formatter, "end");
  return output.join("");
}

test("test and summary durations use exactly one decimal", async () => {
  const output = await format([
    "✔ sub-millisecond (0.364833ms)\n",
    "✔ integer (2ms)\n",
    "✔ multi-digit (101.288417ms)\n",
    "ℹ duration_ms 107.4321\n",
  ]);

  assert.match(output, /✔ sub-millisecond \(0\.4ms\)/);
  assert.match(output, /✔ integer \(2\.0ms\)/);
  assert.match(output, /✔ multi-digit \(101\.3ms\)/);
  assert.match(output, /ℹ duration_ms 107\.4/);
  assert.doesNotMatch(output, /\d+\.\d{2,}ms/);
});

test("formatting preserves diagnostics and handles split chunks", async () => {
  const output = await format([
    "not a test result (1.970291ms)\n",
    "\u001b[32m✔ colored (1.970291ms)\u001b[39m\nℹ duration_ms ",
    "22.087667\n",
  ]);

  assert.match(output, /not a test result \(1\.970291ms\)/);
  assert.match(output, /\u001b\[32m✔ colored \(2\.0ms\)\u001b\[39m/);
  assert.match(output, /ℹ duration_ms 22\.1/);
});
