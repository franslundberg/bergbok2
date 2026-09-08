import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloneJson, prettyCanonicalJson } from "../../../../../contracts/src/canonical.mjs";
import { runAgent } from "./agent.mjs";
import { candidateDigest, candidateOutcome } from "./candidate.mjs";
import { API_URL, MODEL_VARIANTS } from "./constants.mjs";
import { inspectImages, startWorkspace } from "./docker.mjs";
import { loadEnvironment } from "./env.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

export async function consolidateWithAi({ caseBundle, variant, evaluate, onCandidate }) {
  const price = resolveVariant(variant);
  const environment = await loadEnvironment(path.join(REPOSITORY_ROOT, ".env.local"));
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for AI Bookkeeping consolidation");
  const images = await inspectImages();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bergbok-bookkeeping-"));
  const runId = `run-${Date.now()}-${process.pid}`;
  let workspace;
  try {
    const staged = await stageCase(caseBundle, temporary);
    workspace = await startWorkspace({
      runId,
      docsetPath: staged.docsetPath,
      contextPath: staged.contextPath,
      allowWeb: Boolean(variant.allow_web),
    });
    const agent = await runAgent({
      apiKey,
      apiUrl: environment.OPENAI_BASE_URL?.trim() || API_URL,
      caseBundle,
      variant,
      price,
      workspace,
      evaluate,
      terminalLog: variant.quiet ? () => undefined : console.log,
    });
    if (onCandidate !== undefined) {
      if (typeof onCandidate !== "function") throw new TypeError("onCandidate diagnostic sink must be a function");
      await onCandidate(cloneJson(agent.candidate));
    }
    const provenance = {
      provider: "openai",
      side_effects: "model_inference_only",
      model: price.model,
      reasoning_effort: price.reasoning_effort,
      store: false,
      worker_image: images.worker,
      worker_network: workspace.network,
      worker_startup_ms: workspace.startup_ms,
      duration_ms: agent.duration_ms,
      model_calls: agent.steps,
      tool_calls: agent.tool_calls,
      usage: agent.usage,
      pricing: {
        source: "https://developers.openai.com/api/docs/models",
        retrieved_at: "2026-09-03",
        value_is_estimate: true,
      },
      candidate_sha256: candidateDigest(agent.candidate),
    };
    if (agent.candidate.status === "proposal") {
      return evaluate({
        input: agent.candidate.bookkeeping_input,
        core: agent.candidate.core,
        provenance,
        assessment: agent.candidate,
      });
    }
    return candidateOutcome({ candidate: agent.candidate, caseBundle, provenance });
  } finally {
    await workspace?.cleanup().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

function resolveVariant(variant) {
  const registered = MODEL_VARIANTS[variant.id];
  if (!registered) throw new Error(`Unknown Bookkeeping AI variant: ${variant.id}`);
  return { ...registered };
}

async function stageCase(caseBundle, root) {
  const docsetPath = path.join(root, "input");
  const contextPath = path.join(root, "context");
  await Promise.all([mkdir(docsetPath), mkdir(contextPath)]);
  const documents = [];
  const names = new Set();
  let totalBytes = 0;
  for (const document of caseBundle.payload.docset.payload.documents ?? []) {
    const value = document?.payload && typeof document.payload === "object" ? document.payload : document;
    if (typeof value?.content_base64 !== "string") throw new Error(`Docset document ${value?.document_id ?? "unknown"} has no portable bytes`);
    const bytes = decodePortableBytes(value.content_base64, value.document_id);
    if (bytes.length > 20 * 1024 * 1024) throw new Error(`Docset document ${value.document_id} exceeds 20 MiB`);
    totalBytes += bytes.length;
    if (totalBytes > 100 * 1024 * 1024) throw new Error("Docset exceeds 100 MiB");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (value.sha256 && value.sha256 !== digest) throw new Error(`Docset document ${value.document_id} failed SHA-256 validation`);
    let filename = path.basename(value.filename ?? value.document_id ?? "document.bin").replace(/[^A-Za-z0-9._-]/g, "_");
    if (!filename || filename === "." || filename === "..") filename = "document.bin";
    if (names.has(filename)) filename = `${String(value.document_id).replace(/[^A-Za-z0-9._-]/g, "_")}--${filename}`;
    names.add(filename);
    await writeFile(path.join(docsetPath, filename), bytes, { flag: "wx" });
    documents.push({
      document_id: value.document_id,
      filename: value.filename ?? filename,
      workspace_path: `/workspace/input/${filename}`,
      media_type: value.media_type,
      sha256: value.sha256 ?? null,
      role: value.role,
    });
  }
  const summary = {
    contract_version: caseBundle.payload.contract_version,
    company_id: caseBundle.payload.company_id,
    domain: caseBundle.payload.domain,
    period: cloneJson(caseBundle.payload.period),
    docset_ref: cloneJson(caseBundle.payload.docset.ref),
    previous_state_ref: cloneJson(caseBundle.payload.previous_state.ref),
    effective_policies: cloneJson(caseBundle.payload.effective_policies),
    context: cloneJson(caseBundle.payload.context ?? {}),
  };
  await Promise.all([
    writeFile(path.join(contextPath, "case.json"), prettyCanonicalJson(summary), "utf8"),
    writeFile(path.join(contextPath, "previous-state.json"), prettyCanonicalJson(caseBundle.payload.previous_state), "utf8"),
    writeFile(path.join(contextPath, "documents.json"), `${JSON.stringify(documents, null, 2)}\n`, "utf8"),
    writeFile(path.join(contextPath, "upstream-results.json"), prettyCanonicalJson(caseBundle.payload.upstream_results), "utf8"),
    writeFile(path.join(contextPath, "candidate-contract.md"), candidateContract(), "utf8"),
  ]);
  return { docsetPath, contextPath, documents };
}

function decodePortableBytes(encoded, documentId) {
  const compact = encoded.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error(`Docset document ${documentId ?? "unknown"} has invalid base64`);
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    throw new Error(`Docset document ${documentId ?? "unknown"} has non-canonical base64`);
  }
  return bytes;
}

function candidateContract() {
  return `# candidate.json contract

Write one JSON object with no Markdown fences:

\`\`\`json
{
  "schema_id": "se.bergbok.bookkeeping-ai-candidate",
  "schema_version": "4.0",
  "status": "proposal | needs_input | out_of_scope",
  "core": {
    "organization": { "name": "Legal name", "organization_number": "NNNNNN-NNNN" },
    "registrations": {},
    "address": {},
    "policies": {
      "bookkeeping": {
        "chart_of_accounts": "BAS",
        "vat_reporting": {
          "frequency": "quarterly",
          "input_accounts": ["2641"],
          "output_accounts": ["2611"],
          "settlement_account": "2650"
        }
      }
    },
    "evidence_document_ids": ["exact document_id supporting the core facts"]
  },
  "bookkeeping_input": {
    "schema_id": "se.bergbok.bookkeeping-input",
    "schema_version": "3.0",
    "company_id": "exact case company_id",
    "period_id": "exact case period.id",
    "mode": "start | import | ordinary",
    "imported_balances": [],
    "imported_open_items": [],
    "imported_verification_series": { "series": "A", "last_number": 0 },
    "transactions": [{
      "source_id": "stable source key",
      "date": "YYYY-MM-DD",
      "description": "Description in the selected language, preserving source wording when reused",
      "evidence_document_ids": ["exact document_id"],
      "lines": [{ "account": "1930", "account_name": "Företagskonto", "debit": "0.00 SEK", "credit": "1.00 SEK" }]
    }],
    "payroll_postings": [{
      "payroll_facts_ref": { "schema_id": "se.bergbok.bookkeeping.payroll-accounting-facts", "schema_version": "copy exact value", "stable_id": "copy exact value", "version": 1, "sha256": "copy exact value" },
      "date": "YYYY-MM-DD",
      "description": "Description in the selected language, preserving source wording when reused",
      "assignments": [{ "fact_id": "copy exact fact_id", "account": "7010", "account_name": "AI-selected account name" }]
    }],
    "open_item_changes": [],
    "reconciliations": [{ "account": "1930", "external_closing_balance": "0.00 SEK", "evidence_document_ids": ["exact document_id"] }]
  },
  "review": {
    "summary": "Plain-text consolidation summary in the selected language",
    "transaction_summaries": [{
      "source_id": "exact source_id of a resulting canonical transaction",
      "summary": "One strong human-facing summary: one or two sentences on one line, at most 240 characters"
    }]
  },
  "questions": [{ "question_id": "BKQ1", "code": "MISSING_FACT", "prompt": "Question in the selected language", "evidence_document_ids": [] }],
  "warnings": [{ "code": "WARNING", "message": "Warning in the selected language", "evidence_document_ids": [] }],
  "reasons": [{ "code": "OUTSIDE_PROFILE", "message": "Reason in the selected language", "evidence_document_ids": [] }]
}
\`\`\`

For each authoritative PayrollAccountingFacts in upstream-results.json, payroll_postings must contain exactly one mapping. Copy its exact sealed ref and every fact_id, and select an account for every economic fact from previous State, approved history, current evidence, explicit policy, and Swedish bookkeeping knowledge. Do not copy or calculate payroll amounts; the trusted validator derives each debit or credit amount from the sealed facts. If no PayrollAccountingFacts exists, payroll_postings is an empty array.

Every monetary amount is canonical Money: a major-unit decimal, one ASCII space, and the uppercase currency code. SEK always has exactly two decimals, including zero and whole-krona values, for example "0.00 SEK" and "48406.00 SEK". Never emit integer ore, JSON decimal numbers, grouping separators, or decimal commas.

For Start, all imported fields, transactions, payroll_postings, open_item_changes, and reconciliations must be empty or omitted. For Import, imported_balances, imported_open_items, and imported_verification_series are required and transactions, payroll_postings, and open_item_changes must be empty. Ordinary periods must not contain imported fields.

For the first Start or Import, core.policies.bookkeeping is required. Extract the quarterly frequency from cited company evidence and use the controller-configured BAS VAT accounts exactly. Later periods use the trusted policy supplied in case.json.

VAT is fully deterministic and must never appear in candidate.json: never include a "vat" field, and never author a VAT-closing transaction. At quarter end, the trusted validator computes the declaration boxes and constructs the closing transaction itself from already-booked ledger balances; it also supplies that transaction's narrative summary. Book only the period's own ordinary activity.

Review is always required. Its summary is plain text. For a proposal, transaction_summaries must contain exactly one entry for every transaction you authored yourself, keyed by its exact source_id, including payroll-derived transactions (never a VAT-closing transaction, which you did not author). Each transaction summary is the sole human-facing narrative for that transaction. Write one or two concise sentences on one physical line, at most 240 characters, in the selected language. Combine what happened with how it was booked, using meaningful account names or numbers and the amount when relevant. Add a qualification or reason only when the treatment depends on a material accepted assumption, tax classification, or non-obvious judgment; omit routine explanations and boilerplate. Make the summary consistent with the exact resulting transaction. For needs_input and out_of_scope, transaction_summaries must be empty.

For proposal, questions must be empty and bookkeeping_input is required. For needs_input, questions must be non-empty; bookkeeping_input may contain a safe partial draft. For out_of_scope, reasons must be non-empty. Core is required only when initializing the first Start or Import State. Omit fields that do not apply, except questions, warnings, and reasons are always arrays.
`;
}
