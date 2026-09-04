import { validateWorkbenchTarget, type WorkbenchTarget } from "./types.ts";

export function claimWorkbenchNavigation(
  handledToolCalls: Set<string>,
  toolCallId: string,
  result: unknown,
): WorkbenchTarget | null {
  if (handledToolCalls.has(toolCallId)) return null;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const target = (result as { workbench?: unknown }).workbench;
  try {
    validateWorkbenchTarget(target);
  } catch {
    return null;
  }
  handledToolCalls.add(toolCallId);
  return target;
}
