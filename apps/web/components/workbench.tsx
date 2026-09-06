"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, FileIcon, FileTextIcon, UploadIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  CompanySummary,
  DocumentDetail,
  PeriodDetail,
  PeriodDocumentSummary,
  WorkContext,
} from "@/lib/bergbok/types";
import { artifactsContext, documentContext, documentsContext } from "@/lib/bergbok/work-context";
import { formatElapsed } from "@/lib/bergbok/job-progress";

const request = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(typeof body.error === "string" ? body.error : "Åtgärden misslyckades.");
  return body;
};

const statusLabel: Record<string, string> = {
  locked: "Låst",
  working: "Pågår",
  running: "Bokför",
  preliminary: "Förslag",
  approved: "Godkänd",
};

export function Workbench({
  summary,
  context,
  onContext,
  onUpload,
  onChanged,
  onClose,
  compactContextLabel,
}: {
  summary: CompanySummary;
  context: WorkContext;
  onContext: (context: WorkContext) => void;
  onUpload: (files: FileList, periodId: string) => Promise<void>;
  onChanged: () => Promise<void>;
  onClose: () => void;
  compactContextLabel?: string;
}) {
  const [detail, setDetail] = useState<PeriodDetail>();
  const [document, setDocument] = useState<DocumentDetail>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const previousPeriodId = useRef(context.periodId);
  const fileInput = useRef<HTMLInputElement>(null);
  const view = editorOpen
    ? "editor"
    : context.activity === "documents"
      ? context.object
        ? "document"
        : "period"
      : context.activity;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = (await request(
        `/api/periods/${encodeURIComponent(context.periodId)}`,
      )) as PeriodDetail;
      setDetail(next);
      if (view === "document" && context.activity === "documents" && context.object) {
        setDocument(
          (await request(
            `/api/periods/${encodeURIComponent(context.periodId)}/documents/${encodeURIComponent(context.object.id)}`,
          )) as DocumentDetail,
        );
      } else {
        setDocument(undefined);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [context, view]);

  useEffect(() => {
    void refresh();
  }, [refresh, summary]);

  useEffect(() => {
    if (previousPeriodId.current !== context.periodId) setEditorOpen(false);
    previousPeriodId.current = context.periodId;
    if (context.activity !== "documents" || context.object) setEditorOpen(false);
  }, [context]);

  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      await onChanged();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length || !detail?.editable) return;
    await perform(() => onUpload(files, context.periodId));
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <aside
      className="relative flex h-full min-h-0 w-full flex-col bg-background"
      aria-label="Arbetsyta"
      onDragEnter={(event) => {
        if (!detail?.editable) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!detail?.editable) return;
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void upload(event.dataTransfer.files);
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        {view !== "period" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Tillbaka till underlagen"
            onClick={() => {
              setEditorOpen(false);
              onContext(documentsContext(context.companyId, context.periodId));
            }}
          >
            <ArrowLeftIcon />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{titleFor(view, document)}</p>
          {compactContextLabel && (
            <p className="truncate text-xs text-muted-foreground">Gäller: {compactContextLabel}</p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Stäng arbetsytan"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading && !detail && <p className="text-sm text-muted-foreground">Läser underlag…</p>}
        {detail && view === "period" && (
          <PeriodView
            detail={detail}
            busy={busy}
            companyId={context.companyId}
            onContext={onContext}
            onOpenEditor={() => setEditorOpen(true)}
            onChooseFiles={() => fileInput.current?.click()}
            onRun={() =>
              perform(() =>
                request(`/api/periods/${encodeURIComponent(context.periodId)}/runs`, {
                  method: "POST",
                }),
              )
            }
            onDuplicate={(uploadId, action) =>
              perform(() =>
                request(`/api/uploads/${encodeURIComponent(uploadId)}/action`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ action, periodId: context.periodId }),
                }),
              )
            }
          />
        )}
        {detail &&
          view === "document" &&
          document &&
          context.activity === "documents" &&
          context.object && (
            <DocumentView
              detail={detail}
              document={document}
              busy={busy}
              companyId={context.companyId}
              onContext={onContext}
              onSave={(markdown) =>
                perform(async () => {
                  const updated = (await request(
                    `/api/periods/${encodeURIComponent(context.periodId)}/documents/${encodeURIComponent(context.object!.id)}`,
                    {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ markdown }),
                    },
                  )) as { documentId: string };
                  onContext(
                    documentContext(context.companyId, context.periodId, updated.documentId),
                  );
                })
              }
              onRemove={() =>
                perform(async () => {
                  await request(
                    `/api/periods/${encodeURIComponent(context.periodId)}/documents/${encodeURIComponent(context.object!.id)}`,
                    { method: "DELETE" },
                  );
                  onContext(documentsContext(context.companyId, context.periodId));
                })
              }
            />
          )}
        {detail && view === "editor" && (
          <TextEditor
            busy={busy}
            onSave={(filename, markdown) =>
              perform(async () => {
                const created = (await request(
                  `/api/periods/${encodeURIComponent(context.periodId)}/documents`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ filename, markdown }),
                  },
                )) as { documentId: string };
                onContext(documentContext(context.companyId, context.periodId, created.documentId));
              })
            }
          />
        )}
        {detail && view === "review" && (
          <ReviewView
            detail={detail}
            busy={busy}
            reviewRunId={context.activity === "review" ? context.object.id : undefined}
            onChanged={() => perform(onChanged)}
            onApproved={() => onContext(artifactsContext(context.companyId, context.periodId))}
          />
        )}
        {detail && view === "artifacts" && <ArtifactsView detail={detail} />}
        {error && (
          <p
            className="mt-4 rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept="application/pdf,image/png,image/jpeg,text/markdown,text/plain,.md,.txt"
        className="hidden"
        onChange={(event) => void upload(event.target.files)}
      />
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-[#006aa7] bg-background/95 text-center">
          <div>
            <UploadIcon className="mx-auto mb-2 size-7 text-[#006aa7]" />
            <p className="font-medium">Lägg till i {context.periodId}</p>
          </div>
        </div>
      )}
    </aside>
  );
}

function PeriodView({
  detail,
  busy,
  companyId,
  onContext,
  onOpenEditor,
  onChooseFiles,
  onRun,
  onDuplicate,
}: {
  detail: PeriodDetail;
  busy: boolean;
  companyId: string;
  onContext: (context: WorkContext) => void;
  onOpenEditor: () => void;
  onChooseFiles: () => void;
  onRun: () => Promise<void>;
  onDuplicate: (uploadId: string, action: "assign" | "ignore") => Promise<void>;
}) {
  const topLevel = detail.documents.filter((document) => !document.parentDocumentId);
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            {statusLabel[detail.period.status] ?? detail.period.status} · {detail.documents.length}{" "}
            dokument
          </p>
        </div>
      </div>

      {detail.editable && (
        <button
          type="button"
          className="w-full rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground hover:border-[#006aa7] hover:text-foreground"
          onClick={onChooseFiles}
        >
          Släpp filer här eller välj filer
        </button>
      )}

      {detail.pendingUploads.map((upload) => (
        <div key={upload.id} className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium">
            {upload.duplicate_of || upload.duplicateOf ? "Möjlig dubblett" : "Ej tilldelad fil"}
          </p>
          <p className="truncate">{upload.filename}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {upload.duplicate_of || upload.duplicateOf
              ? "Samma innehåll har redan laddats upp. Välj om kopian ska användas."
              : "Filen kunde inte läggas till automatiskt. Välj om den ska användas."}
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void onDuplicate(upload.id, "assign")}
            >
              Behåll
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void onDuplicate(upload.id, "ignore")}
            >
              Använd inte
            </Button>
          </div>
        </div>
      ))}

      <div className="divide-y rounded-md border">
        {topLevel.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">Inga underlag ännu.</p>
        )}
        {topLevel.map((document) => (
          <DocumentRow
            key={document.id}
            document={document}
            notes={detail.documents.filter((note) => note.parentDocumentId === document.id)}
            periodId={detail.period.id}
            companyId={companyId}
            onContext={onContext}
          />
        ))}
      </div>

      {detail.period.status === "running" && detail.latestJob && (
        <JobProgress job={detail.latestJob} />
      )}
      {detail.latestJob &&
        ["needs_input", "out_of_scope", "failed"].includes(detail.latestJob.status) && (
          <JobNotice job={detail.latestJob} periodId={detail.period.id} />
        )}
      {detail.artifacts.length > 0 && (
        <button
          type="button"
          className="text-sm text-[#006aa7] underline underline-offset-2"
          onClick={() => onContext(artifactsContext(companyId, detail.period.id))}
        >
          Visa godkända filer
        </button>
      )}
      {detail.editable && (
        <button
          type="button"
          className="text-sm text-[#006aa7] underline underline-offset-2"
          onClick={onOpenEditor}
        >
          Skriv ett textunderlag
        </button>
      )}
      {detail.period.review && (
        <button
          type="button"
          className="w-full rounded-md border-l-4 border-l-[#fecc00] p-3 text-left hover:bg-muted/50"
          onClick={() => {
            if (detail.period.review)
              onContext({
                companyId,
                area: "bookkeeping",
                periodId: detail.period.id,
                activity: "review",
                object: { kind: "run", id: detail.period.review.id },
              });
          }}
        >
          <span className="font-medium">
            {detail.period.review.kind === "proposal"
              ? "Förslaget är klart"
              : "Granskningsresultatet är klart"}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {detail.period.review.sha256.slice(0, 12)} · öppna för granskning
          </span>
        </button>
      )}
      {detail.period.status === "working" && detail.documents.length > 0 && (
        <div className="space-y-2">
          <Button
            type="button"
            disabled={busy}
            aria-label={`Bokför ${detail.period.id}`}
            onClick={() => void onRun()}
          >
            Bokför
          </Button>
        </div>
      )}
    </div>
  );
}

function JobProgress({ job }: { job: NonNullable<PeriodDetail["latestJob"]> }) {
  const [now, setNow] = useState(() => Date.now());
  const active = job.status === "queued" || job.status === "running";

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const elapsedSeconds = Math.max(0, (now - (job.startedAt ?? job.createdAt)) / 1_000);
  return (
    <div className="rounded-md border-l-4 border-l-[#fecc00] bg-[#fecc00]/5 p-3 text-sm">
      <p className="font-medium">Jag bokför underlagen nu.</p>
      <p className="mt-1 text-xs text-muted-foreground">{formatElapsed(elapsedSeconds)}</p>
    </div>
  );
}

function JobNotice({
  job,
  periodId,
}: {
  job: NonNullable<PeriodDetail["latestJob"]>;
  periodId: string;
}) {
  return (
    <div className="rounded-md border-l-4 border-l-amber-400 p-3 text-sm">
      <p className="font-medium">
        {job.status === "needs_input"
          ? "Bergbok behöver mer information"
          : job.status === "out_of_scope"
            ? "Ärendet ligger utanför pilotens stöd"
            : "Körningen misslyckades"}
      </p>
      {job.errorMessage && <p className="mt-1">{job.errorMessage}</p>}
      {job.status !== "failed" && (
        <p className="mt-1">Öppna granskningsrapporten nedan för fullständig information.</p>
      )}
      {job.status !== "out_of_scope" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Komplettera underlaget och skriv sedan ”Bokför {periodId}” i chatten.
        </p>
      )}
    </div>
  );
}

function DocumentRow({
  document,
  notes,
  periodId,
  companyId,
  onContext,
}: {
  document: PeriodDocumentSummary;
  notes: PeriodDocumentSummary[];
  periodId: string;
  companyId: string;
  onContext: (context: WorkContext) => void;
}) {
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/50"
        onClick={() => onContext(documentContext(companyId, periodId, document.id))}
      >
        {document.origin === "upload" ? (
          <FileIcon className="size-4" />
        ) : (
          <FileTextIcon className="size-4" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm">{document.filename}</span>
      </button>
      {notes.map((note) => (
        <button
          key={note.id}
          type="button"
          className="flex w-full items-center gap-2 py-2 pr-3 pl-10 text-left text-xs text-muted-foreground hover:bg-muted/50"
          onClick={() => onContext(documentContext(companyId, periodId, note.id))}
        >
          <FileTextIcon className="size-3.5" />
          <span className="truncate">{note.filename}</span>
        </button>
      ))}
    </div>
  );
}

function DocumentView({
  detail,
  document,
  busy,
  companyId,
  onContext,
  onSave,
  onRemove,
}: {
  detail: PeriodDetail;
  document: DocumentDetail;
  busy: boolean;
  companyId: string;
  onContext: (context: WorkContext) => void;
  onSave: (markdown: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(document.text ?? "");
  useEffect(() => setText(document.text ?? ""), [document]);
  return (
    <div className="space-y-4">
      <div>
        <p className="break-all font-medium">{document.filename}</p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {document.sha256.slice(0, 12)}
        </p>
      </div>
      {editing ? (
        <div className="space-y-3">
          <textarea
            className="min-h-72 w-full resize-y rounded-md border bg-background p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || !text.trim()}
              onClick={() => void onSave(text)}
            >
              Spara ny version
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Avbryt
            </Button>
          </div>
        </div>
      ) : document.text !== null ? (
        <pre className="whitespace-pre-wrap rounded-md border bg-muted/20 p-3 font-sans text-sm leading-relaxed">
          {document.text}
        </pre>
      ) : document.mediaType.startsWith("image/") ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={document.contentUrl}
          alt={document.filename}
          className="h-auto max-w-full rounded border"
        />
      ) : (
        <iframe
          title={document.filename}
          src={document.contentUrl}
          className="h-[65vh] w-full rounded border"
        />
      )}
      <a
        className="text-sm text-[#006aa7] underline"
        href={document.contentUrl}
        target="_blank"
        rel="noreferrer"
      >
        Öppna original
      </a>
      {document.notes.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Anteckningar</h3>
          {document.notes.map((note) => (
            <button
              key={note.id}
              type="button"
              className="block w-full truncate rounded border p-2 text-left text-sm hover:bg-muted/50"
              onClick={() => onContext(documentContext(companyId, document.periodId, note.id))}
            >
              {note.filename}
            </button>
          ))}
        </div>
      )}
      {detail.editable && (
        <div className="flex gap-2 border-t pt-4">
          {document.origin !== "upload" && document.text !== null && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              Redigera
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void onRemove()}
          >
            Ta bort från perioden
          </Button>
        </div>
      )}
    </div>
  );
}

function TextEditor({
  busy,
  onSave,
}: {
  busy: boolean;
  onSave: (filename: string, markdown: string) => Promise<void>;
}) {
  const [filename, setFilename] = useState("anteckning.md");
  const [markdown, setMarkdown] = useState("");
  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium">
        Filnamn
        <input
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-normal"
          value={filename}
          onChange={(event) => setFilename(event.target.value)}
        />
      </label>
      <label className="block text-sm font-medium">
        Innehåll
        <textarea
          className="mt-1 min-h-72 w-full resize-y rounded-md border bg-background p-3 font-mono font-normal"
          value={markdown}
          onChange={(event) => setMarkdown(event.target.value)}
        />
      </label>
      <Button
        type="button"
        disabled={busy || !filename.trim() || !markdown.trim()}
        onClick={() => void onSave(filename, markdown)}
      >
        Lägg till i perioden
      </Button>
    </div>
  );
}

function ReviewView({
  detail,
  busy,
  reviewRunId,
  onChanged,
  onApproved,
}: {
  detail: PeriodDetail;
  busy: boolean;
  reviewRunId?: string;
  onChanged: () => Promise<void>;
  onApproved: () => void;
}) {
  const review = detail.period.review;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  if (!review)
    return (
      <p className="text-sm text-muted-foreground">Det finns inget aktuellt granskningsresultat.</p>
    );
  if (reviewRunId && review.id !== reviewRunId)
    return (
      <p className="text-sm text-muted-foreground">
        Granskningsrapporten har ersatts av ett nyare resultat. Gå tillbaka och öppna den aktuella
        granskningen.
      </p>
    );
  const runId = reviewRunId ?? review.id;
  const approve = async () => {
    setError(undefined);
    try {
      await request(`/api/runs/${runId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approved", expectedRunSha256: review.sha256 }),
      });
      setOpen(false);
      await onChanged();
      onApproved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-medium">Granskningsrapport</h2>
        <p className="font-mono text-xs text-muted-foreground">{review.sha256.slice(0, 12)}</p>
      </div>
      <iframe
        title={`Granskningsrapport ${detail.period.id}`}
        src={`/api/runs/${runId}/review?format=html`}
        sandbox=""
        className="h-[70vh] min-h-[36rem] w-full rounded-md border bg-white"
      />
      <div className="flex flex-wrap gap-3 text-sm">
        <a
          className="text-[#006aa7] underline underline-offset-2"
          href={`/api/runs/${runId}/review?format=pdf`}
        >
          Ladda ned PDF
        </a>
        <a
          className="text-[#006aa7] underline underline-offset-2"
          href={`/api/runs/${runId}/review?format=json`}
        >
          Ladda ned JSON-källa
        </a>
      </div>
      <p className="text-sm text-muted-foreground">Vill du ändra något, beskriv det i chatten.</p>
      {review.approvable && (
        <Button type="button" disabled={busy} onClick={() => setOpen(true)}>
          Godkänn
        </Button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Godkänn förslaget?</DialogTitle>
            <DialogDescription>
              Du godkänner exakt förslag{" "}
              <span className="font-mono">{review.sha256.slice(0, 12)}</span> för {detail.period.id}
              .
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Avbryt</DialogClose>
            <Button type="button" disabled={busy} onClick={() => void approve()}>
              Godkänn
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ArtifactsView({ detail }: { detail: PeriodDetail }) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-medium">Godkända filer</h2>
      {detail.artifacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Inga filer finns ännu.</p>
      ) : (
        detail.artifacts.map((artifact) => (
          <a
            key={artifact.id}
            href={`/api/artifacts/${artifact.id}`}
            className="flex items-center gap-2 rounded-md border p-3 text-sm hover:bg-muted/50"
          >
            <FileTextIcon className="size-4" /> {artifact.filename}
          </a>
        ))
      )}
    </div>
  );
}

function titleFor(
  view: "period" | "document" | "editor" | "review" | "artifacts",
  document?: DocumentDetail,
) {
  if (view === "document") return document?.filename ?? "Dokument";
  if (view === "editor") return "Nytt textunderlag";
  if (view === "review") return "Granskning";
  if (view === "artifacts") return "Godkända filer";
  return "Underlag";
}
