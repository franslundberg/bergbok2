import { cloneJson, sha256Json } from "../../../../../contracts/src/canonical.mjs";
import { createModuleOutcome, normalizeLanguage } from "../../../../../contracts/src/index.mjs";

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
  if (value?.schema_id !== "se.bergbok.bookkeeping-ai-candidate" || value?.schema_version !== "2.0") {
    errors.push("candidate.json must use se.bergbok.bookkeeping-ai-candidate 2.0");
  }
  if (!STATUS.has(value?.status)) errors.push("candidate.status must be proposal, needs_input, or out_of_scope");
  if (!Array.isArray(value?.questions)) errors.push("candidate.questions must be an array");
  if (!Array.isArray(value?.warnings)) errors.push("candidate.warnings must be an array");
  if (!Array.isArray(value?.reasons)) errors.push("candidate.reasons must be an array");
  if (value?.status === "proposal" && (!value.bookkeeping_input || typeof value.bookkeeping_input !== "object")) {
    errors.push("A proposal must contain bookkeeping_input");
  }
  if (value?.status === "proposal" && value?.questions?.length > 0) errors.push("A proposal must not contain blocking questions");
  if (value?.status === "needs_input" && value?.questions?.length === 0) errors.push("needs_input must contain a question");
  if (value?.status === "out_of_scope" && value?.reasons?.length === 0) errors.push("out_of_scope must contain a reason");
  return errors.length ? { ok: false, errors } : { ok: true, candidate: value };
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
  const outcome = evaluate({ input, core: candidate.core, provenance, assessment: candidate });
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

export function candidateOutcome({ candidate, caseBundle, provenance }) {
  const language = normalizeLanguage(caseBundle.payload.language ?? "sv", "ConsolidationCase.language");
  const evidence = referencedEvidence(candidate, caseBundle);
  if (candidate.status === "needs_input") {
    return createModuleOutcome({
      kind: "needs_input",
      domain: "bookkeeping",
      caseRef: caseBundle.ref,
      canonicalOutputs: { assessment: cloneJson(candidate) },
      questions: cloneJson(candidate.questions),
      warnings: cloneJson(candidate.warnings),
      evidence,
      review: {
        language,
        summary: language === "sv"
          ? `${candidate.questions.length} fråga${candidate.questions.length === 1 ? "" : "or"} måste besvaras`
          : `${candidate.questions.length} question${candidate.questions.length === 1 ? "" : "s"} must be answered`,
        report_markdown: renderQuestions(candidate, caseBundle, language),
      },
      provenance,
    });
  }
  return createModuleOutcome({
    kind: "out_of_scope",
    domain: "bookkeeping",
    caseRef: caseBundle.ref,
    canonicalOutputs: { assessment: cloneJson(candidate) },
    warnings: cloneJson(candidate.warnings),
    evidence,
    reasons: cloneJson(candidate.reasons),
    review: {
      language,
      summary: language === "sv"
        ? "Underlaget ligger utanför den aktiverade Pilot-profilen"
        : "The evidence is outside the activated Pilot profile",
      report_markdown: renderReasons(candidate, caseBundle, language),
    },
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

function renderQuestions(candidate, caseBundle, language) {
  if (language === "en") {
    return [
      `# Bookkeeping assessment – ${caseBundle.payload.period.id}`,
      "",
      "## Status",
      "",
      "The proposal cannot be approved yet. Add answers or supporting documents and run again.",
      "",
      "## Questions",
      "",
      ...candidate.questions.map((item) => `- **${item.code}:** ${item.prompt}`),
      "",
    ].join("\n");
  }
  return [
    `# Bokföringsbedömning – ${caseBundle.payload.period.id}`,
    "",
    "## Status",
    "",
    "Förslaget kan inte godkännas ännu. Lägg svar eller kompletterande underlag i Documents och kör igen.",
    "",
    "## Frågor",
    "",
    ...candidate.questions.map((item) => `- **${item.code}:** ${item.prompt}`),
    "",
  ].join("\n");
}

function renderReasons(candidate, caseBundle, language) {
  if (language === "en") {
    return [
      `# Bookkeeping assessment – ${caseBundle.payload.period.id}`,
      "",
      "## Status",
      "",
      "The evidence is outside the activated Pilot profile.",
      "",
      "## Reasons",
      "",
      ...candidate.reasons.map((item) => `- **${item.code}:** ${item.message}`),
      "",
    ].join("\n");
  }
  return [
    `# Bokföringsbedömning – ${caseBundle.payload.period.id}`,
    "",
    "## Status",
    "",
    "Underlaget ligger utanför den aktiverade Pilot-profilen.",
    "",
    "## Orsaker",
    "",
    ...candidate.reasons.map((item) => `- **${item.code}:** ${item.message}`),
    "",
  ].join("\n");
}
