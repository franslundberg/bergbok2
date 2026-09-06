import { cloneJson, sha256Json } from "../../../../../contracts/src/canonical.mjs";
import { createModuleOutcome } from "../../../../../contracts/src/index.mjs";
import { classifiedReview } from "../review.mjs";

const STATUS = new Set(["proposal", "needs_input", "out_of_scope"]);

export function parseCandidate(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return { ok: false, errors: [`candidate.json is not valid JSON: ${error.message}`] };
  }
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) errors.push("candidate.json must contain an object");
  if (value?.schema_id !== "se.bergbok.bookkeeping-ai-candidate" || value?.schema_version !== "4.0") {
    errors.push("candidate.json must use se.bergbok.bookkeeping-ai-candidate 4.0");
  }
  if (!STATUS.has(value?.status)) errors.push("candidate.status must be proposal, needs_input, or out_of_scope");
  if (!Array.isArray(value?.questions)) errors.push("candidate.questions must be an array");
  if (!Array.isArray(value?.warnings)) errors.push("candidate.warnings must be an array");
  if (!Array.isArray(value?.reasons)) errors.push("candidate.reasons must be an array");
  if (!value?.review || typeof value.review !== "object" || Array.isArray(value.review)) {
    errors.push("candidate.review must be an object");
  } else {
    const reviewKeys = Object.keys(value.review).sort();
    if (reviewKeys.length !== 2 || reviewKeys[0] !== "summary" || reviewKeys[1] !== "transaction_summaries") {
      errors.push("candidate.review must contain exactly summary and transaction_summaries");
    }
    if (!validPlainText(value.review.summary, 2000, false)) {
      errors.push("candidate.review.summary must be non-empty plain text");
    }
    if (!Array.isArray(value.review.transaction_summaries)) {
      errors.push("candidate.review.transaction_summaries must be an array");
    } else {
      const ids = new Set();
      for (const [index, item] of value.review.transaction_summaries.entries()) {
        if (!item || typeof item !== "object" || Array.isArray(item)
          || Object.keys(item).sort().join(",") !== "source_id,summary"
          || typeof item.source_id !== "string" || !item.source_id
          || !validPlainText(item.summary, 240, true)) {
          errors.push(`candidate.review.transaction_summaries[${index}] is invalid`);
          continue;
        }
        if (ids.has(item.source_id)) errors.push(`candidate.review has duplicate source_id ${item.source_id}`);
        ids.add(item.source_id);
      }
      if (value.status !== "proposal" && value.review.transaction_summaries.length) {
        errors.push("Non-proposal transaction_summaries must be empty");
      }
    }
  }
  if (value?.status === "proposal" && (!value.bookkeeping_input || typeof value.bookkeeping_input !== "object")) {
    errors.push("A proposal must contain bookkeeping_input");
  }
  if (value?.status === "proposal" && value?.questions?.length > 0) errors.push("A proposal must not contain blocking questions");
  if (value?.status === "needs_input" && value?.questions?.length === 0) errors.push("needs_input must contain a question");
  if (value?.status === "out_of_scope" && value?.reasons?.length === 0) errors.push("out_of_scope must contain a reason");
  return errors.length ? { ok: false, errors } : { ok: true, candidate: value };
}

function validPlainText(value, maxLength, singleLine) {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= maxLength
    && !/[<>\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    && (!singleLine || !/\n/.test(value));
}

export function validateCandidate({ source, caseBundle, evaluate, provenance }) {
  const parsed = parseCandidate(source);
  if (!parsed.ok) return parsed;
  const { candidate } = parsed;
  const documentIds = new Set((caseBundle.payload.docset.payload.documents ?? []).map((document) => document.document_id ?? document.payload?.document_id));
  const referenceErrors = [];
  for (const item of [...candidate.questions, ...candidate.warnings, ...candidate.reasons]) {
    if (!item || typeof item !== "object" || typeof item.code !== "string" || typeof (item.prompt ?? item.message) !== "string") {
      referenceErrors.push("Every question, warning, and reason needs code and prompt/message");
      continue;
    }
    for (const id of item.evidence_document_ids ?? []) {
      if (!documentIds.has(id)) referenceErrors.push(`${item.code} cites ${id}, which is not in the fixed Docset`);
    }
  }
  if (referenceErrors.length) return { ok: false, errors: referenceErrors };
  if (candidate.status !== "proposal") return { ok: true, classification: candidate.status, candidate };
  const input = candidate.bookkeeping_input;
  if (input.company_id !== caseBundle.payload.company_id) return { ok: false, errors: ["bookkeeping_input.company_id differs from the case"] };
  if (input.period_id !== caseBundle.payload.period.id) return { ok: false, errors: ["bookkeeping_input.period_id differs from the case"] };
  const expectedMode = caseBundle.payload.period.kind;
  if (input.mode !== expectedMode) return { ok: false, errors: [`bookkeeping_input.mode must be ${expectedMode}`] };
  const needsCore = ["start", "import"].includes(expectedMode)
    && caseBundle.payload.previous_state.payload.sequence === 0
    && Object.keys(caseBundle.payload.previous_state.payload.core ?? {}).length === 0;
  if (needsCore && (!candidate.core || typeof candidate.core !== "object")) {
    return { ok: false, errors: ["The first Start or Import proposal must contain core organization facts"] };
  }
  if (needsCore && (!Array.isArray(candidate.core.evidence_document_ids) || candidate.core.evidence_document_ids.length === 0)) {
    return { ok: false, errors: ["The first Start or Import proposal must cite Docset evidence for its core organization facts"] };
  }
  for (const id of candidate.core?.evidence_document_ids ?? []) {
    if (!documentIds.has(id)) return { ok: false, errors: [`Initial core cites ${id}, which is not in the fixed Docset`] };
  }
  if (needsCore) {
    const policyError = initialPolicyError(candidate.core?.policies?.bookkeeping, caseBundle.payload.effective_policies?.bookkeeping);
    if (policyError) return { ok: false, errors: [policyError] };
  }
  let outcome;
  try {
    outcome = evaluate({ input, core: candidate.core, provenance, assessment: candidate });
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  if (outcome.kind !== "proposal") {
    return {
      ok: false,
      errors: outcome.kind === "needs_input"
        ? outcome.questions.map((question) => `${question.code}: ${question.prompt}`)
        : outcome.reasons.map((reason) => `${reason.code}: ${reason.message}`),
    };
  }
  return { ok: true, classification: "proposal", candidate, outcome };
}

function initialPolicyError(candidate, fixed) {
  if (!candidate || candidate.chart_of_accounts !== "BAS") {
    return "Initial core must propose the BAS chart of accounts";
  }
  const vat = candidate.vat_reporting;
  if (!vat || vat.frequency !== "quarterly"
      || !Array.isArray(vat.input_accounts) || !vat.input_accounts.length
      || !Array.isArray(vat.output_accounts) || !vat.output_accounts.length
      || typeof vat.settlement_account !== "string") {
    return "Initial core must propose an evidence-backed quarterly VAT policy with configured accounts";
  }
  return fixed?.chart_of_accounts === candidate.chart_of_accounts
      && fixed?.vat_reporting?.frequency === vat.frequency
      && sameStrings(fixed?.vat_reporting?.input_accounts, vat.input_accounts)
      && sameStrings(fixed?.vat_reporting?.output_accounts, vat.output_accounts)
      && fixed?.vat_reporting?.settlement_account === vat.settlement_account
    ? null
    : "Initial core VAT policy differs from the controller-owned onboarding policy";
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function candidateOutcome({ candidate, caseBundle, provenance }) {
  const evidence = referencedEvidence(candidate, caseBundle);
  if (candidate.status === "needs_input") {
    return createModuleOutcome({
      kind: "needs_input",
      domain: "bookkeeping",
      caseRef: caseBundle.ref,
      questions: cloneJson(candidate.questions),
      warnings: cloneJson(candidate.warnings),
      evidence,
      review: classifiedReview({ caseBundle, kind: "needs_input", count: candidate.questions.length, assessment: candidate }),
      provenance,
    });
  }
  return createModuleOutcome({
    kind: "out_of_scope",
    domain: "bookkeeping",
    caseRef: caseBundle.ref,
    warnings: cloneJson(candidate.warnings),
    evidence,
    reasons: cloneJson(candidate.reasons),
    review: classifiedReview({ caseBundle, kind: "out_of_scope", count: candidate.reasons.length, assessment: candidate }),
    provenance,
  });
}

export function candidateDigest(candidate) {
  return sha256Json(candidate);
}

function referencedEvidence(candidate, caseBundle) {
  const referenced = new Set(
    [...candidate.questions, ...candidate.warnings, ...candidate.reasons]
      .flatMap((item) => item.evidence_document_ids ?? []),
  );
  return [...referenced].sort().map((documentId) => ({
    kind: "docset_document",
    document_id: documentId,
    docset_ref: cloneJson(caseBundle.payload.docset.ref),
  }));
}
