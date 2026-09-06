"use client";

import {
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  type SourceMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  LoaderIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "@assistant-ui/react-markdown/styles/dot.css";

import { UserMessageAttachments } from "@/components/assistant-ui/attachment";
import { AuthPanel, type AuthAction } from "@/components/auth-panel";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import type { PublicAuthState } from "@/lib/bergbok/auth-types";
import type { WorkContext } from "@/lib/bergbok/types";
import { claimWorkContextNavigation } from "@/lib/bergbok/workbench-navigation";
import { emailAddressInText, latestEmailAddress } from "@/lib/bergbok/chat-policy";
import { cn } from "@/lib/utils";

export function Thread({
  authState,
  authBusy,
  authError,
  onAuthAction,
  onUpload,
  uploadPeriodId,
  contextLabel,
  onWorkContext,
}: {
  authState: PublicAuthState;
  authBusy: boolean;
  authError?: string;
  onAuthAction: (action: AuthAction) => Promise<void>;
  onUpload: (files: FileList) => Promise<void>;
  uploadPeriodId?: string;
  contextLabel?: string;
  onWorkContext: (context: WorkContext) => void;
}) {
  const isEmpty = useAuiState((state) => state.thread.isEmpty);
  const emailAddress = useAuiState((state) => latestEmailAddress(state.thread.messages));
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [shouldStickComposer, setShouldStickComposer] = useState(false);
  const [loginEmail, setLoginEmail] = useState<string>();
  const [dismissedEmail, setDismissedEmail] = useState<string>();
  const handledToolCalls = useRef(new Set<string>());
  const activeEmail =
    loginEmail ?? (emailAddress && emailAddress !== dismissedEmail ? emailAddress : undefined);
  const showAuthPanel =
    (authState.stage !== "signed_out" && authState.stage !== "authenticated") ||
    (authState.stage === "signed_out" && Boolean(activeEmail));

  const cancelAuth = () => {
    if (activeEmail) setDismissedEmail(activeEmail);
    setLoginEmail(undefined);
    void onAuthAction({ type: "logout" });
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const update = () => {
      setShouldStickComposer(!isEmpty && content.scrollHeight > viewport.clientHeight + 1);
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(content);
    update();
    return () => observer.disconnect();
  }, [isEmpty]);

  const handleToolNavigation = useCallback(
    (toolCallId: string, result: unknown) => {
      const context = claimWorkContextNavigation(handledToolCalls.current, toolCallId, result);
      if (context) onWorkContext(context);
    },
    [onWorkContext],
  );
  const messageComponents = useMemo(
    () => ({
      UserMessage,
      EditComposer,
      AssistantMessage: () => <AssistantMessage onToolNavigation={handleToolNavigation} />,
    }),
    [handleToolNavigation],
  );

  return (
    <ThreadPrimitive.Root
      className="flex h-full flex-col bg-background text-base"
      style={
        {
          "--thread-max-width": "48rem",
          "--composer-radius": "0.375rem",
          "--composer-padding": "8px",
          "--composer-bg": "var(--color-card)",
          "--accent-color": "#006aa7",
          "--accent-foreground": "#ffffff",
        } as CSSProperties
      }
    >
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        turnAnchor="bottom"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-auto scroll-smooth"
      >
        <div
          ref={contentRef}
          className={cn(
            "mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col px-4 pt-4",
            isEmpty && "flex-1 justify-center",
          )}
        >
          <div className="mb-6 flex flex-col gap-y-6 empty:hidden">
            <ThreadPrimitive.Messages components={messageComponents} />
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "flex w-full flex-col gap-4 overflow-visible bg-background pb-4",
              shouldStickComposer && "sticky bottom-0 rounded-t-[var(--composer-radius)]",
            )}
          >
            {showAuthPanel && (
              <AuthPanel
                state={authState}
                busy={authBusy}
                error={authError}
                initialEmail={activeEmail}
                onAction={onAuthAction}
                onCancel={cancelAuth}
              />
            )}
            {(authState.stage === "authenticated" || !showAuthPanel) && (
              <Composer
                authenticated={authState.stage === "authenticated"}
                onUpload={onUpload}
                uploadPeriodId={uploadPeriodId}
                contextLabel={contextLabel}
                onLoginEmail={(email) => {
                  setDismissedEmail(undefined);
                  setLoginEmail(email);
                }}
              />
            )}
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function Composer({
  authenticated,
  onUpload,
  uploadPeriodId,
  contextLabel,
  onLoginEmail,
}: {
  authenticated: boolean;
  onUpload: (files: FileList) => Promise<void>;
  uploadPeriodId?: string;
  contextLabel?: string;
  onLoginEmail: (email: string) => void;
}) {
  const aui = useAui();
  const composerText = useAuiState((state) => state.composer.text);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>();

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setUploadError(undefined);
    try {
      await onUpload(files);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
      setUploading(false);
    }
  };
  return (
    <ComposerPrimitive.Root
      className="relative flex w-full flex-col"
      onSubmit={(event) => {
        if (authenticated) return;
        const email = emailAddressInText(composerText);
        if (!email) return;
        event.preventDefault();
        aui.thread.append({
          role: "user",
          content: [{ type: "text", text: composerText.trim() }],
          startRun: false,
        });
        void aui.composer.reset();
        onLoginEmail(email);
      }}
    >
      <div className="flex w-full cursor-text flex-col gap-2 rounded-[var(--composer-radius)] border border-border/60 bg-[var(--composer-bg)] p-[var(--composer-padding)] transition-[border-color]">
        {authenticated && (
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="application/pdf,image/png,image/jpeg,text/markdown,text/plain,.md,.txt"
            className="hidden"
            onChange={(event) => void upload(event.target.files)}
          />
        )}
        <ComposerPrimitive.Input
          placeholder={authenticated ? undefined : "Din e-post eller fråga"}
          className="max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none placeholder:text-muted-foreground"
          rows={1}
          autoFocus
          enterKeyHint="send"
          aria-label="Meddelande"
        />
        {authenticated && contextLabel && (
          <div className="px-2.5 text-xs text-muted-foreground" aria-label="Aktivt arbetskontext">
            Gäller: {contextLabel}
          </div>
        )}
        {uploadError && (
          <p className="px-2 text-sm text-destructive" role="alert">
            {uploadError}
          </p>
        )}
        <div className="relative flex items-center justify-between">
          <div>
            {authenticated && (
              <TooltipIconButton
                tooltip={
                  uploadPeriodId
                    ? `Ladda upp dokument till ${uploadPeriodId}`
                    : "Ladda upp dokument"
                }
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-full"
                disabled={uploading}
                aria-label="Ladda upp dokument"
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? (
                  <LoaderIcon className="size-4 animate-spin" />
                ) : (
                  <PlusIcon className="size-4" />
                )}
              </TooltipIconButton>
            )}
          </div>
          <div>
            <AuiIf condition={(state) => !state.thread.isRunning}>
              <ComposerPrimitive.Send
                render={
                  <TooltipIconButton
                    tooltip="Skicka meddelande"
                    side="bottom"
                    type="submit"
                    variant="default"
                    size="icon"
                    className="size-7 rounded-full"
                    style={{
                      backgroundColor: "var(--accent-color)",
                      color: "var(--accent-foreground)",
                    }}
                    aria-label="Skicka meddelande"
                  />
                }
              >
                <ArrowRightIcon className="size-4" />
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(state) => state.thread.isRunning}>
              <ComposerPrimitive.Cancel
                render={
                  <Button
                    type="button"
                    variant="default"
                    size="icon"
                    className="size-7 rounded-full"
                    style={{
                      backgroundColor: "var(--accent-color)",
                      color: "var(--accent-foreground)",
                    }}
                    aria-label="Avbryt svar"
                  />
                }
              >
                <SquareIcon className="size-3.5 fill-current" />
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root
      className="mx-auto grid w-full max-w-[var(--thread-max-width)] auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 py-4 fade-in slide-in-from-bottom-1 animate-in duration-150"
      data-role="user"
    >
      <UserMessageAttachments />
      <div className="relative col-start-2 min-w-0">
        <div className="rounded-[6px] bg-[#006aa7] px-4 py-2.5 break-words text-white">
          <MessagePrimitive.Parts />
        </div>
      </div>
      <BranchPicker className="col-span-full col-start-1 row-start-3 -mr-1 justify-end" />
    </MessagePrimitive.Root>
  );
}

function EditComposer() {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col px-2 py-3">
      <ComposerPrimitive.Root className="ml-auto flex w-full max-w-[85%] flex-col rounded-[var(--composer-radius)] border border-border/60 bg-[var(--composer-bg)]">
        <ComposerPrimitive.Input
          className="min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base text-foreground outline-none"
          autoFocus
        />
        <div className="mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel
            render={<Button variant="ghost" size="sm" className="h-8 rounded-full px-3.5" />}
          >
            Avbryt
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send render={<Button size="sm" className="h-8 rounded-full px-3.5" />}>
            Uppdatera
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({
  onToolNavigation,
}: {
  onToolNavigation: (toolCallId: string, result: unknown) => void;
}) {
  return (
    <MessagePrimitive.Root
      className="group relative mx-auto w-full max-w-[var(--thread-max-width)] py-4 fade-in slide-in-from-bottom-1 animate-in duration-150"
      data-role="assistant"
    >
      <div className="break-words px-2 leading-relaxed text-foreground">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            Source: SourceCitation,
            tools: {
              Fallback: (props) => (
                <InvisibleToolResult {...props} onToolNavigation={onToolNavigation} />
              ),
            },
          }}
        />
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive dark:bg-destructive/5 dark:text-red-200">
            <ErrorPrimitive.Message className="line-clamp-2" />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
        <AuiIf condition={(state) => state.thread.isRunning && state.message.content.length === 0}>
          <div className="flex items-center gap-2 text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" />
            <span className="text-sm">Tänker…</span>
          </div>
        </AuiIf>
      </div>
      <div className="mt-1 ml-2 flex min-h-6 items-center">
        <BranchPicker />
        <ActionBarPrimitive.Root
          hideWhenRunning
          className="pointer-events-none -ml-1 flex gap-1 text-muted-foreground opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
        >
          <ActionBarPrimitive.Copy render={<TooltipIconButton tooltip="Kopiera" />}>
            <AuiIf condition={(state) => state.message.isCopied}>
              <CheckIcon />
            </AuiIf>
            <AuiIf condition={(state) => !state.message.isCopied}>
              <CopyIcon />
            </AuiIf>
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.ExportMarkdown
            render={<TooltipIconButton tooltip="Exportera som Markdown" />}
          >
            <DownloadIcon />
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function InvisibleToolResult({
  result,
  toolCallId,
  onToolNavigation,
}: ToolCallMessagePartProps & {
  onToolNavigation: (toolCallId: string, result: unknown) => void;
}) {
  useEffect(() => {
    onToolNavigation(toolCallId, result);
  }, [onToolNavigation, result, toolCallId]);
  return null;
}

function SourceCitation({ sourceType, url, title }: SourceMessagePartProps) {
  if (sourceType !== "url" || !url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-2 inline-flex max-w-full items-center rounded-md border border-border px-2 py-1 text-xs text-primary underline underline-offset-2 hover:bg-muted"
    >
      {title ?? url}
    </a>
  );
}

function BranchPicker({ className }: { className?: string }) {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn("mr-2 -ml-2 inline-flex items-center text-xs text-muted-foreground", className)}
    >
      <BranchPickerPrimitive.Previous render={<TooltipIconButton tooltip="Föregående" />}>
        <ChevronLeftIcon />
      </BranchPickerPrimitive.Previous>
      <span className="font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next render={<TooltipIconButton tooltip="Nästa" />}>
        <ChevronRightIcon />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}
