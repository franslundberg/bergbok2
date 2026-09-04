import { NextResponse } from "next/server";
export * from "./request-security.ts";

export const jsonBody = async (request: Request) => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type måste vara application/json."), { status: 415 });
  }
  return (await request.json()) as Record<string, unknown>;
};

export const errorResponse = (error: unknown) => {
  const status =
    typeof error === "object" && error && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
  const message =
    status >= 500
      ? "Tjänsten kunde inte slutföra begäran. Försök igen."
      : error instanceof Error
        ? error.message
        : "Begäran kunde inte slutföras.";
  if (status >= 500) console.error("[bergbok-api]", error instanceof Error ? error.message : error);
  return NextResponse.json({ error: message }, { status });
};

export const appendCookies = (response: Response, values: string[]) => {
  for (const value of values) response.headers.append("Set-Cookie", value);
  return response;
};
