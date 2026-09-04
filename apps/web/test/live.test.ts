import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assignUpload,
  companySummary,
  decideRun,
  enqueueRun,
  receiveUpload,
} from "../lib/bergbok/application.ts";
import { createDatabase } from "../lib/bergbok/database.ts";
import { claimJob, processJob } from "../worker/bookkeeping-worker.ts";

const enabled = process.env.RUN_LIVE_AI === "1";
const fixtureRoot = path.resolve("../../modules/bookkeeping/demo/fixtures/fiktiv-ab");
const session = {
  sessionId: "b".repeat(48),
  userId: "live-owner",
  email: process.env.BERGBOK_OWNER_EMAIL ?? "owner@example.se",
  expiresAt: Date.now() + 60_000,
};

test("live Fiktiv AB files reach approved State in period order", { skip: !enabled }, async () => {
  assert.ok(process.env.OPENAI_API_KEY, "OPENAI_API_KEY krävs för liveprovet");
  const root = await mkdtemp(path.join(os.tmpdir(), "bergbok-live-test-"));
  process.env.BERGBOK_DATA_ROOT = root;
  process.env.BERGBOK_OWNER_EMAIL = session.email;
  try {
    const database = createDatabase(":memory:");
    for (const periodId of ["Start", "2026-05", "2026-06"]) {
      const directory = path.join(fixtureRoot, periodId);
      const filenames = (await readdir(directory)).sort();
      for (const filename of filenames) {
        const mediaType = filename.endsWith(".pdf") ? "application/pdf" : "text/markdown";
        const uploaded = await receiveUpload(
          session,
          new File([await readFile(path.join(directory, filename))], filename, { type: mediaType }),
          database,
        );
        await assignUpload(session, uploaded.id, "assign", database);
      }
      enqueueRun(session, periodId, database);
      const job = claimJob(database);
      assert.ok(job);
      const processed = await processJob(job, database);
      assert.equal(processed.outcome.kind, "proposal", processed.outcome.review?.report_markdown);
      await decideRun(session, processed.runId, processed.stored.ref.sha256, "approved", database);
    }
    const summary = await companySummary(database);
    assert.deepEqual(
      summary.periods.map((period) => period.status),
      ["approved", "approved", "approved"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
