import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { materializeChatSnapshot } from "../lib/bergbok/snapshot.ts";

const enabled = process.env.RUN_DOCKER_TESTS === "1";

test(
  "chat container sees only a read-only snapshot, writable tmpfs and no network",
  {
    skip: !enabled,
  },
  async (context) => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "bergbok-docker-test-"));
    process.env.BERGBOK_DATA_ROOT = dataRoot;
    process.env.BERGBOK_OWNER_EMAIL = "owner@example.se";
    const snapshot = await materializeChatSnapshot();
    const port = 18_000 + Math.floor(Math.random() * 1_000);
    const token = randomBytes(32).toString("hex");
    const sessionId = randomBytes(24).toString("hex");
    const manager = spawn(process.execPath, ["server.mjs"], {
      cwd: path.resolve("manager"),
      env: {
        ...process.env,
        PORT: String(port),
        WORKSPACE_MANAGER_TOKEN: token,
        BERGBOK_SNAPSHOT_ROOT: path.join(dataRoot, "chat-snapshots"),
        CHAT_WORKER_IMAGE: "bergbok-chat-worker:local",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    context.after(async () => {
      await fetch(`http://127.0.0.1:${port}/v1/workspaces/${sessionId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => undefined);
      manager.kill("SIGTERM");
      await Promise.race([
        once(manager, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      await rm(dataRoot, { recursive: true, force: true });
    });

    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
      if (response?.ok) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) {
      const stderr = manager.stderr.read()?.toString("utf8") ?? "";
      assert.fail(`Workspace manager startade inte: ${stderr}`);
    }

    const start = await fetch(`http://127.0.0.1:${port}/v1/workspaces`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, snapshotId: snapshot.snapshotId }),
    });
    assert.equal(start.status, 200);

    const execution = await fetch(`http://127.0.0.1:${port}/v1/workspaces/${sessionId}/exec`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        commands: [
          "test ! -w /workspace/company",
          "touch /workspace/company/probe",
          "touch /workspace/work/probe && test -f /workspace/work/probe",
          "curl --silent --show-error --max-time 2 https://example.com",
          "test ! -e /workspace/company/../../apps && test ! -e /workspace/company/../../var/app.sqlite",
        ],
        timeoutMs: 5_000,
        maxOutputLength: 2_000,
      }),
    });
    assert.equal(execution.status, 200);
    const body = (await execution.json()) as {
      output: Array<{ outcome: { type: string; exitCode?: number } }>;
    };
    const exitCodes = body.output.map((result) => result.outcome.exitCode);
    assert.equal(exitCodes[0], 0);
    assert.notEqual(exitCodes[1], 0);
    assert.equal(exitCodes[2], 0);
    assert.notEqual(exitCodes[3], 0);
    assert.equal(exitCodes[4], 0);
  },
);
