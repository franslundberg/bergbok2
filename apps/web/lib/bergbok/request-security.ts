import {
  AUTH_COOKIE,
  CHALLENGE_COOKIE,
  PIN_TTL_MS,
  SESSION_TTL_MS,
  SIGNUP_COOKIE,
} from "./auth.ts";

export const parseCookies = (request: Request) => {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // Ignore malformed cookies.
    }
  }
  return cookies;
};

const cookie = (name: string, value: string, maxAge: number) => {
  const secure = process.env.BERGBOK_SECURE_COOKIES === "true" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge / 1_000))}${secure}`;
};

export const authCookie = (token: string) => cookie(AUTH_COOKIE, token, SESSION_TTL_MS);
export const challengeCookie = (token: string) => cookie(CHALLENGE_COOKIE, token, PIN_TTL_MS);
export const signupCookie = (token: string) => cookie(SIGNUP_COOKIE, token, PIN_TTL_MS);
export const clearCookie = (name: string) => cookie(name, "", 0);

export const assertSameOrigin = (request: Request) => {
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol ? `${forwardedProtocol}:` : requestUrl.protocol;
  const host = request.headers.get("host")?.trim() || requestUrl.host;
  const expected = `${protocol}//${host}`;
  if (!origin || origin !== expected) {
    throw Object.assign(new Error("Begäran kommer från fel origin."), { status: 403 });
  }
};

export const remoteAddress = (request: Request) =>
  request.headers.get("x-real-ip")?.trim() ||
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  "local";
