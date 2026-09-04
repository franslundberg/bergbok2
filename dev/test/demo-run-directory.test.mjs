import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";

import { allocateRunDirectory } from "../demo-run-directory.mjs";

const TEST_ROOT = path.resolve("dev/test/.tmp/demo-runs");

after(() => rm(TEST_ROOT, { recursive: true, force: true }));

test("demo run directories begin at run-001 and allocate atomically", async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  const allocated = await Promise.all([
    allocateRunDirectory(TEST_ROOT),
    allocateRunDirectory(TEST_ROOT),
    allocateRunDirectory(TEST_ROOT),
  ]);
  assert.deepEqual(allocated.map((directory) => path.basename(directory)).sort(), [
    "run-001",
    "run-002",
    "run-003",
  ]);
  assert.equal(path.basename(await allocateRunDirectory(TEST_ROOT)), "run-004");
});
