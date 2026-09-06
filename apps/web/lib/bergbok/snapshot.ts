import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "./config.ts";
import {
  COMPANY_ID,
  artifactContent,
  companyRecord,
  companySummary,
  safeFilename,
  uploadedContent,
} from "./application.ts";
import { getDatabase } from "./database.ts";

export async function materializeChatSnapshot(database = getDatabase()) {
  const summary = await companySummary(database);
  const assignedRows = database
    .prepare(
      "SELECT u.id,u.filename,u.status,d.period_id,u.sha256,d.document_id,u.origin,u.parent_document_id FROM docset_entries d JOIN uploads u ON u.id=d.upload_id WHERE d.company_id=? AND d.status='active' ORDER BY d.period_id,d.created_at,d.document_id",
    )
    .all(COMPANY_ID) as Array<{
    id: string;
    filename: string;
    status: string;
    period_id: string | null;
    sha256: string;
    document_id: string | null;
    origin: string;
    parent_document_id: string | null;
  }>;
  const unassignedRows = database
    .prepare(
      "SELECT id,filename,status,NULL period_id,sha256,NULL document_id,origin,parent_document_id FROM uploads WHERE company_id=? AND status='unassigned' ORDER BY created_at,id",
    )
    .all(COMPANY_ID) as typeof assignedRows;
  const uploadRows = [...assignedRows, ...unassignedRows];
  const visibleUploadIds = new Set(uploadRows.map((upload) => upload.id));
  const snapshotSummary = {
    ...summary,
    uploads: summary.uploads.filter((upload) => visibleUploadIds.has(String(upload.id))),
  };
  const runRows = database
    .prepare(
      "SELECT id,period_id,outcome_kind,run_sha256,run_ref_json,decision,superseded_at FROM bookkeeping_runs WHERE company_id=? ORDER BY created_at,id",
    )
    .all(COMPANY_ID) as Array<Record<string, unknown>>;
  const record = await companyRecord();
  const state = await record.read({ kind: "state" });
  const timeline = await record.read({ kind: "timeline", format: "markdown" });
  const identity = JSON.stringify({
    summary: snapshotSummary,
    uploads: uploadRows,
    runs: runRows.map(({ run_ref_json, ...row }) => ({
      ...row,
      run_ref: JSON.parse(String(run_ref_json)),
    })),
  });
  const snapshotId = createHash("sha256").update(identity).digest("hex");
  const root = path.join(appConfig().snapshotRoot, snapshotId);
  try {
    await access(path.join(root, "manifest.json"));
    return { snapshotId, root };
  } catch {}
  await mkdir(path.join(root, "state"), { recursive: true });
  await mkdir(path.join(root, "documents", "unassigned"), { recursive: true });
  await mkdir(path.join(root, "runs"), { recursive: true });
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await writeFile(
    path.join(root, "company.json"),
    `${JSON.stringify(snapshotSummary, null, 2)}\n`,
    { mode: 0o444 },
  );
  await writeFile(path.join(root, "state", "current.json"), `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o444,
  });
  await writeFile(path.join(root, "timeline.md"), String(timeline), { mode: 0o444 });
  const documents = [];
  for (const upload of uploadRows) {
    const file = await uploadedContent(upload.id, database);
    const section = upload.period_id ?? "unassigned";
    const directory = path.join(root, "documents", section);
    await mkdir(directory, { recursive: true });
    const filename = `${upload.id}--${safeFilename(file.filename)}`;
    await writeFile(path.join(directory, filename), file.bytes, { mode: 0o444 });
    documents.push({
      upload_id: upload.id,
      document_id: upload.document_id,
      period_id: upload.period_id,
      filename: upload.filename,
      origin: upload.origin,
      parent_document_id: upload.parent_document_id,
      snapshot_path: `documents/${section}/${filename}`,
      sha256: upload.sha256,
      download_path: `/api/documents/${upload.id}`,
    });
  }
  for (const run of runRows) {
    const outputSnapshot = await record.read({
      kind: "output_snapshot",
      runRef: JSON.parse(String(run.run_ref_json)),
    });
    await writeFile(
      path.join(root, "runs", `${String(run.id)}.json`),
      `${JSON.stringify(outputSnapshot, null, 2)}\n`,
      { mode: 0o444 },
    );
  }
  const artifacts = [];
  for (const artifact of summary.artifacts) {
    const file = await artifactContent(String(artifact.id), database);
    const filename = `${String(artifact.id)}--${safeFilename(file.filename)}`;
    await writeFile(path.join(root, "artifacts", filename), file.bytes, { mode: 0o444 });
    artifacts.push({
      artifact_id: artifact.id,
      filename: file.filename,
      snapshot_path: `artifacts/${filename}`,
      download_path: `/api/artifacts/${String(artifact.id)}`,
    });
  }
  await writeFile(
    path.join(root, "manifest.json"),
    `${JSON.stringify({ snapshot_id: snapshotId, cutoff_created_at: new Date().toISOString(), company_id: COMPANY_ID, documents, artifacts, periods: summary.periods.map((item) => ({ id: item.id, status: item.status })), state_ref: state.ref }, null, 2)}\n`,
    { mode: 0o444 },
  );
  return { snapshotId, root };
}
