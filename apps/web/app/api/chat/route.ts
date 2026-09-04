import { openai } from "@ai-sdk/openai";
import { randomUUID } from "node:crypto";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { sessionFromRequest } from "@/lib/bergbok/auth-http";
import { containsCredentialLikeInput } from "@/lib/bergbok/chat-policy";
import { buildModelRequest } from "@/lib/bergbok/chat-request";
import { modelConfig } from "@/lib/bergbok/config";
import { ensureWorkspace, executeWorkspaceShell } from "@/lib/bergbok/workspace-client";
import { appendChatMessage, appendEvent } from "@/lib/bergbok/application";
import {
  activeToolsForStep,
  buildChatApplicationContext,
  createApplicationTools,
  isDirectBookkeepingCommand,
} from "@/lib/bergbok/chat-tools";
import { assertSameOrigin, jsonBody } from "@/lib/bergbok/http";
import { parseWorkbenchTarget } from "@/lib/bergbok/types";

export async function POST(request: Request) {
  assertSameOrigin(request);
  const body = (await jsonBody(request)) as { messages?: UIMessage[]; uiContext?: unknown };
  if (!Array.isArray(body.messages) || body.messages.length > 500) {
    return Response.json({ error: "Ogiltigt meddelandeformat." }, { status: 400 });
  }
  const messages = body.messages.slice(-100);
  let uiContext = null;
  try {
    uiContext = parseWorkbenchTarget(body.uiContext);
  } catch {
    return Response.json({ error: "Ogiltigt arbetsytesammanhang." }, { status: 400 });
  }

  const session = sessionFromRequest(request, true);
  if (!session && containsCredentialLikeInput(messages)) {
    return Response.json(
      { error: "Använd det säkra inloggningskortet för e-post, kod och lösenord." },
      { status: 422 },
    );
  }

  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const userText =
    lastUser?.parts
      ?.filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n") ?? "";
  if (session && lastUser && userText)
    appendChatMessage("user", lastUser.id, userText, session.userId);

  if (!process.env.OPENAI_API_KEY) {
    if (session) appendEvent("chat_failure", "bergbok-chat", { message: "OPENAI_API_KEY saknas." });
    return Response.json({ error: "OPENAI_API_KEY saknas." }, { status: 500 });
  }

  if (session) {
    try {
      await ensureWorkspace(session);
    } catch {
      appendEvent("chat_failure", "bergbok-chat", {
        message: "Dokumentarbetsytan kunde inte starta.",
      });
      return Response.json(
        { error: "Dokumentarbetsytan kunde inte starta. Försök igen." },
        { status: 503 },
      );
    }
  }

  const shellTool = session
    ? openai.tools.shell({
        execute: async ({ action }) => executeWorkspaceShell(session, action),
      })
    : undefined;
  const applicationTools = session ? createApplicationTools(session, uiContext) : undefined;
  const applicationContext = session ? await buildChatApplicationContext(uiContext) : undefined;
  const tools = session
    ? { ...(shellTool ? { shell: shellTool } : {}), ...applicationTools }
    : undefined;
  const config = modelConfig();
  const forceBookkeepingTool = Boolean(session && isDirectBookkeepingCommand(userText));
  const result = streamText({
    ...buildModelRequest({
      model: openai.responses(config.model),
      messages: await convertToModelMessages(messages),
      authenticated: Boolean(session),
      tools,
      applicationContext,
      reasoningEffort: config.reasoningEffort,
    }),
    ...(session
      ? {
          prepareStep: ({ stepNumber }) => ({
            activeTools: activeToolsForStep(stepNumber),
            ...(stepNumber === 0 && forceBookkeepingTool
              ? {
                  toolChoice: {
                    type: "tool" as const,
                    toolName: "start_bookkeeping" as const,
                  },
                }
              : {}),
          }),
        }
      : {}),
    onFinish: ({ text }) => {
      if (session && text) appendChatMessage("assistant", randomUUID(), text, "bergbok-chat");
    },
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
    sendSources: true,
    onError: (error) => {
      console.error("[bergbok-chat]", error instanceof Error ? error.message : error);
      const message = "Assistentens svar misslyckades. Försök igen.";
      if (session) appendEvent("chat_failure", "bergbok-chat", { message });
      return message;
    },
  });
}
