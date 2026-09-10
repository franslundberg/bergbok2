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
import type { CompanySummary, WorkContext } from "@/lib/bergbok/types";
import {
  defaultWorkContext,
  documentsContext,
  restoreWorkContext,
  switchWorkContextPeriod,
} from "@/lib/bergbok/work-context";
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
  payload: Record<string, unknown> & { messageId?: string; text?: string; parts?: unknown };
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
            parts:
              event.type === "chat_assistant" && Array.isArray(event.payload.parts)
                ? (event.payload.parts as UIMessage["parts"])
                : [{ type: "text" as const, text: event.payload.text ?? "" }],
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
  const [workContext, setWorkContext] = useState<WorkContext>();
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const workContextRef = useRef<WorkContext | undefined>(undefined);
  const restoredCompany = useRef<string | undefined>(undefined);
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
    if (!summary || restoredCompany.current === summary.company.id) return;
    restoredCompany.current = summary.company.id;
    let cancelled = false;
    const restore = async () => {
      let restored: WorkContext | undefined;
      try {
        const stored = window.sessionStorage.getItem(`bergbok-work-context:${summary.company.id}`);
        if (stored) {
          const parsed = JSON.parse(stored) as unknown;
          restored = restoreWorkContext(parsed, summary);
          const restoredDocumentId =
            restored?.activity === "documents" ? restored.object?.id : undefined;
          const restoredPeriodId = restored?.periodId;
          if (restoredDocumentId && restoredPeriodId) {
            const response = await fetch(`/api/periods/${encodeURIComponent(restoredPeriodId)}`, {
              cache: "no-store",
            });
            if (!response.ok) restored = defaultWorkContext(summary);
            else {
              const detail = (await response.json()) as { documents?: Array<{ id: string }> };
              if (!detail.documents?.some(({ id }) => id === restoredDocumentId))
                restored = defaultWorkContext(summary);
            }
          }
        }
      } catch {
        restored = undefined;
      }
      if (!restored) restored = defaultWorkContext(summary);
      if (!cancelled) setWorkContext(restored);
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [summary]);

  useEffect(() => {
    workContextRef.current = workContext;
    if (!workContext || !summary) return;
    try {
      window.sessionStorage.setItem(
        `bergbok-work-context:${summary.company.id}`,
        JSON.stringify(workContext),
      );
    } catch {
      // Session storage is an enhancement; the current context remains in memory.
    }
  }, [summary, workContext]);

  useEffect(() => {
    if (wide && workContext && !openedOnWide.current) {
      openedOnWide.current = true;
      setWorkbenchOpen(true);
    }
  }, [workContext, wide]);

  const selectContext = useCallback((next: WorkContext) => {
    setWorkContext(next);
    setWorkbenchOpen(true);
  }, []);
  const selectPeriod = useCallback(
    (periodId: string) => {
      if (summary)
        selectContext(
          switchWorkContextPeriod(
            workContext ?? documentsContext(summary.company.id, periodId),
            periodId,
          ),
        );
    },
    [selectContext, summary, workContext],
  );

  const uploadFiles = useCallback(
    async (files: FileList, periodId?: string) => {
      const destinationPeriodId = periodId ?? workContextRef.current?.periodId;
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("file", file);
        if (destinationPeriodId) form.set("periodId", destinationPeriodId);
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
        body: () => ({ workContext: workContextRef.current ?? null }),
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
            selectedPeriodId={workContext?.periodId}
            onSelectPeriod={selectPeriod}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            {authState.stage === "authenticated" && summary && workContext && (
              <WorkContextBar
                summary={summary}
                context={workContext}
                onSelectPeriod={selectPeriod}
              />
            )}
            <div className="flex min-h-0 flex-1">
              <SidebarInset className="relative min-w-0">
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Thread
                    authState={authState}
                    authBusy={authBusy}
                    authError={authError}
                    onAuthAction={onAuthAction}
                    onUpload={(files) => uploadFiles(files, workContextRef.current?.periodId)}
                    uploadPeriodId={workContext?.periodId}
                    contextLabel={workContext ? contextLabel(workContext.periodId) : undefined}
                    onWorkContext={selectContext}
                  />
                </div>
                {authState.stage === "authenticated" && workContext && !workbenchOpen && (
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
              {authState.stage === "authenticated" &&
                summary &&
                workContext &&
                wide &&
                workbenchOpen && (
                  <div
                    className="relative hidden h-full shrink-0 border-l lg:flex"
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
                      context={workContext}
                      onContext={selectContext}
                      onUpload={uploadFiles}
                      onChanged={refreshApp}
                      onClose={() => setWorkbenchOpen(false)}
                    />
                  </div>
                )}
            </div>
          </div>
          {authState.stage === "authenticated" && summary && workContext && !wide && (
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
                  context={workContext}
                  onContext={selectContext}
                  onUpload={uploadFiles}
                  onChanged={refreshApp}
                  onClose={() => setWorkbenchOpen(false)}
                  compactContextLabel={contextLabel(workContext.periodId)}
                />
              </SheetContent>
            </Sheet>
          )}
        </div>
      </SidebarProvider>
    </AssistantRuntimeProvider>
  );
}

const periodStatusLabel: Record<string, string> = {
  locked: "Låst",
  working: "Pågår",
  running: "Bokför",
  preliminary: "Förslag",
  approved: "Godkänd",
};

function contextLabel(periodId: string) {
  if (/^\d{4}-(0[1-9]|1[0-2])$/u.test(periodId)) {
    const [, year, month] = periodId.match(/^(\d{4})-(\d{2})$/u) ?? [];
    const names = [
      "Januari",
      "Februari",
      "Mars",
      "April",
      "Maj",
      "Juni",
      "Juli",
      "Augusti",
      "September",
      "Oktober",
      "November",
      "December",
    ];
    return `${names[Number(month) - 1]} ${year}`;
  }
  return periodId;
}

function WorkContextBar({
  summary,
  context,
  onSelectPeriod,
}: {
  summary: Summary;
  context: WorkContext;
  onSelectPeriod: (periodId: string) => void;
}) {
  const period = summary.periods.find(({ id }) => id === context.periodId);
  const activity =
    context.activity === "documents"
      ? "Underlag"
      : context.activity === "review"
        ? "Granskning"
        : "Godkända filer";
  return (
    <div className="sticky top-0 z-20 flex min-h-14 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b bg-background px-4 py-2 shadow-sm">
      <span className="font-medium">Bokföring</span>
      <label className="flex items-center gap-2 text-sm">
        <span className="sr-only">Period</span>
        <select
          className="rounded-md border bg-background px-2 py-1.5 font-medium outline-none focus:ring-2 focus:ring-ring"
          value={context.periodId}
          onChange={(event) => onSelectPeriod(event.target.value)}
          aria-label="Välj period"
        >
          {summary.periods.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {contextLabel(candidate.id)}
            </option>
          ))}
        </select>
      </label>
      <span className="text-sm text-muted-foreground">{activity}</span>
      <span className="text-xs text-muted-foreground">
        {periodStatusLabel[period?.status ?? ""] ?? period?.status ?? ""}
      </span>
      {summary.activePeriodId && summary.activePeriodId !== context.periodId && (
        <span className="text-xs text-muted-foreground">
          Aktiv period: {contextLabel(summary.activePeriodId)}
        </span>
      )}
    </div>
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
