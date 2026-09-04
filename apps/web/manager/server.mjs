import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import Docker from "dockerode";

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" });
const port = Number(process.env.PORT ?? 8086);
const token = process.env.WORKSPACE_MANAGER_TOKEN?.trim();
const workerImage = process.env.CHAT_WORKER_IMAGE?.trim() || "bergbok-chat-worker:local";
const snapshotRoot = path.resolve(process.env.BERGBOK_SNAPSHOT_ROOT ?? "../../var/chat-snapshots");
const idleMs = Number(process.env.WORKSPACE_IDLE_MS ?? 60 * 60 * 1_000);
const sessionPattern = /^[a-f0-9]{48}$/;
const snapshotPattern = /^[a-f0-9]{64}$/;
const label = "se.bergbok.chat-workspace";
const lastUsed = new Map();

if (!token || token.length < 24)
  throw new Error("WORKSPACE_MANAGER_TOKEN måste vara minst 24 tecken.");
const safeEqual = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const authorized = (request) => {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") && safeEqual(value.slice(7), token);
};
const json = (response, status, body) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
};
const readJson = async (request) => {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString("utf8");
    if (body.length > 250_000) throw Object.assign(new Error("Request too large"), { status: 413 });
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
};
const assertId = (value, pattern, label) => {
  if (typeof value !== "string" || !pattern.test(value))
    throw Object.assign(new Error(`Invalid ${label}`), { status: 400 });
  return value;
};
const containerName = (sessionId) => `bergbok-chat-${sessionId}`;
const containerFor = (sessionId) => docker.getContainer(containerName(sessionId));
const inspect = async (sessionId) => {
  try {
    return await containerFor(sessionId).inspect();
  } catch (error) {
    if (error?.statusCode === 404) return undefined;
    throw error;
  }
};
const remove = async (sessionId) => {
  try {
    await containerFor(sessionId).remove({ force: true });
  } catch (error) {
    if (error?.statusCode !== 404) throw error;
  }
  lastUsed.delete(sessionId);
};

async function resolveSnapshot(snapshotId) {
  assertId(snapshotId, snapshotPattern, "snapshot id");
  const root = await realpath(snapshotRoot);
  const candidate = await realpath(path.join(root, snapshotId));
  if (!candidate.startsWith(`${root}${path.sep}`))
    throw Object.assign(new Error("Snapshot escaped root"), { status: 400 });
  await access(path.join(candidate, "manifest.json"));
  return candidate;
}

async function startWorkspace(sessionId, snapshotId) {
  assertId(sessionId, sessionPattern, "session id");
  const snapshotPath = await resolveSnapshot(snapshotId);
  const running = await inspect(sessionId);
  if (running?.State?.Running && running?.Config?.Labels?.["se.bergbok.snapshot"] === snapshotId) {
    lastUsed.set(sessionId, Date.now());
    return { workspaceId: sessionId, snapshotId, status: "ready" };
  }
  if (running) await remove(sessionId);
  const container = await docker.createContainer({
    Image: workerImage,
    name: containerName(sessionId),
    Cmd: ["sleep", "infinity"],
    User: "10001:10001",
    WorkingDir: "/workspace",
    Labels: { [label]: "1", "se.bergbok.session": sessionId, "se.bergbok.snapshot": snapshotId },
    HostConfig: {
      AutoRemove: true,
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Mounts: [
        { Type: "bind", Source: snapshotPath, Target: "/workspace/company", ReadOnly: true },
      ],
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,size=268435456,uid=10001,gid=10001,mode=1777",
        "/workspace/work": "rw,noexec,nosuid,size=268435456,uid=10001,gid=10001,mode=0700",
      },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: 128,
      Memory: 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
    },
  });
  await container.start();
  lastUsed.set(sessionId, Date.now());
  return { workspaceId: sessionId, snapshotId, status: "ready" };
}

const collect = (stream, max) => {
  let value = "";
  let truncated = false;
  stream.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    const remaining = Math.max(0, max - value.length);
    value += text.slice(0, remaining);
    truncated ||= text.length > remaining;
  });
  return () => `${value}${truncated ? "\n… output truncated\n" : ""}`;
};
async function executeOne(sessionId, command, timeoutMs, maxLength) {
  const execution = await containerFor(sessionId).exec({
    Cmd: [
      "timeout",
      "--signal=TERM",
      "--kill-after=1s",
      `${Math.ceil(timeoutMs / 1000)}s`,
      "bash",
      "-lc",
      command,
    ],
    AttachStdout: true,
    AttachStderr: true,
    User: "10001:10001",
    WorkingDir: "/workspace",
    Env: ["HOME=/workspace/work", "LANG=C.UTF-8", "PATH=/usr/local/bin:/usr/bin:/bin"],
  });
  const output = await execution.start({ hijack: true, stdin: false });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const getOut = collect(stdout, maxLength);
  const getErr = collect(stderr, maxLength);
  docker.modem.demuxStream(output, stdout, stderr);
  await new Promise((resolve, reject) => {
    output.on("end", resolve);
    output.on("error", reject);
  });
  const details = await execution.inspect();
  const exitCode = details.ExitCode ?? 1;
  return {
    stdout: getOut(),
    stderr: getErr(),
    outcome:
      exitCode === 124 || exitCode === 137 ? { type: "timeout" } : { type: "exit", exitCode },
  };
}
async function executeCommands(sessionId, body) {
  const running = await inspect(assertId(sessionId, sessionPattern, "session id"));
  if (!running?.State?.Running)
    throw Object.assign(new Error("Workspace not running"), { status: 404 });
  if (!Array.isArray(body.commands) || body.commands.length < 1 || body.commands.length > 6)
    throw Object.assign(new Error("Expected 1-6 commands"), { status: 400 });
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs ?? 15_000), 100), 30_000);
  const maxLength = Math.min(Math.max(Number(body.maxOutputLength ?? 20_000), 500), 20_000);
  const results = [];
  for (const command of body.commands) {
    if (typeof command !== "string" || command.length < 1 || command.length > 100_000)
      throw Object.assign(new Error("Invalid command"), { status: 400 });
    results.push(await executeOne(sessionId, command, timeoutMs, maxLength));
  }
  lastUsed.set(sessionId, Date.now());
  return { output: results };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, used] of lastUsed)
    if (now - used > idleMs) void remove(id).catch(() => undefined);
}, 60_000).unref();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      await docker.ping();
      return json(response, 200, { status: "ok" });
    }
    if (!authorized(request)) return json(response, 401, { error: "Unauthorized" });
    if (request.method === "POST" && url.pathname === "/v1/workspaces") {
      const body = await readJson(request);
      return json(response, 200, await startWorkspace(body.sessionId, body.snapshotId));
    }
    const match = url.pathname.match(/^\/v1\/workspaces\/([a-f0-9]{48})(?:\/(exec))?$/);
    if (match && request.method === "POST" && match[2] === "exec")
      return json(response, 200, await executeCommands(match[1], await readJson(request)));
    if (match && request.method === "DELETE" && !match[2]) {
      await remove(match[1]);
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error("[workspace-manager]", error instanceof Error ? error.message : error);
    return json(response, error?.status ?? error?.statusCode ?? 500, {
      error: error?.status || error?.statusCode ? error.message : "Internal error",
    });
  }
});
server.listen(port, "127.0.0.1", () => console.info(`[workspace-manager] listening on ${port}`));
