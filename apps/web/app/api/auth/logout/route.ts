import { NextResponse } from "next/server";
import { AUTH_COOKIE, CHALLENGE_COOKIE, SIGNUP_COOKIE, getAuthService } from "@/lib/bergbok/auth";
import {
  appendCookies,
  assertSameOrigin,
  clearCookie,
  errorResponse,
  parseCookies,
} from "@/lib/bergbok/http";
import { destroyWorkspace } from "@/lib/bergbok/workspace-client";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const service = getAuthService();
    const session = service.deleteSession(parseCookies(request).get(AUTH_COOKIE));
    if (session) await destroyWorkspace(session).catch(() => undefined);
    return appendCookies(NextResponse.json({ ok: true }), [
      clearCookie(AUTH_COOKIE),
      clearCookie(CHALLENGE_COOKIE),
      clearCookie(SIGNUP_COOKIE),
    ]);
  } catch (error) {
    return errorResponse(error);
  }
}
