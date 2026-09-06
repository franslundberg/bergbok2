import { cloneJson } from "../../../contracts/src/canonical.mjs";
import {
  CONTRACT_VERSION,
  ContractError,
  assertConsolidationCase,
  assertContentRef,
  createModuleOutcome,
  normalizeLanguage,
  sealContent,
} from "../../../contracts/src/index.mjs";
import { extractBookkeepingInput, periodBounds, scopeReasons } from "./private/input.mjs";
import { evaluateBookkeeping } from "./private/kernel.mjs";
import { adaptBookkeepingInput } from "./private/money-boundary.mjs";
import {
  findPayrollCandidates,
  mapPayrollFactsToPostings,
  normalizePayrollAccountingFacts,
} from "./private/payroll-facts.mjs";
import { localizeBookkeepingItems } from "./private/localization.mjs";
import { classifiedReview, proposalReview } from "./private/review.mjs";
import { consolidateWithAi } from "./private/ai/index.mjs";

const DOMAIN = "bookkeeping";
const MODULE_VERSION = "4.0.0";
const DEFAULT_VARIANT = "offline-deterministic-v3";
const DEFAULT_AI_VARIANT = "openai-gpt-5.6-luna-high-v3";

export async function consolidate(caseBundle, variantRef = undefined, diagnostics = {}) {
  assertConsolidationCase(caseBundle);
  if (caseBundle.payload.domain !== DOMAIN) {
    return consolidateOffline(caseBundle, variantRef ?? DEFAULT_VARIANT);
  }
  const hasPreparedInput = hasDocumentRole(caseBundle, "bookkeeping-input");
  const variant = normalizeVariantRef(variantRef ?? (hasPreparedInput ? DEFAULT_VARIANT : DEFAULT_AI_VARIANT));
  if (variant.id.startsWith("offline-") || (hasPreparedInput && !variant.id.startsWith("openai-"))) {
    return consolidateOffline(caseBundle, variant);
  }
  return consolidateWithAi({
    caseBundle,
    variant,
    evaluate: ({ input, core, provenance, assessment }) => consolidateOffline(caseBundle, variant, {
      input,
      inputDocumentId: "ai-derived-bookkeeping-input",
      core,
      provenance,
      assessment,
    }),
    onCandidate: diagnostics.onCandidate,
  });
}

export function consolidateOffline(caseBundle, variantRef = DEFAULT_VARIANT, options = {}) {
  assertConsolidationCase(caseBundle);
  const language = normalizeLanguage(caseBundle.payload.language ?? "sv", "ConsolidationCase.language");
  const variant = normalizeVariantRef(variantRef);
  if (caseBundle.payload.domain !== DOMAIN) {
    return outOfScope(caseBundle, [{ code: "WRONG_DOMAIN", message: `Bookkeeping cannot process domain ${caseBundle.payload.domain}` }], variant);
  }
  assertPredecessor(caseBundle);

  const extracted = options.input
    ? {
        ok: true,
        input: cloneJson(options.core?.organization && !options.input.organization
          ? { ...options.input, organization: options.core.organization }
          : options.input),
        document_id: options.inputDocumentId ?? "derived-bookkeeping-input",
        documents: docsetDocumentIds(caseBundle),
      }
    : extractBookkeepingInput(caseBundle);
  if (!extracted.ok) return needsInput(caseBundle, extracted.issues, variant);
  const outside = scopeReasons(extracted.input, caseBundle);
  if (outside.length > 0) return outOfScope(caseBundle, outside, variant, extracted.document_id);

  let internalInput;
  try {
    internalInput = adaptBookkeepingInput(extracted.input, caseBundle.payload.effective_policies.core.currency);
  } catch (error) {
    return needsInput(caseBundle, [{
      code: "BOOKKEEPING_MONEY_INVALID",
      message: error instanceof Error ? error.message : String(error),
      path: "bookkeeping_input",
    }], variant, extracted.document_id);
  }

  const bounds = periodBounds(caseBundle, internalInput);
  const payrollFacts = [];
  const upstreamIssues = [];
  const expectedGroupDigest = caseBundle.payload.group_digest
    ?? caseBundle.payload.aggregate?.group_digest
    ?? caseBundle.payload.docset.payload.group_digest
    ?? null;
  for (const candidate of findPayrollCandidates(caseBundle.payload.upstream_results)) {
    try {
      payrollFacts.push(normalizePayrollAccountingFacts(candidate, {
        companyId: caseBundle.payload.company_id,
        periodId: caseBundle.payload.period.id,
        expectedGroupDigest,
      }));
    } catch (error) {
      upstreamIssues.push({
        code: "PAYROLL_UPSTREAM_REJECTED",
        message: error instanceof Error ? error.message : String(error),
        path: "upstream_results",
        ...(error?.details?.issues ? { details: { issues: error.details.issues } } : {}),
      });
    }
  }
  const mappedPayroll = mapPayrollFactsToPostings(payrollFacts, internalInput.payroll_postings);

  const result = evaluateBookkeeping({
    caseBundle,
    input: internalInput,
    inputDocumentId: extracted.document_id,
    documentIds: extracted.documents,
    payrollTransactions: mappedPayroll.transactions,
    payrollOpenItemChanges: mappedPayroll.open_item_changes,
    bounds,
  });
  if (result.scopeReasons.length > 0) return outOfScope(caseBundle, result.scopeReasons, variant, extracted.document_id);
  const allIssues = [...upstreamIssues, ...mappedPayroll.issues, ...result.issues];
  if (allIssues.length > 0) return needsInput(caseBundle, allIssues, variant, extracted.document_id);

  const projected = sealContent({
    schemaId: "se.bergbok.bookkeeping.state",
    schemaVersion: "3.0",
    stableId: `${caseBundle.payload.company_id}:bookkeeping-state`,
    version: caseBundle.ref.version,
    payload: result.domainState,
  });
  const directEvidence = options.input
    ? referencedDocsetEvidence(extracted.input, caseBundle, options.core?.evidence_document_ids ?? [])
    : [{ kind: "docset_document", document_id: extracted.document_id, docset_ref: cloneJson(caseBundle.payload.docset.ref) }];
  const evidence = [
    ...directEvidence,
    ...payrollFacts.map((facts) => ({
      kind: "authoritative_upstream_result",
      domain: "payroll",
      trust: facts.trust,
      result_ref: cloneJson(facts.upstream_ref),
      facts_ref: cloneJson(facts.facts_ref),
    })),
  ];
  const warnings = localizeBookkeepingItems(
    [...result.warnings, ...(options.assessment?.warnings ?? [])],
    language,
    "message",
  );
  const proposedChanges = [{
    action: "replace_domain_state",
    domain: DOMAIN,
    state_ref: projected.ref,
  }];
  const initialCore = initialCoreProposal(caseBundle, result.canonicalOutput.organization, options.core);
  if (initialCore) proposedChanges.unshift({ action: "initialize_core_state", core: initialCore });
  return createModuleOutcome({
    kind: "proposal",
    domain: DOMAIN,
    caseRef: caseBundle.ref,
    proposedChanges,
    projectedState: projected,
    canonicalOutputs: {
      bookkeeping: result.canonicalOutput,
      period_delta: result.periodDelta,
    },
    warnings,
    evidence,
    review: proposalReview({ caseBundle, output: result.canonicalOutput, assessment: options.assessment }),
    provenance: { ...provenance(variant, options.input ? null : extracted.document_id, payrollFacts), ...cloneJson(options.provenance ?? {}) },
  });
}

function needsInput(caseBundle, issues, variant, inputDocumentId = null) {
  const language = normalizeLanguage(caseBundle.payload.language ?? "sv", "ConsolidationCase.language");
  const localizedIssues = localizeBookkeepingItems(issues, language, "message");
  const questions = localizedIssues.map((item, index) => ({
    question_id: `BKQ${index + 1}`,
    code: item.code,
    prompt: item.message,
    ...(item.path ? { path: item.path } : {}),
    ...(item.details ? { details: item.details } : {}),
  }));
  return createModuleOutcome({
    kind: "needs_input",
    domain: DOMAIN,
    caseRef: caseBundle.ref,
    questions,
    review: classifiedReview({ caseBundle, kind: "needs_input", count: questions.length }),
    provenance: provenance(variant, inputDocumentId, []),
  });
}

function outOfScope(caseBundle, reasons, variant, inputDocumentId = null) {
  const language = normalizeLanguage(caseBundle.payload.language ?? "sv", "ConsolidationCase.language");
  const localizedReasons = localizeBookkeepingItems(reasons, language, "message");
  return createModuleOutcome({
    kind: "out_of_scope",
    domain: DOMAIN,
    caseRef: caseBundle.ref,
    reasons: localizedReasons,
    review: classifiedReview({ caseBundle, kind: "out_of_scope", count: localizedReasons.length }),
    provenance: provenance(variant, inputDocumentId, []),
  });
}

function assertPredecessor(caseBundle) {
  const previous = caseBundle.payload.previous_state;
  const value = previous.payload;
  if (previous.ref.schema_id !== "se.bergbok.state-envelope"
      || value.contract_version !== CONTRACT_VERSION
      || value.company_id !== caseBundle.payload.company_id
      || !Number.isSafeInteger(value.sequence)
      || value.sequence < 0
      || !value.core
      || !value.domains) {
    throw new ContractError("ConsolidationCase contains an incompatible preceding State");
  }
}

function normalizeVariantRef(value) {
  if (value === undefined) return { id: DEFAULT_VARIANT };
  if (typeof value === "string" && value.trim()) return { id: value.trim() };
  if (value && typeof value === "object" && typeof value.id === "string" && value.id.trim()) {
    return cloneJson({ ...value, id: value.id.trim() });
  }
  assertContentRef(value, "variantRef");
  return cloneJson(value);
}

function provenance(variant, inputDocumentId, payrollFacts) {
  return {
    module_id: "se.bergbok.bookkeeping",
    module_version: MODULE_VERSION,
    execution: variant.id.startsWith("offline-") ? "offline_deterministic" : "ai_assessed_deterministically_validated",
    side_effects: "none",
    variant_ref: variant,
    ...(inputDocumentId ? { bookkeeping_input_document_id: inputDocumentId } : {}),
    payroll_upstream_refs: payrollFacts.map((facts) => cloneJson(facts.upstream_ref)),
  };
}

function hasDocumentRole(caseBundle, role) {
  return (caseBundle.payload.docset?.payload?.documents ?? []).some((document) => {
    const value = document?.payload && typeof document.payload === "object" ? document.payload : document;
    return value?.role === role;
  });
}

function docsetDocumentIds(caseBundle) {
  return (caseBundle.payload.docset?.payload?.documents ?? []).map((document) => {
    const value = document?.payload && typeof document.payload === "object" ? document.payload : document;
    return String(value?.document_id ?? value?.id ?? document?.ref?.stable_id ?? "unknown-document");
  });
}

function referencedDocsetEvidence(input, caseBundle, coreEvidence) {
  const ids = new Set([
    ...coreEvidence,
    ...(input.mode === "import" ? docsetDocumentIds(caseBundle) : []),
    ...(input.transactions ?? []).flatMap((item) => item.evidence_document_ids ?? []),
    ...(input.open_item_changes ?? []).flatMap((item) => item.evidence_document_ids ?? []),
    ...(input.reconciliations ?? []).flatMap((item) => item.evidence_document_ids ?? []),
  ]);
  return [...ids].sort().map((documentId) => ({
    kind: "docset_document",
    document_id: documentId,
    docset_ref: cloneJson(caseBundle.payload.docset.ref),
  }));
}

function initialCoreProposal(caseBundle, organization, candidateCore) {
  if (candidateCore === undefined) return null;
  if (!["start", "import"].includes(caseBundle.payload.period.kind)) return null;
  if (caseBundle.payload.previous_state.payload.sequence !== 0) return null;
  if (Object.keys(caseBundle.payload.previous_state.payload.core ?? {}).length > 0) return null;
  const startDate = caseBundle.payload.context?.onboarding?.start_date
    ?? nextDate(caseBundle.payload.period.end);
  return {
    organization: cloneJson(organization),
    registrations: cloneJson(candidateCore?.registrations ?? {}),
    address: cloneJson(candidateCore?.address ?? {}),
    bookkeeping_start_date: startDate,
    enabled_modules: ["bookkeeping"],
    policies: {
      ...cloneJson(caseBundle.payload.effective_policies.core ?? {}),
      bookkeeping: cloneJson(candidateCore.policies.bookkeeping),
    },
  };
}

function nextDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
