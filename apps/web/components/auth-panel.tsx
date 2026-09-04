"use client";

import { useEffect, useState, type FormEvent } from "react";
import { LoaderIcon, LockKeyholeIcon, LogOutIcon, MailIcon } from "lucide-react";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/bergbok/auth-constraints";
import type { PublicAuthState } from "@/lib/bergbok/auth-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type AuthAction =
  | { type: "start_code"; email: string }
  | { type: "verify_code"; code: string }
  | { type: "password_login"; email: string; password: string }
  | { type: "set_password"; password: string }
  | { type: "logout" };

type Props = {
  state: PublicAuthState;
  busy: boolean;
  error?: string;
  initialEmail?: string;
  onAction: (action: AuthAction) => Promise<void>;
  onCancel: () => void;
};

const FieldError = ({ message }: { message?: string }) =>
  message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null;

export function AuthPanel({ state, busy, error, initialEmail, onAction, onCancel }: Props) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [accountKind, setAccountKind] = useState<"checking" | "existing" | "new">("checking");
  const [accountError, setAccountError] = useState<string>();

  useEffect(() => {
    if (state.stage !== "signed_out" || !initialEmail) return;
    const controller = new AbortController();
    setAccountKind("checking");
    setAccountError(undefined);
    setPassword("");
    void fetch("/api/auth/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: initialEmail }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as { kind?: "existing" | "new"; error?: string };
        if (!response.ok || !body.kind)
          throw new Error(body.error ?? "Inloggningen kunde inte förberedas.");
        setAccountKind(body.kind);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setAccountError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [initialEmail, state.stage]);

  const submit = (handler: () => Promise<void>) => (event: FormEvent) => {
    event.preventDefault();
    void handler();
  };

  if (state.stage === "authenticated") {
    return (
      <div className="w-full rounded-[6px] border border-sidebar-border bg-transparent px-4 py-3 text-sm">
        <p className="break-all font-medium">{state.email}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 w-full justify-start"
          disabled={busy}
          onClick={() => void onAction({ type: "logout" })}
        >
          <LogOutIcon className="size-4" />
          Logga ut
        </Button>
      </div>
    );
  }

  if (state.stage === "code") {
    return (
      <form
        onSubmit={submit(() => onAction({ type: "verify_code", code }))}
        className="w-full rounded-[6px] border bg-card p-4 shadow-sm"
      >
        <div className="mb-3 flex items-start gap-3">
          <MailIcon className="mt-0.5 size-5 text-[#006aa7]" />
          <div>
            <p className="font-medium">Ange koden från e-postmeddelandet</p>
            <p className="text-sm text-muted-foreground">
              Skickad till {state.emailHint}. Koden gäller i 10 minuter.
            </p>
          </div>
        </div>
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          placeholder="Sexsiffrig kod"
          aria-label="Tillfällig kod"
          autoFocus
          required
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy || code.length !== 6}>
            {busy && <LoaderIcon className="size-4 animate-spin" />}
            Verifiera
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Avbryt
          </Button>
        </div>
        <div className="mt-2">
          <FieldError message={error} />
        </div>
      </form>
    );
  }

  if (state.stage === "set_password") {
    const mismatch = confirmPassword.length > 0 && password !== confirmPassword;
    return (
      <form
        onSubmit={submit(() => onAction({ type: "set_password", password }))}
        className="w-full rounded-[6px] border bg-card p-4 shadow-sm"
      >
        <div className="mb-3 flex items-start gap-3">
          <LockKeyholeIcon className="mt-0.5 size-5 text-[#006aa7]" />
          <div>
            <p className="font-medium">Skapa ditt lösenord</p>
            <p className="text-sm text-muted-foreground">
              E-postadressen {state.emailHint} är verifierad. Använd {PASSWORD_MIN_LENGTH}–
              {PASSWORD_MAX_LENGTH} tecken.
            </p>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            placeholder="Nytt lösenord"
            aria-label="Nytt lösenord"
            autoFocus
            required
          />
          <Input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            placeholder="Upprepa lösenordet"
            aria-label="Upprepa lösenordet"
            required
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            disabled={busy || password.length < PASSWORD_MIN_LENGTH || mismatch}
          >
            {busy && <LoaderIcon className="size-4 animate-spin" />}
            Skapa konto
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Avbryt
          </Button>
        </div>
        <div className="mt-2">
          <FieldError message={mismatch ? "Lösenorden är inte lika." : error} />
        </div>
      </form>
    );
  }

  if (!initialEmail) return null;

  if (accountKind === "checking") {
    return (
      <div className="w-full rounded-[6px] border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <LoaderIcon className="size-4 animate-spin" />
          <span className="text-sm">Förbereder inloggning…</span>
        </div>
        <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={onCancel}>
          Avbryt
        </Button>
        <FieldError message={accountError} />
      </div>
    );
  }

  if (accountKind === "new") {
    return (
      <div className="w-full rounded-[6px] border bg-card p-4 shadow-sm">
        <p className="font-medium">Välkommen!</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Verifiera din e-postadress för att skapa ett konto.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={busy}
            onClick={() => void onAction({ type: "start_code", email: initialEmail })}
          >
            {busy && <LoaderIcon className="size-4 animate-spin" />}
            Skicka kod
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Avbryt
          </Button>
        </div>
        <div className="mt-2">
          <FieldError message={accountError ?? error} />
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit(() => onAction({ type: "password_login", email: initialEmail, password }))}
      className="w-full rounded-[6px] border bg-card p-4 shadow-sm"
    >
      <p className="font-medium">Lösenord, tack</p>
      <input
        type="email"
        name="email"
        value={initialEmail}
        autoComplete="username"
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />
      <Input
        type="password"
        name="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="current-password"
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        placeholder="Lösenord"
        aria-label="Lösenord"
        className="mt-3"
        autoFocus
        required
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || password.length < PASSWORD_MIN_LENGTH}>
          {busy && <LoaderIcon className="size-4 animate-spin" />}
          Logga in
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => void onAction({ type: "start_code", email: initialEmail })}
        >
          Använd e-postkod
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Avbryt
        </Button>
      </div>
      <div className="mt-2">
        <FieldError message={accountError ?? error} />
      </div>
    </form>
  );
}
