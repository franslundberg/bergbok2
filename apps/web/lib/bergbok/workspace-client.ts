import type { AuthenticatedSession } from "./auth-types.ts";
import { workspaceConfig } from "./config.ts";
import { materializeChatSnapshot } from "./snapshot.ts";

const managerRequest = async (route: string, init: RequestInit = {}) => {
  const config = workspaceConfig();
  const response = await fetch(`${config.url}${route}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      ...init.headers,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(35_000),
  });
  if (!response.ok) throw new Error(`Dokumentarbetsytan svarade ${response.status}.`);
  return response;
};

export const ensureWorkspace = async (session: AuthenticatedSession) => {
  const snapshot = await materializeChatSnapshot();
  const response = await managerRequest("/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ sessionId: session.sessionId, snapshotId: snapshot.snapshotId }),
  });
  return (await response.json()) as { workspaceId: string; snapshotId: string; status: "ready" };
};

export const destroyWorkspace = async (session: AuthenticatedSession) => {
  await managerRequest(`/v1/workspaces/${encodeURIComponent(session.sessionId)}`, {
    method: "DELETE",
  });
};

export const executeWorkspaceShell = async (
  session: AuthenticatedSession,
  action: { commands: string[]; timeoutMs?: number; maxOutputLength?: number },
) => {
  await ensureWorkspace(session);
  const response = await managerRequest(
    `/v1/workspaces/${encodeURIComponent(session.sessionId)}/exec`,
    {
      method: "POST",
      body: JSON.stringify({
        commands: action.commands.slice(0, 6),
        timeoutMs: Math.min(Math.max(action.timeoutMs ?? 15_000, 100), 30_000),
        maxOutputLength: Math.min(Math.max(action.maxOutputLength ?? 20_000, 500), 20_000),
      }),
    },
  );
  return await response.json();
};
