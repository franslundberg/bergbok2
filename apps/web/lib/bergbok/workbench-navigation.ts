import { validateWorkContext, type WorkContext } from "./types.ts";

export function claimWorkContextNavigation(
  handledToolCalls: Set<string>,
  toolCallId: string,
  result: unknown,
): WorkContext | null {
  if (handledToolCalls.has(toolCallId)) return null;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const target = (result as { workContext?: unknown }).workContext;
  try {
    validateWorkContext(target);
  } catch {
    return null;
  }
  handledToolCalls.add(toolCallId);
  return target;
}
