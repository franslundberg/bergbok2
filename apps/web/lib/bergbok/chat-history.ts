import { Bookkeeping } from "@bergbok/modular-system";
import type { UIMessage } from "ai";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function messagesForNewClaims(messages: UIMessage[]): UIMessage[] {
  return messages
    .map((message) =>
      message.role === "assistant"
        ? {
            id: message.id,
            role: message.role,
            // Treat prior assistant output as plain quoted history. Reusing a
            // Responses itemId without its discarded reasoning item makes the
            // next stateless request invalid, and persisted tool output must
            // never become authority for a new financial claim.
            parts: message.parts.flatMap((part) =>
              part.type === "text" ? [{ type: "text" as const, text: part.text }] : [],
            ),
          }
        : message,
    )
    .filter((message) => message.role !== "assistant" || message.parts.length > 0);
}

export function sanitizeAssistantParts(parts: readonly unknown[]) {
  const sanitized: JsonObject[] = [];
  for (const part of parts) {
    if (!isObject(part)) continue;
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      sanitized.push({ type: "text", text: part.text });
      continue;
    }
    if (
      part.type !== "tool-get_result_report" ||
      part.state !== "output-available" ||
      typeof part.toolCallId !== "string" ||
      !isObject(part.output) ||
      !isObject(part.output.report)
    ) {
      continue;
    }
    try {
      Bookkeeping.assertResultReport(part.output.report);
      sanitized.push({
        type: "tool-get_result_report",
        toolCallId: part.toolCallId,
        state: "output-available",
        input: isObject(part.input) ? structuredClone(part.input) : {},
        output: {
          ok: true,
          message:
            typeof part.output.message === "string"
              ? part.output.message
              : "Resultatrapporten är beräknad från godkänd bokföring.",
          report: structuredClone(part.output.report),
        },
      });
    } catch {
      // Invalid financial models are never persisted.
    }
  }
  return {
    parts: sanitized,
    text: sanitized
      .filter((part) => part.type === "text")
      .map((part) => String(part.text))
      .join("\n")
      .trim(),
  };
}

export function renderableAssistantParts(parts: unknown) {
  if (!Array.isArray(parts)) return null;
  return parts.flatMap((part): JsonObject[] => {
    if (!isObject(part)) return [];
    if (part.type === "text" && typeof part.text === "string") {
      return [{ type: "text", text: part.text }];
    }
    if (
      part.type !== "tool-get_result_report" ||
      typeof part.toolCallId !== "string" ||
      part.state !== "output-available"
    ) {
      return [];
    }
    try {
      if (!isObject(part.output) || !isObject(part.output.report))
        throw new Error("missing report");
      Bookkeeping.assertResultReport(part.output.report);
      return [structuredClone(part)];
    } catch {
      return [
        {
          type: "tool-get_result_report",
          toolCallId: part.toolCallId,
          state: "output-available",
          input: {},
          output: {
            ok: false,
            unavailable: true,
            message: "Den sparade resultatrapporten kunde inte verifieras.",
          },
        },
      ];
    }
  });
}
