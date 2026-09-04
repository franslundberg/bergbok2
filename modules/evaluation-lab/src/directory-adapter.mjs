import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { createModuleOutcome, createStateEnvelope, sealContent, verifySealedContent } from "../../../contracts/src/index.mjs";
import { createTestCase } from "./index.mjs";

export async function loadCaseDirectory(caseDirectory) {
  const root = await realpath(caseDirectory);
  const manifest = await readJsonInside(root, "manifest.json");
  requireText(manifest.case_id, "manifest.case_id");
  requireText(manifest.company_id, "manifest.company_id");
  requireText(manifest.domain, "manifest.domain");

  const rawState = await readJsonInside(root, manifest.input?.state ?? "input/state/state.json");
  const previousState = isSealed(rawState)
    ? verified(rawState)
    : createStateEnvelope({
        companyId: manifest.company_id,
        sequence: rawState.sequence ?? 0,
        core: rawState.core ?? {},
        domains: rawState.domains ?? {},
        precedingStateRef: rawState.preceding_state_ref ?? null,
      });
  const rawDocset = await readJsonInside(root, manifest.input?.docset ?? "input/docset/docset.json");
  const docset = isSealed(rawDocset)
    ? verified(rawDocset)
    : sealContent({
        schemaId: "se.bergbok.docset",
        stableId: `${manifest.company_id}:${manifest.period.id}:docset`,
        version: rawDocset.version ?? 1,
        payload: rawDocset,
      });
  const upstreamResults = [];
  for (const relativePath of manifest.input?.upstream_results ?? []) {
    upstreamResults.push(verified(await readJsonInside(root, relativePath)));
  }
  const input = sealContent({
    schemaId: "se.bergbok.consolidation-case",
    stableId: `${manifest.company_id}:${manifest.period.id}:${manifest.domain}`,
    version: manifest.case_version ?? 1,
    payload: {
      contract_version: "1.0",
      company_id: manifest.company_id,
      domain: manifest.domain,
      period: manifest.period,
      docset,
      previous_state: previousState,
      effective_policies: manifest.effective_policies ?? {},
      upstream_results: upstreamResults,
    },
  });

  const rawReferenceState = await readJsonInside(root, manifest.reference?.state ?? "reference/state/state.json");
  const referenceState = isSealed(rawReferenceState)
    ? verified(rawReferenceState)
    : sealContent({
        schemaId: `se.bergbok.${manifest.domain}.state`,
        schemaVersion: rawReferenceState.schema_version ?? "1.0",
        stableId: `${manifest.company_id}:${manifest.domain}-reference-state`,
        version: manifest.case_version ?? 1,
        payload: rawReferenceState,
      });
  const referenceDescription = await readJsonInside(root, manifest.reference?.outputs ?? "reference/outputs/outcome.json");
  const reference = createModuleOutcome({
    kind: referenceDescription.kind,
    domain: referenceDescription.domain ?? manifest.domain,
    caseRef: input.ref,
    proposedChanges: referenceDescription.proposed_changes ?? [],
    projectedState: referenceState,
    canonicalOutputs: referenceDescription.canonical_outputs ?? {},
    questions: referenceDescription.questions ?? [],
    warnings: referenceDescription.warnings ?? [],
    evidence: referenceDescription.evidence ?? [],
    review: referenceDescription.review ?? {},
    provenance: referenceDescription.provenance ?? { reference: true },
    reasons: referenceDescription.reasons ?? [],
  });
  const gradingManual = await readTextInside(root, manifest.grading_manual ?? "grading-manual.md");
  return createTestCase({
    caseId: manifest.case_id,
    input,
    reference,
    gradingProfile: manifest.grading_profile,
    gradingManual,
  });
}

async function readJsonInside(root, relativePath) {
  return JSON.parse(await readTextInside(root, relativePath));
}

async function readTextInside(root, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    throw new Error("Case manifest paths must be relative");
  }
  const candidate = await realpath(path.resolve(root, relativePath));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Case path escapes its directory: ${relativePath}`);
  }
  return readFile(candidate, "utf8");
}

function isSealed(value) {
  return Boolean(value?.ref && Object.hasOwn(value, "payload"));
}

function verified(value) {
  verifySealedContent(value);
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
}
