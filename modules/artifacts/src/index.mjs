import { cloneJson, sha256Bytes } from "../../../contracts/src/canonical.mjs";
import { ContractError, normalizeLanguage, sealContent, verifySealedContent } from "../../../contracts/src/index.mjs";
import {
  renderPayslips,
  renderReview,
  renderSie,
  renderVatPdf,
  renderVatXml,
} from "./private/renderers.mjs";

const PROFILES = Object.freeze({
  "review-markdown-v1": (outputs, context) => [renderReview(outputs, context)],
  "sie4-v1": (outputs, context) => [renderSie(outputs, context)],
  "vat-xml-v1": (outputs, context) => [renderVatXml(outputs, context)],
  "vat-verification-pdf-v1": (outputs, context) => [renderVatPdf(outputs, context)],
  "payslips-pdf-v1": renderPayslips,
});
const LANGUAGE_PROFILES = new Set(["review-markdown-v1", "payslips-pdf-v1"]);

export function render(snapshot, artifactProfile) {
  verifySealedContent(snapshot, "artifact snapshot");
  if (snapshot.payload?.schema_version !== undefined && snapshot.payload.schema_version !== snapshot.ref.schema_version) {
    throw new ContractError("Artifact snapshot payload and ContentRef schema versions disagree");
  }
  const profile = normalizeProfile(artifactProfile);
  const renderer = PROFILES[profile.id];
  if (!renderer) throw new ContractError(`Unknown artifact profile: ${profile.id}`);
  const { outputs, approvalStatus, language, review } = extractSnapshot(snapshot.payload);
  const preview = approvalStatus !== "approved";
  const rendered = renderer(outputs, { preview, language, review });
  const artifacts = rendered.map(({ filename, mediaType, bytes }) => ({
    filename,
    media_type: mediaType,
    byte_length: bytes.length,
    sha256: sha256Bytes(bytes),
    content_base64: bytes.toString("base64"),
  }));
  const payload = {
    contract_version: "1.0",
    source_ref: cloneJson(snapshot.ref),
    artifact_profile: profile,
    approval_status: approvalStatus,
    preview,
    ...(LANGUAGE_PROFILES.has(profile.id) ? { language } : {}),
    artifacts,
  };
  return sealContent({
    schemaId: "se.bergbok.artifact-bundle",
    stableId: `${snapshot.ref.stable_id}:${profile.id}`,
    version: `${snapshot.ref.version}-${profile.version}`,
    payload,
  });
}

function normalizeProfile(profile) {
  if (typeof profile === "string") return { id: profile, version: "1" };
  if (!profile || typeof profile.id !== "string") throw new ContractError("artifactProfile must name a registered profile");
  return { id: profile.id, version: String(profile.version ?? "1") };
}

function extractSnapshot(payload) {
  const approvalStatus = payload.approval_status ?? payload.status ?? "preliminary";
  const language = normalizeLanguage(payload.language ?? payload.review?.language ?? "sv", "artifact snapshot language");
  if (payload.language !== undefined && payload.review?.language !== undefined && payload.language !== payload.review.language) {
    throw new ContractError("Artifact snapshot language and review language disagree");
  }
  const outcome = payload.outcome ?? payload.module_outcome ?? payload;
  const outputs = outcome.canonical_outputs ?? payload.canonical_outputs;
  if (!outputs || typeof outputs !== "object") {
    throw new ContractError("Artifact snapshot does not contain canonical_outputs");
  }
  for (const domain of [outputs.bookkeeping, outputs.payroll].filter(Boolean)) assertArtifactDomainMoneyVersion(domain);
  return { outputs: cloneJson(outputs), approvalStatus, language, review: cloneJson(payload.review ?? {}) };
}

function assertArtifactDomainMoneyVersion(domain) {
  const legacy = containsLegacyMoneyField(domain);
  const canonical = containsCanonicalMoneyField(domain);
  if (domain.schema_version === "2.0" && legacy) {
    throw new ContractError("Schema 2.0 artifact source contains legacy unit-suffixed money fields");
  }
  if (domain.schema_version === "1.0" && canonical) {
    throw new ContractError("Schema 1.0 artifact source contains schema 2.0 Money fields");
  }
  if (domain.schema_version === undefined && legacy && canonical) {
    throw new ContractError("Artifact source mixes schema-v1 and schema-v2 money fields");
  }
}

function containsLegacyMoneyField(value) {
  if (Array.isArray(value)) return value.some(containsLegacyMoneyField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    key.endsWith("_ore") || key.endsWith("_sek") || containsLegacyMoneyField(child));
}

const CANONICAL_MONEY_KEYS = new Set([
  "debit", "credit", "amount", "deduction", "fixed_monthly_salary",
  "absence_deduction", "correction", "gross_pay", "tax_withheld",
  "employer_contribution_basis", "employer_contribution", "net_pay",
  "cash_compensation", "original_amount", "remaining",
  "ledger_closing_balance", "external_closing_balance", "by_kind",
  "declaration_boxes",
]);

function containsCanonicalMoneyField(value) {
  if (Array.isArray(value)) return value.some(containsCanonicalMoneyField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    CANONICAL_MONEY_KEYS.has(key) || containsCanonicalMoneyField(child));
}
