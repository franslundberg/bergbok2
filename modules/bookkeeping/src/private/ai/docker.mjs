import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  EGRESS_IMAGE,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_TOOL_TIMEOUT_MS,
  WORKER_IMAGE,
} from "./constants.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

async function docker(args, options = {}) {
  const result = await execFileAsync("docker", args, {
    shell: false,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 2_000_000,
    cwd: options.cwd,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function boundedDocker(args, timeoutMs, maxOutputChars) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let hostTimedOut = false;
    const append = (current, chunk, mark) => {
      const value = chunk.toString("utf8");
      const remaining = Math.max(0, maxOutputChars - current.length);
      if (value.length > remaining) mark();
      return current + value.slice(0, remaining);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, () => { stdoutTruncated = true; }); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, () => { stderrTruncated = true; }); });
    const timer = setTimeout(() => {
      hostTimedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs + 5_000);
    child.on("error", (error) => {
      stderr = append(stderr, Buffer.from(error.message), () => { stderrTruncated = true; });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exit_code: exitCode, signal, host_timed_out: hostTimedOut, stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated });
    });
  });
}

export async function setupImages({ log = console.log } = {}) {
  await docker(["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
  log(`[setup] building ${WORKER_IMAGE}`);
  await docker(["build", "-t", WORKER_IMAGE, "-f", "modules/bookkeeping/runtime/Dockerfile.worker", "."], {
    cwd: REPOSITORY_ROOT,
    timeout: 15 * 60_000,
    maxBuffer: 5_000_000,
  });
  log(`[setup] building ${EGRESS_IMAGE}`);
  await docker(["build", "-t", EGRESS_IMAGE, "-f", "modules/bookkeeping/runtime/Dockerfile.egress", "."], {
    cwd: REPOSITORY_ROOT,
    timeout: 10 * 60_000,
    maxBuffer: 5_000_000,
  });
  return inspectImages();
}

export async function inspectImages() {
  try {
    const [worker, egress] = await Promise.all([
      docker(["image", "inspect", "--format", "{{.Id}}", WORKER_IMAGE]),
      docker(["image", "inspect", "--format", "{{.Id}}", EGRESS_IMAGE]),
    ]);
    return { worker: worker.stdout.trim(), egress: egress.stdout.trim() };
  } catch {
    throw new Error("Bookkeeping Docker images are missing. Run 'npm run demo:bookkeeping -- setup' first.");
  }
}

function safeName(runId) {
  const value = runId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  if (!/^[a-z0-9][a-z0-9_.-]{5,80}$/.test(value)) throw new Error("Unsafe Docker run ID");
  return value;
}

async function waitForProxy(container) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await docker(["exec", container, "node", "-e", "fetch('http://127.0.0.1:3128/health').then(r=>{if(!r.ok)process.exit(1)})"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Bookkeeping egress proxy did not become ready");
}

export async function startWorkspace({ runId, docsetPath, contextPath, allowWeb = false }) {
  const safeId = safeName(runId);
  const worker = `bergbok-bk-worker-${safeId}`;
  const proxy = `bergbok-bk-proxy-${safeId}`;
  const outbound = `bergbok-bk-out-${safeId}`;
  const internal = `bergbok-bk-in-${safeId}`;
  const startedAt = Date.now();
  const cleanup = async () => {
    await docker(["rm", "-f", worker], { timeout: 10_000 }).catch(() => undefined);
    if (allowWeb) {
      await docker(["rm", "-f", proxy], { timeout: 10_000 }).catch(() => undefined);
      await docker(["network", "rm", internal], { timeout: 10_000 }).catch(() => undefined);
      await docker(["network", "rm", outbound], { timeout: 10_000 }).catch(() => undefined);
    }
  };
  try {
    const networkArgs = ["--network", "none"];
    const proxyEnvironment = [];
    if (allowWeb) {
      await docker(["network", "create", "--label", "se.bergbok.bookkeeping=1", outbound]);
      await docker(["network", "create", "--internal", "--label", "se.bergbok.bookkeeping=1", internal]);
      await docker([
        "run", "-d", "--rm", "--name", proxy, "--network", outbound,
        "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m,uid=10002,gid=10002,mode=1777",
        "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit", "64", "--memory", "256m", "--cpus", "0.5",
        EGRESS_IMAGE,
      ]);
      await docker(["network", "connect", "--alias", "egress-proxy", internal, proxy]);
      await waitForProxy(proxy);
      networkArgs.splice(0, networkArgs.length, "--network", internal);
      proxyEnvironment.push(
        "-e", "HTTP_PROXY=http://egress-proxy:3128",
        "-e", "HTTPS_PROXY=http://egress-proxy:3128",
        "-e", "http_proxy=http://egress-proxy:3128",
        "-e", "https_proxy=http://egress-proxy:3128",
        "-e", "NO_PROXY=localhost,127.0.0.1",
      );
    }
    await docker([
      "run", "-d", "--rm", "--name", worker, ...networkArgs,
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,uid=10001,gid=10001,mode=1777",
      "--tmpfs", "/workspace/work:rw,noexec,nosuid,size=512m,uid=10001,gid=10001,mode=0700",
      "--tmpfs", "/workspace/output:rw,noexec,nosuid,size=32m,uid=10001,gid=10001,mode=0700",
      "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit", "128", "--memory", "1g", "--cpus", "2",
      "--user", "10001:10001", "--workdir", "/workspace",
      "--mount", `type=bind,src=${path.resolve(docsetPath)},dst=/workspace/input,readonly`,
      "--mount", `type=bind,src=${path.resolve(contextPath)},dst=/workspace/context,readonly`,
      ...proxyEnvironment,
      WORKER_IMAGE,
    ]);
    await docker(["exec", worker, "true"]);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    worker,
    startup_ms: Date.now() - startedAt,
    network: allowWeb ? "public_only_proxy" : "none",
    async executeShell({ command, timeout_ms = 30_000, max_output_chars = 20_000 }) {
      if (typeof command !== "string" || command.length < 1 || command.length > 100_000) throw new Error("Shell command must contain 1-100000 characters");
      const timeoutMs = Math.min(Math.max(Number(timeout_ms), 100), MAX_TOOL_TIMEOUT_MS);
      const maxChars = Math.min(Math.max(Number(max_output_chars), 1_000), MAX_TOOL_OUTPUT_CHARS);
      const result = await boundedDocker([
        "exec", "-e", "HOME=/workspace/work", "-e", "LANG=C.UTF-8", "-e", "PATH=/usr/local/bin:/usr/bin:/bin",
        "-w", "/workspace", worker, "timeout", "--signal=TERM", "--kill-after=2s", `${Math.ceil(timeoutMs / 1_000)}s`,
        "bash", "-lc", command,
      ], timeoutMs, maxChars);
      return { ...result, timed_out: result.host_timed_out || [124, 137].includes(result.exit_code) };
    },
    async readCandidate() {
      return (await docker(["exec", worker, "cat", "--", "/workspace/output/candidate.json"], { timeout: 10_000 })).stdout;
    },
    async listOutputFiles() {
      const result = await docker(["exec", worker, "find", "/workspace/output", "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\n"]);
      return result.stdout.split("\n").filter(Boolean).sort();
    },
    cleanup,
  };
}
