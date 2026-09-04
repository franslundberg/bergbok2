"use client";

import { CheckIcon, DownloadIcon, FileTextIcon, LoaderIcon } from "lucide-react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";

type Artifact = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
};

type ExecuteCodeResult = {
  status: "completed" | "error";
  files?: Artifact[];
  stderr?: string;
  error?: string;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export function ExecuteCodeTool({
  status,
  result,
  isError,
}: ToolCallMessagePartProps<unknown, ExecuteCodeResult>) {
  if (status?.type === "running") {
    return (
      <div className="my-2 flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderIcon className="size-4 animate-spin" />
        <span>Kör kod…</span>
      </div>
    );
  }

  if (isError || result?.status === "error") {
    // The model receives the error and can retry, but recovered implementation
    // details are not useful in the end-user conversation.
    return null;
  }

  const files = result?.files ?? [];
  return (
    <div className="my-2 rounded-md border border-border bg-muted/20 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <CheckIcon className="size-4 text-[#006aa7]" />
        <span>
          {files.length ? `${files.length} fil skapad${files.length === 1 ? "" : "e"}` : "Kod körd"}
        </span>
      </div>
      {files.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {files.map((file) => (
            <div className="flex items-center justify-between gap-3" key={file.id}>
              <span className="flex min-w-0 items-center gap-2 truncate text-muted-foreground">
                <FileTextIcon className="size-4 shrink-0" />
                <span className="truncate">{file.filename}</span>
                <span className="shrink-0 text-xs">({formatBytes(file.size)})</span>
              </span>
              <a
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-primary hover:bg-background"
                href={`/api/artifacts/${file.id}`}
                download={file.filename}
              >
                <DownloadIcon className="size-3.5" />
                Ladda ned
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
