"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from "ai";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { Workbench } from "@/components/workbench";
import type { AuthAction } from "@/components/auth-panel";
import type { PublicAuthState } from "@/lib/bergbok/auth-types";
import type { CompanySummary, WorkbenchTarget } from "@/lib/bergbok/types";
import {
  clampWorkbenchWidth,
  DEFAULT_WORKBENCH_WIDTH,
  maximumWorkbenchWidth,
  MIN_WORKBENCH_WIDTH,
} from "@/lib/bergbok/workbench-layout";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { PanelRightIcon } from "lucide-react";

const actionEndpoint = (action: AuthAction) => {
  switch (action.type) {
    case "start_code":
      return ["/api/auth/code/start", { email: action.email }] as const;
    case "verify_code":
      return ["/api/auth/code/verify", { code: action.code }] as const;
    case "password_login":
      return [
        "/api/auth/password/login",
        { email: action.email, password: action.password },
      ] as const;
    case "set_password":
      return ["/api/auth/password/set", { password: action.password }] as const;
    case "logout":
      return ["/api/auth/logout", {}] as const;
  }
};

type Event = {
  id: number;
  type: string;
  payload: Record<string, unknown> & { messageId?: string; text?: string };
  createdAt: number;
};
type Summary = CompanySummary;

const sameSummary = (left: Summary | undefined, right: Summary) =>
  left !== undefined && JSON.stringify(left) === JSON.stringify(right);

export const Assistant = () => {
  const [authState, setAuthState] = useState<PublicAuthState>({ stage: "signed_out" });
  const [authBusy, setAuthBusy] = useState(true);
  const [authError, setAuthError] = useState<string>();
  const [summary, setSummary] = useState<Summary>();
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [historyReady, setHistoryReady] = useState(false);

  const refreshAuth = useCallback(async () => {
    const response = await fetch("/api/auth/state", { cache: "no-store" });
    const body = (await response.json()) as PublicAuthState & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Inloggningsstatus kunde inte läsas.");
    setAuthState(body);
    return body;
  }, []);

  const refreshApp = useCallback(async (hydrate = false) => {
    const [companyResponse, eventsResponse] = await Promise.all([
      fetch("/api/company", { cache: "no-store" }),
      hydrate ? fetch("/api/events", { cache: "no-store" }) : Promise.resolve(null),
    ]);
    if (!companyResponse.ok || (eventsResponse && !eventsResponse.ok))
      throw new Error("Fiktiv AB kunde inte läsas.");
    const nextSummary = (await companyResponse.json()) as Summary;
    setSummary((current) => (sameSummary(current, nextSummary) ? current : nextSummary));
    if (hydrate) {
      const events = ((await eventsResponse!.json()).events ?? []) as Event[];
      setInitialMessages(
        events
          .filter((event) => event.type === "chat_user" || event.type === "chat_assistant")
          .slice(-100)
          .map((event) => ({
            id: event.payload.messageId ?? `event-${event.id}`,
            role: event.type === "chat_user" ? ("user" as const) : ("assistant" as const),
            parts: [{ type: "text" as const, text: event.payload.text ?? "" }],
          })),
      );
      setHistoryReady(true);
    }
  }, []);

  useEffect(() => {
    void refreshAuth()
      .then((state) => {
        if (state.stage === "authenticated") return refreshApp(true);
        setHistoryReady(true);
      })
      .catch((error) => setAuthError(error instanceof Error ? error.message : String(error)))
      .finally(() => setAuthBusy(false));
  }, [refreshApp, refreshAuth]);

  useEffect(() => {
    if (authState.stage !== "authenticated") return;
    const timer = setInterval(() => void refreshApp(false).catch(() => undefined), 2_000);
    return () => clearInterval(timer);
  }, [authState.stage, refreshApp]);

  const handleAuthAction = useCallback(
    async (action: AuthAction) => {
      setAuthBusy(true);
      setAuthError(undefined);
      try {
        const [endpoint, body] = actionEndpoint(action);
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Begäran kunde inte slutföras.");
        const next = await refreshAuth();
        if (next.stage === "authenticated") {
          setHistoryReady(false);
          await refreshApp(true);
        } else {
          setSummary(undefined);
          setInitialMessages([]);
          setHistoryReady(true);
        }
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : String(error));
      } finally {
        setAuthBusy(false);
      }
    },
    [refreshApp, refreshAuth],
  );

  if (!historyReady)
    return <div className="flex h-dvh items-center justify-center">Läser Bergbok…</div>;
  return (
    <ChatShell
      key={`${authState.stage}-${initialMessages.length}`}
      authState={authState}
      authBusy={authBusy}
      authError={authError}
      onAuthAction={handleAuthAction}
      summary={summary}
      messages={initialMessages}
      refreshApp={() => refreshApp(false)}
    />
  );
};

function ChatShell({
  authState,
  authBusy,
  authError,
  onAuthAction,
  summary,
  messages,
  refreshApp,
}: {
  authState: PublicAuthState;
  authBusy: boolean;
  authError?: string;
  onAuthAction: (action: AuthAction) => Promise<void>;
  summary?: Summary;
  messages: UIMessage[];
  refreshApp: () => Promise<void>;
}) {
  const [target, setTarget] = useState<WorkbenchTarget>();
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const targetRef = useRef<WorkbenchTarget | undefined>(undefined);
  const openedOnWide = useRef(false);
  const wide = useMediaQuery("(min-width: 1024px)");
  const {
    width: workbenchWidth,
    maximumWidth: maximumWorkbenchPanelWidth,
    beginResize: beginWorkbenchResize,
    resizeBy: resizeWorkbenchBy,
    reset: resetWorkbenchWidth,
  } = useResizableWorkbench();

  useEffect(() => {
    if (!summary || target) return;
    const periodId = summary.activePeriodId ?? summary.periods.at(-1)?.id;
    if (periodId) setTarget({ kind: "period", periodId });
  }, [summary, target]);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    if (wide && target && !openedOnWide.current) {
      openedOnWide.current = true;
      setWorkbenchOpen(true);
    }
  }, [target, wide]);

  const selectTarget = useCallback((next: WorkbenchTarget) => {
    setTarget(next);
    setWorkbenchOpen(true);
  }, []);

  const uploadFiles = useCallback(
    async (files: FileList, periodId?: string) => {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("file", file);
        if (periodId) form.set("periodId", periodId);
        const response = await fetch("/api/uploads", { method: "POST", body: form });
        const body = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(
            typeof body.error === "string" ? body.error : "Dokumentet kunde inte laddas upp.",
          );
      }
      await refreshApp();
    },
    [refreshApp],
  );
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        body: () => ({ uiContext: targetRef.current ?? null }),
      }),
    [],
  );
  const runtime = useChatRuntime({
    messages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    transport,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SidebarProvider>
        <div className="flex h-dvh w-full overflow-hidden bg-background">
          <ThreadListSidebar
            authState={authState}
            authBusy={authBusy}
            authError={authError}
            onAuthAction={onAuthAction}
            summary={summary}
            selectedPeriodId={target?.periodId}
            onSelectPeriod={(periodId) => selectTarget({ kind: "period", periodId })}
          />
          <SidebarInset className="relative min-w-0">
            <div className="min-h-0 flex-1 overflow-hidden">
              <Thread
                authState={authState}
                authBusy={authBusy}
                authError={authError}
                onAuthAction={onAuthAction}
                onUpload={(files) => uploadFiles(files, summary?.activePeriodId ?? undefined)}
                uploadPeriodId={summary?.activePeriodId ?? undefined}
                onWorkbenchTarget={selectTarget}
              />
            </div>
            {authState.stage === "authenticated" && target && !workbenchOpen && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="absolute top-3 right-3 z-20 bg-background"
                aria-label="Öppna arbetsytan"
                onClick={() => setWorkbenchOpen(true)}
              >
                <PanelRightIcon />
              </Button>
            )}
          </SidebarInset>
          {authState.stage === "authenticated" && summary && target && wide && workbenchOpen && (
            <div
              className="relative hidden h-dvh shrink-0 border-l lg:flex"
              style={{ width: workbenchWidth }}
            >
              <div
                role="separator"
                aria-label="Ändra arbetsytans bredd"
                aria-orientation="vertical"
                aria-valuemin={MIN_WORKBENCH_WIDTH}
                aria-valuemax={maximumWorkbenchPanelWidth}
                aria-valuenow={workbenchWidth}
                tabIndex={0}
                title="Dra för att ändra bredd. Dubbelklicka för standardbredd."
                className="group absolute inset-y-0 -left-1 z-30 flex w-2 cursor-col-resize touch-none justify-center outline-none focus-visible:bg-[#006aa7]/15"
                onPointerDown={beginWorkbenchResize}
                onDoubleClick={resetWorkbenchWidth}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    resizeWorkbenchBy(32);
                  } else if (event.key === "ArrowRight") {
                    event.preventDefault();
                    resizeWorkbenchBy(-32);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    resizeWorkbenchBy(MIN_WORKBENCH_WIDTH - workbenchWidth);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    resizeWorkbenchBy(maximumWorkbenchPanelWidth - workbenchWidth);
                  }
                }}
              >
                <span className="h-full w-px bg-border transition-colors group-hover:bg-[#006aa7] group-focus-visible:bg-[#006aa7]" />
              </div>
              <Workbench
                summary={summary}
                target={target}
                onTarget={selectTarget}
                onUpload={uploadFiles}
                onChanged={refreshApp}
                onClose={() => setWorkbenchOpen(false)}
              />
            </div>
          )}
          {authState.stage === "authenticated" && summary && target && !wide && (
            <Sheet open={workbenchOpen} onOpenChange={setWorkbenchOpen}>
              <SheetContent
                side="right"
                showCloseButton={false}
                className="w-[min(92vw,28rem)] p-0 sm:max-w-none"
              >
                <SheetHeader className="sr-only">
                  <SheetTitle>Arbetsyta</SheetTitle>
                  <SheetDescription>Underlag, dokument och bokföringsförslag.</SheetDescription>
                </SheetHeader>
                <Workbench
                  summary={summary}
                  target={target}
                  onTarget={selectTarget}
                  onUpload={uploadFiles}
                  onChanged={refreshApp}
                  onClose={() => setWorkbenchOpen(false)}
                />
              </SheetContent>
            </Sheet>
          )}
        </div>
      </SidebarProvider>
    </AssistantRuntimeProvider>
  );
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

const WORKBENCH_WIDTH_STORAGE_KEY = "bergbok-workbench-width";

function useResizableWorkbench() {
  const [requestedWidth, setRequestedWidth] = useState(DEFAULT_WORKBENCH_WIDTH);
  const [viewportWidth, setViewportWidth] = useState(1440);
  const dragCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    setViewportWidth(window.innerWidth);
    const stored = Number(window.localStorage.getItem(WORKBENCH_WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) setRequestedWidth(stored);
    const updateViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(requestedWidth));
  }, [requestedWidth]);

  useEffect(() => () => dragCleanup.current?.(), []);

  const width = clampWorkbenchWidth(requestedWidth, viewportWidth);
  const maximumWidth = maximumWorkbenchWidth(viewportWidth);
  const resizeBy = useCallback(
    (difference: number) => {
      setRequestedWidth(clampWorkbenchWidth(width + difference, viewportWidth));
    },
    [viewportWidth, width],
  );
  const reset = useCallback(() => setRequestedWidth(DEFAULT_WORKBENCH_WIDTH), []);
  const beginResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragCleanup.current?.();
      const startX = event.clientX;
      const startWidth = width;
      const previousCursor = document.documentElement.style.cursor;
      const previousUserSelect = document.documentElement.style.userSelect;
      document.documentElement.style.cursor = "col-resize";
      document.documentElement.style.userSelect = "none";
      const move = (moveEvent: PointerEvent) => {
        setRequestedWidth(
          clampWorkbenchWidth(startWidth + startX - moveEvent.clientX, window.innerWidth),
        );
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        document.documentElement.style.cursor = previousCursor;
        document.documentElement.style.userSelect = previousUserSelect;
        dragCleanup.current = null;
      };
      dragCleanup.current = stop;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [width],
  );

  return { width, maximumWidth, beginResize, resizeBy, reset };
}
