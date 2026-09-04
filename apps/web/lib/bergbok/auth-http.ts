import { NextResponse } from "next/server";
import { AUTH_COOKIE, CHALLENGE_COOKIE, SIGNUP_COOKIE, getAuthService } from "./auth.ts";
import type { AuthenticatedSession, PublicAuthState } from "./auth-types.ts";
import { appConfig } from "./config.ts";
import { getDatabase } from "./database.ts";
import {
  appendCookies,
  authCookie,
  challengeCookie,
  clearCookie,
  parseCookies,
  signupCookie,
} from "./http.ts";

export const sessionFromRequest = (request: Request, touch = false) => {
  const token = parseCookies(request).get(AUTH_COOKIE);
  return getAuthService().getSession(token, touch);
};

export const loginResponse = async (session: { token: string; sessionId: string }) => {
  const response = NextResponse.json({ ok: true });
  return appendCookies(response, [
    authCookie(session.token),
    clearCookie(CHALLENGE_COOKIE),
    clearCookie(SIGNUP_COOKIE),
  ]);
};

export const publicAuthState = (request: Request): PublicAuthState => {
  const cookies = parseCookies(request);
  const service = getAuthService();
  const session = service.getSession(cookies.get(AUTH_COOKIE), true);
  if (session) {
    const membership = getDatabase()
      .prepare(
        "SELECT role,can_approve FROM company_memberships WHERE company_id='fiktiv-ab' AND user_id=?",
      )
      .get(session.userId) as { role: string; can_approve: number } | undefined;
    if (
      session.email.toLowerCase() === appConfig().ownerEmail &&
      membership?.role === "owner" &&
      membership.can_approve === 1
    )
      return {
        stage: "authenticated",
        email: session.email,
        company: { id: "fiktiv-ab", name: "Fiktiv AB", role: "owner", canApprove: true },
      };
  }
  const pending = service.getPendingSignup(cookies.get(SIGNUP_COOKIE));
  if (pending) return { stage: "set_password", emailHint: maskEmail(pending.email) };
  const challenge = service.getChallenge(cookies.get(CHALLENGE_COOKIE));
  if (challenge && challenge.expires_at > Date.now() && challenge.consumed_at === null) {
    return { stage: "code", emailHint: maskEmail(challenge.email) };
  }
  return { stage: "signed_out" };
};

export const maskEmail = (email: string) => {
  const [local, domain] = email.split("@");
  const visible = local ? local.slice(0, Math.min(2, local.length)) : "";
  return `${visible}${"•".repeat(Math.max(3, (local?.length ?? 0) - visible.length))}@${domain ?? ""}`;
};

export const challengeStartedResponse = (challengeToken: string | null) => {
  const response = NextResponse.json({
    ok: true,
    message: "Om adressen kan ta emot e-post har en kod skickats.",
  });
  return challengeToken
    ? appendCookies(response, [challengeCookie(challengeToken), clearCookie(SIGNUP_COOKIE)])
    : appendCookies(response, [clearCookie(CHALLENGE_COOKIE), clearCookie(SIGNUP_COOKIE)]);
};

export const signupPendingResponse = (signupToken: string) =>
  appendCookies(NextResponse.json({ ok: true, next: "set_password" }), [
    signupCookie(signupToken),
    clearCookie(CHALLENGE_COOKIE),
  ]);

export const requireSession = (request: Request): AuthenticatedSession => {
  const session = sessionFromRequest(request, true);
  if (!session) throw Object.assign(new Error("Du måste logga in."), { status: 401 });
  return session;
};

export const requireOwner = (request: Request): AuthenticatedSession => {
  const session = requireSession(request);
  const membership = getDatabase()
    .prepare(
      "SELECT role,can_approve FROM company_memberships WHERE company_id='fiktiv-ab' AND user_id=?",
    )
    .get(session.userId) as { role: string; can_approve: number } | undefined;
  if (
    session.email.toLowerCase() !== appConfig().ownerEmail ||
    !membership ||
    membership.role !== "owner"
  ) {
    throw Object.assign(new Error("Du saknar behörighet till Fiktiv AB."), { status: 403 });
  }
  return session;
};

export const requireApprover = (request: Request): AuthenticatedSession => {
  const session = requireOwner(request);
  const membership = getDatabase()
    .prepare(
      "SELECT can_approve FROM company_memberships WHERE company_id='fiktiv-ab' AND user_id=?",
    )
    .get(session.userId) as { can_approve: number } | undefined;
  if (membership?.can_approve !== 1)
    throw Object.assign(new Error("Du saknar behörighet att godkänna."), { status: 403 });
  return session;
};
