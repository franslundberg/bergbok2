import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./auth-constraints.ts";
import type { BergbokDatabase } from "./database.ts";
import { getDatabase } from "./database.ts";
import type { SendPin } from "./email.ts";
import { sendPinEmail } from "./email.ts";
import type { AuthenticatedSession } from "./auth-types.ts";
import { authConfig as authConfiguration } from "./config.ts";

const scrypt = (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
export const AUTH_COOKIE = "bergbok_session";
export const CHALLENGE_COOKIE = "bergbok_challenge";
export const SIGNUP_COOKIE = "bergbok_signup";
export const PIN_TTL_MS = 10 * 60 * 1_000;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
export const MAX_PIN_ATTEMPTS = 5;
const RATE_WINDOW_MS = 15 * 60 * 1_000;
const MAX_SENDS_PER_WINDOW = 3;
const RESEND_DELAY_MS = 60 * 1_000;

type AuthServiceOptions = {
  database: BergbokDatabase;
  pepper: string;
  sessionSecret: string;
  sendPin: SendPin;
  ownerEmail?: string;
  now?: () => number;
};

type ChallengeRow = {
  id: string;
  email: string;
  code_digest: string;
  expires_at: number;
  attempts: number;
  consumed_at: number | null;
  verified_at: number | null;
  user_id: string | null;
  signup_token_digest: string | null;
  created_at: number;
};

type SessionRow = {
  id: string;
  user_id: string;
  email: string;
  expires_at: number;
  last_used_at: number;
};

const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
const randomId = () => randomBytes(24).toString("hex");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export const normalizeEmail = (value: unknown) => {
  if (typeof value !== "string") throw new Error("Ange en giltig e-postadress.");
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    [...email].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error("Ange en giltig e-postadress.");
  }
  return email;
};

export const validatePassword = (value: unknown) => {
  if (
    typeof value !== "string" ||
    value.length < PASSWORD_MIN_LENGTH ||
    value.length > PASSWORD_MAX_LENGTH
  ) {
    throw new Error(`Lösenordet måste vara ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} tecken.`);
  }
  return value;
};

export const hashPassword = async (password: string) => {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, {
    N: 32_768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$32768$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
};

export const verifyPassword = async (password: string, encoded: string) => {
  const [algorithm, n, r, p, saltValue, expectedValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltValue || !expectedValue) return false;
  const expected = Buffer.from(expectedValue, "base64url");
  const actual = await scrypt(password, Buffer.from(saltValue, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const safeEqualText = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class AuthService {
  private readonly database: BergbokDatabase;
  private readonly pepper: string;
  private readonly sessionSecret: string;
  private readonly sendPin: SendPin;
  private readonly ownerEmail?: string;
  private readonly now: () => number;

  constructor(options: AuthServiceOptions) {
    this.database = options.database;
    this.pepper = options.pepper;
    this.sessionSecret = options.sessionSecret;
    this.sendPin = options.sendPin;
    this.ownerEmail = options.ownerEmail?.toLowerCase();
    this.now = options.now ?? Date.now;
  }

  private pinDigest(challengeId: string, pin: string) {
    return createHmac("sha256", this.pepper).update(`${challengeId}:${pin}`).digest("hex");
  }

  remoteHash(remoteAddress: string) {
    return createHmac("sha256", this.sessionSecret).update(remoteAddress).digest("hex");
  }

  accountKind(emailInput: unknown) {
    const email = normalizeEmail(emailInput);
    if (this.ownerEmail && email !== this.ownerEmail) return "new" as const;
    const user = this.database
      .prepare("SELECT password_hash FROM users WHERE email = ?")
      .get(email) as { password_hash: string | null } | undefined;
    return user?.password_hash ? ("existing" as const) : ("new" as const);
  }

  async startCode(emailInput: unknown, remoteAddress: string) {
    const email = normalizeEmail(emailInput);
    if (this.ownerEmail && email !== this.ownerEmail) {
      return { challengeToken: null, email };
    }
    const now = this.now();
    const remoteHash = this.remoteHash(remoteAddress);
    const since = now - RATE_WINDOW_MS;
    const emailRate = this.database
      .prepare(
        "SELECT COUNT(*) AS count, MAX(created_at) AS latest FROM email_challenges WHERE email = ? AND created_at >= ?",
      )
      .get(email, since) as { count: number; latest: number | null };
    const remoteRate = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM email_challenges WHERE remote_hash = ? AND created_at >= ?",
      )
      .get(remoteHash, since) as { count: number };
    if (
      emailRate.count >= MAX_SENDS_PER_WINDOW ||
      remoteRate.count >= MAX_SENDS_PER_WINDOW * 5 ||
      (emailRate.latest !== null && now - emailRate.latest < RESEND_DELAY_MS)
    ) {
      throw Object.assign(new Error("Vänta innan du begär en ny kod."), { status: 429 });
    }

    const challengeId = randomId();
    const pin = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, "0");
    this.database
      .prepare(
        `INSERT INTO email_challenges
          (id, email, remote_hash, code_digest, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(challengeId, email, remoteHash, this.pinDigest(challengeId, pin), now + PIN_TTL_MS, now);
    try {
      await this.sendPin(email, pin);
    } catch (error) {
      this.database.prepare("DELETE FROM email_challenges WHERE id = ?").run(challengeId);
      throw error;
    }
    return { challengeToken: challengeId, email };
  }

  async verifyCode(challengeToken: string | undefined, codeInput: unknown) {
    if (!challengeToken || typeof codeInput !== "string" || !/^\d{6}$/.test(codeInput)) {
      throw Object.assign(new Error("Koden är ogiltig."), { status: 400 });
    }
    const challenge = this.database
      .prepare("SELECT * FROM email_challenges WHERE id = ?")
      .get(challengeToken) as ChallengeRow | undefined;
    const now = this.now();
    if (
      !challenge ||
      challenge.consumed_at !== null ||
      challenge.expires_at <= now ||
      challenge.attempts >= MAX_PIN_ATTEMPTS
    ) {
      throw Object.assign(new Error("Koden har gått ut eller kan inte användas."), { status: 400 });
    }

    if (!safeEqualText(this.pinDigest(challenge.id, codeInput), challenge.code_digest)) {
      this.database
        .prepare("UPDATE email_challenges SET attempts = attempts + 1 WHERE id = ?")
        .run(challenge.id);
      throw Object.assign(new Error("Koden är ogiltig."), { status: 400 });
    }

    const existing = this.database
      .prepare("SELECT id, password_hash FROM users WHERE email = ?")
      .get(challenge.email) as { id: string; password_hash: string | null } | undefined;
    if (existing?.password_hash) {
      this.database
        .prepare(
          "UPDATE email_challenges SET consumed_at = ?, verified_at = ?, user_id = ? WHERE id = ?",
        )
        .run(now, now, existing.id, challenge.id);
      return { kind: "authenticated" as const, session: this.createSession(existing.id) };
    }

    const userId = existing?.id ?? randomId();
    if (!existing) {
      this.database
        .prepare("INSERT INTO users (id, email, verified_at, created_at) VALUES (?, ?, ?, ?)")
        .run(userId, challenge.email, now, now);
    }
    this.database
      .prepare(
        "INSERT OR IGNORE INTO company_memberships (company_id,user_id,role,can_approve) VALUES ('fiktiv-ab',?,'owner',1)",
      )
      .run(userId);
    const signupToken = randomToken();
    this.database
      .prepare(
        `UPDATE email_challenges
         SET consumed_at = ?, verified_at = ?, user_id = ?, signup_token_digest = ?
         WHERE id = ?`,
      )
      .run(now, now, userId, digest(signupToken), challenge.id);
    return { kind: "set_password" as const, signupToken, email: challenge.email };
  }

  async setPassword(signupToken: string | undefined, passwordInput: unknown) {
    if (!signupToken)
      throw Object.assign(new Error("Registreringen har gått ut."), { status: 400 });
    const password = validatePassword(passwordInput);
    const challenge = this.database
      .prepare(
        `SELECT user_id, verified_at FROM email_challenges
         WHERE signup_token_digest = ? AND consumed_at IS NOT NULL`,
      )
      .get(digest(signupToken)) as
      | { user_id: string | null; verified_at: number | null }
      | undefined;
    const now = this.now();
    if (!challenge?.user_id || !challenge.verified_at || now - challenge.verified_at > PIN_TTL_MS) {
      throw Object.assign(new Error("Registreringen har gått ut."), { status: 400 });
    }
    const passwordHash = await hashPassword(password);
    const changed = this.database
      .prepare("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL")
      .run(passwordHash, challenge.user_id);
    if (changed.changes !== 1) {
      throw Object.assign(new Error("Lösenordet kunde inte sparas."), { status: 409 });
    }
    this.database
      .prepare("UPDATE email_challenges SET signup_token_digest = NULL WHERE user_id = ?")
      .run(challenge.user_id);
    return this.createSession(challenge.user_id);
  }

  async loginPassword(emailInput: unknown, passwordInput: unknown) {
    const email = normalizeEmail(emailInput);
    const password = typeof passwordInput === "string" ? passwordInput : "";
    const user =
      !this.ownerEmail || email === this.ownerEmail
        ? (this.database
            .prepare("SELECT id, password_hash FROM users WHERE email = ?")
            .get(email) as { id: string; password_hash: string | null } | undefined)
        : undefined;
    const fallback =
      "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const valid = await verifyPassword(password, user?.password_hash ?? fallback).catch(
      () => false,
    );
    if (!user?.password_hash || !valid) {
      throw Object.assign(new Error("Fel e-postadress eller lösenord."), { status: 401 });
    }
    return this.createSession(user.id);
  }

  createSession(userId: string) {
    const now = this.now();
    const token = randomToken();
    const sessionId = randomId();
    this.database
      .prepare(
        `INSERT INTO auth_sessions
          (id, token_digest, user_id, created_at, expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, digest(token), userId, now, now + SESSION_TTL_MS, now);
    return { token, sessionId };
  }

  getSession(token: string | undefined, touch = false): AuthenticatedSession | undefined {
    if (!token) return undefined;
    const now = this.now();
    const row = this.database
      .prepare(
        `SELECT s.id, s.user_id, s.expires_at, s.last_used_at, u.email
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_digest = ?`,
      )
      .get(digest(token)) as SessionRow | undefined;
    if (!row || row.expires_at <= now) {
      if (row) this.database.prepare("DELETE FROM auth_sessions WHERE id = ?").run(row.id);
      return undefined;
    }
    if (touch && now - row.last_used_at >= 60_000) {
      this.database
        .prepare("UPDATE auth_sessions SET last_used_at = ? WHERE id = ?")
        .run(now, row.id);
    }
    return { sessionId: row.id, userId: row.user_id, email: row.email, expiresAt: row.expires_at };
  }

  getPendingSignup(signupToken: string | undefined) {
    if (!signupToken) return undefined;
    return this.database
      .prepare(
        `SELECT u.email, c.verified_at FROM email_challenges c
         JOIN users u ON u.id = c.user_id
         WHERE c.signup_token_digest = ? AND c.verified_at > ?`,
      )
      .get(digest(signupToken), this.now() - PIN_TTL_MS) as
      | { email: string; verified_at: number }
      | undefined;
  }

  getChallenge(challengeToken: string | undefined) {
    if (!challengeToken) return undefined;
    return this.database
      .prepare("SELECT email, expires_at, consumed_at FROM email_challenges WHERE id = ?")
      .get(challengeToken) as
      | { email: string; expires_at: number; consumed_at: number | null }
      | undefined;
  }

  deleteSession(token: string | undefined) {
    const session = this.getSession(token);
    if (!token) return session;
    this.database.prepare("DELETE FROM auth_sessions WHERE token_digest = ?").run(digest(token));
    return session;
  }
}

let singleton: AuthService | undefined;

export const getAuthService = () => {
  if (!singleton) {
    const { authConfig } = requireConfig();
    singleton = new AuthService({
      database: getDatabase(),
      pepper: authConfig.pepper,
      sessionSecret: authConfig.sessionSecret,
      ownerEmail: authConfig.ownerEmail,
      sendPin: sendPinEmail,
    });
  }
  return singleton;
};

function requireConfig() {
  // Kept behind a function so unit tests can construct AuthService without environment state.
  return { authConfig: authConfiguration() };
}
