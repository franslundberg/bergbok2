import {
  CANONICAL_JSON_PROFILE,
  canonicalStringify,
  cloneJson,
  deepFreeze,
  sha256Json,
} from "./canonical.mjs";

export {
  ISO_4217_MINOR_UNITS,
  ISO_4217_SOURCE,
  assertMoney,
  currencyMinorUnits,
  formatMoney,
  parseMoney,
} from "./money.mjs";

export const CONTRACT_VERSION = "1.0";
export const OUTCOME_KINDS = Object.freeze(["proposal", "needs_input", "out_of_scope"]);
export const PERIOD_KINDS = Object.freeze(["start", "import", "ordinary"]);
export const PERIOD_STATUSES = Object.freeze(["working", "preliminary", "approved", "closed"]);
export const LANGUAGES = Object.freeze(["sv", "en"]);

export function normalizeLanguage(value = "sv", label = "language") {
  if (!LANGUAGES.includes(value)) {
    throw new ContractError(`${label} must be sv or en`);
  }
  return value;
}

export class ContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ContractError";
    this.code = "BERGBOK_CONTRACT_ERROR";
    this.details = details;
  }
}

export function createContentRef({ schemaId, schemaVersion = CONTRACT_VERSION, stableId, version, payload }) {
  requireText(schemaId, "schemaId");
  requireText(schemaVersion, "schemaVersion");
  requireText(stableId, "stableId");
  requireVersion(version);
  canonicalStringify(payload);
  return deepFreeze({
    schema_id: schemaId,
    schema_version: schemaVersion,
    stable_id: stableId,
    version,
    sha256: digestContent({ schemaId, schemaVersion, stableId, version, payload }),
  });
}

export function sealContent(options) {
  const payload = cloneJson(options.payload);
  return deepFreeze({
    ref: createContentRef({ ...options, payload }),
    payload,
  });
}

export function verifySealedContent(sealed, label = "sealed content") {
  if (!sealed || typeof sealed !== "object" || !sealed.ref || !("payload" in sealed)) {
    throw new ContractError(`${label} must contain ref and payload`);
  }
  assertContentRef(sealed.ref, `${label}.ref`);
  const actual = digestContent({
    schemaId: sealed.ref.schema_id,
    schemaVersion: sealed.ref.schema_version,
    stableId: sealed.ref.stable_id,
    version: sealed.ref.version,
    payload: sealed.payload,
  });
  if (actual !== sealed.ref.sha256) {
    throw new ContractError(`${label} hash mismatch`, {
      expected_sha256: sealed.ref.sha256,
      actual_sha256: actual,
    });
  }
  return true;
}

export function assertContentRef(ref, label = "content reference") {
  if (!ref || typeof ref !== "object") throw new ContractError(`${label} must be an object`);
  requireText(ref.schema_id, `${label}.schema_id`);
  requireText(ref.schema_version, `${label}.schema_version`);
  requireText(ref.stable_id, `${label}.stable_id`);
  requireVersion(ref.version, `${label}.version`);
  if (!/^[a-f0-9]{64}$/.test(ref.sha256 ?? "")) {
    throw new ContractError(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  return true;
}

export function contentRefKey(ref) {
  assertContentRef(ref);
  return `${ref.schema_id}/${ref.stable_id}@${ref.version}#${ref.sha256}`;
}

export function createStateEnvelope({ companyId, sequence, core, domains = {}, precedingStateRef = null }) {
  requireText(companyId, "companyId");
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new ContractError("sequence must be a non-negative safe integer");
  }
  if (precedingStateRef !== null) assertContentRef(precedingStateRef, "precedingStateRef");
  const payload = {
    contract_version: CONTRACT_VERSION,
    company_id: companyId,
    sequence,
    preceding_state_ref: precedingStateRef,
    core: cloneJson(core),
    domains: cloneJson(domains),
  };
  return sealContent({
    schemaId: "se.bergbok.state-envelope",
    stableId: `${companyId}:state`,
    version: sequence,
    payload,
  });
}

export function assertConsolidationCase(caseBundle) {
  verifySealedContent(caseBundle, "ConsolidationCase");
  const value = caseBundle.payload;
  if (value.contract_version !== CONTRACT_VERSION) {
    throw new ContractError(`Unsupported ConsolidationCase contract version: ${value.contract_version}`);
  }
  requireText(value.company_id, "ConsolidationCase.company_id");
  requireText(value.domain, "ConsolidationCase.domain");
  if (value.language !== undefined) normalizeLanguage(value.language, "ConsolidationCase.language");
  assertPeriod(value.period, "ConsolidationCase.period");
  verifySealedContent(value.docset, "ConsolidationCase.docset");
  verifySealedContent(value.previous_state, "ConsolidationCase.previous_state");
  if (!value.effective_policies || typeof value.effective_policies !== "object" || Array.isArray(value.effective_policies)) {
    throw new ContractError("ConsolidationCase.effective_policies must be an object");
  }
  if (!Array.isArray(value.upstream_results)) {
    throw new ContractError("ConsolidationCase.upstream_results must be an array");
  }
  value.upstream_results.forEach((item, index) =>
    verifySealedContent(item, `ConsolidationCase.upstream_results[${index}]`),
  );
  return true;
}

export function assertPeriod(value, label = "Period") {
  requireObject(value, label);
  if (value.start_date !== undefined || value.end_date !== undefined) {
    throw new ContractError(`${label} must use canonical start and end fields`);
  }
  const unknown = Object.keys(value).filter((key) => !["id", "kind", "start", "end"].includes(key));
  if (unknown.length > 0) throw new ContractError(`${label} contains unknown field ${unknown[0]}`);
  requireText(value.id, `${label}.id`);
  if (!PERIOD_KINDS.includes(value.kind)) {
    throw new ContractError(`${label}.kind must be start, import, or ordinary`);
  }
  requireDate(value.end, `${label}.end`);
  if (value.kind === "ordinary") {
    requireDate(value.start, `${label}.start`);
    if (value.start > value.end) throw new ContractError(`${label} starts after it ends`);
  } else if (value.start !== undefined) {
    throw new ContractError(`${label} kind ${value.kind} must not have a lower bound`);
  }
  return true;
}

export function createModuleOutcome({
  kind,
  domain,
  caseRef,
  proposedChanges = [],
  projectedState = null,
  canonicalOutputs = {},
  questions = [],
  warnings = [],
  evidence = [],
  review = {},
  provenance = {},
  reasons = [],
}) {
  if (!OUTCOME_KINDS.includes(kind)) throw new ContractError(`Unknown module outcome kind: ${kind}`);
  requireText(domain, "domain");
  assertContentRef(caseRef, "caseRef");
  requireArray(proposedChanges, "proposedChanges");
  requireArray(questions, "questions");
  requireArray(warnings, "warnings");
  requireArray(evidence, "evidence");
  requireArray(reasons, "reasons");
  requireObject(canonicalOutputs, "canonicalOutputs");
  requireObject(review, "review");
  if (review.language !== undefined) normalizeLanguage(review.language, "review.language");
  requireObject(provenance, "provenance");
  if (kind === "proposal" && projectedState === null) {
    throw new ContractError("A proposal must contain projectedState");
  }
  if (kind === "proposal") {
    verifySealedContent(projectedState, "projectedState");
  }
  if (kind !== "proposal" && proposedChanges.length > 0) {
    throw new ContractError(`${kind} must not contain proposed changes`);
  }
  if (kind !== "proposal" && projectedState !== null) {
    throw new ContractError(`${kind} must not contain projected State`);
  }
  if (kind === "needs_input" && questions.length === 0) {
    throw new ContractError("needs_input must contain at least one question");
  }
  if (kind === "out_of_scope" && reasons.length === 0) {
    throw new ContractError("out_of_scope must contain at least one reason");
  }
  const outcome = {
    contract_version: CONTRACT_VERSION,
    kind,
    domain,
    case_ref: cloneJson(caseRef),
    proposed_changes: cloneJson(proposedChanges),
    projected_state: cloneJson(projectedState),
    canonical_outputs: cloneJson(canonicalOutputs),
    questions: cloneJson(questions),
    warnings: cloneJson(warnings),
    evidence: cloneJson(evidence),
    review: cloneJson(review),
    provenance: {
      ...cloneJson(provenance),
      canonical_json_profile: CANONICAL_JSON_PROFILE,
    },
    reasons: cloneJson(reasons),
  };
  canonicalStringify(outcome);
  return deepFreeze(outcome);
}

export function proposalDigest(outcome) {
  if (outcome?.kind !== "proposal") throw new ContractError("Only a proposal has an approval digest");
  return sha256Json(outcome);
}

export function assertModuleOutcome(outcome, { caseRef, domain } = {}) {
  if (!outcome || typeof outcome !== "object") throw new ContractError("ModuleOutcome must be an object");
  if (!OUTCOME_KINDS.includes(outcome.kind)) throw new ContractError(`Unknown outcome kind: ${outcome.kind}`);
  if (outcome.contract_version !== CONTRACT_VERSION) {
    throw new ContractError(`Unsupported ModuleOutcome contract version: ${outcome.contract_version}`);
  }
  requireText(outcome.domain, "ModuleOutcome.domain");
  assertContentRef(outcome.case_ref, "ModuleOutcome.case_ref");
  if (caseRef && contentRefKey(outcome.case_ref) !== contentRefKey(caseRef)) {
    throw new ContractError("ModuleOutcome is bound to a different ConsolidationCase");
  }
  if (domain && outcome.domain !== domain) {
    throw new ContractError(`Expected ${domain} outcome, received ${outcome.domain}`);
  }
  if (outcome.kind === "proposal" && outcome.projected_state === null) {
    throw new ContractError("Proposal is missing projected_state");
  }
  if (outcome.kind === "proposal") {
    verifySealedContent(outcome.projected_state, "ModuleOutcome.projected_state");
  } else if (outcome.projected_state !== null) {
    throw new ContractError(`${outcome.kind} must not contain projected State`);
  }
  for (const field of ["proposed_changes", "questions", "warnings", "evidence", "reasons"]) {
    requireArray(outcome[field], `ModuleOutcome.${field}`);
  }
  requireObject(outcome.canonical_outputs, "ModuleOutcome.canonical_outputs");
  requireObject(outcome.review, "ModuleOutcome.review");
  if (outcome.review.language !== undefined) normalizeLanguage(outcome.review.language, "ModuleOutcome.review.language");
  requireObject(outcome.provenance, "ModuleOutcome.provenance");
  if (outcome.kind === "needs_input" && outcome.questions.length === 0) {
    throw new ContractError("needs_input is missing questions");
  }
  if (outcome.kind === "out_of_scope" && outcome.reasons.length === 0) {
    throw new ContractError("out_of_scope is missing reasons");
  }
  canonicalStringify(outcome);
  return true;
}

function digestContent({ schemaId, schemaVersion, stableId, version, payload }) {
  return sha256Json({
    schema_id: schemaId,
    schema_version: schemaVersion,
    stable_id: stableId,
    version,
    payload,
  });
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function requireVersion(value, label = "version") {
  const valid = (Number.isSafeInteger(value) && value >= 0) || (typeof value === "string" && value.length > 0);
  if (!valid) throw new ContractError(`${label} must be a non-negative integer or non-empty string`);
}

function requireDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ContractError(`${label} must be YYYY-MM-DD`);
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new ContractError(`${label} must be an array`);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError(`${label} must be an object`);
  }
}
