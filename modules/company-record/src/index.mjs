import path from "node:path";

import {
  canonicalStringify,
  cloneJson,
  deepFreeze,
  sha256Bytes,
  sha256Json,
} from "../../../contracts/src/canonical.mjs";
import {
  CONTRACT_VERSION,
  ContractError,
  assertConsolidationCase,
  assertContentRef,
  assertModuleOutcome,
  assertPeriod,
  contentRefKey,
  createStateEnvelope,
  normalizeLanguage,
  proposalDigest,
  sealContent,
  verifySealedContent,
} from "../../../contracts/src/index.mjs";
import {
  StorageIntegrityError,
  initializeDirectories,
  pathExists,
  readCatalog,
  readImmutableBlob,
  readImmutableSealed,
  replaceCatalog,
  storagePaths,
  withWriterLock,
  writeImmutableBlob,
  writeImmutableSealed,
} from "./private/storage.mjs";

const SCHEMA = Object.freeze({
  catalog: "se.bergbok.company-record.catalog",
  logItem: "se.bergbok.log-item",
  document: "se.bergbok.period-document",
  docset: "se.bergbok.docset",
  case: "se.bergbok.consolidation-case",
  run: "se.bergbok.consolidation-run",
  state: "se.bergbok.state-envelope",
  receipt: "se.bergbok.approval-receipt",
  upstream: "se.bergbok.upstream-result",
  event: "se.bergbok.company-record.event",
  outputSnapshot: "se.bergbok.output-snapshot",
  payrollFacts: "se.bergbok.bookkeeping.payroll-accounting-facts",
});

export class CompanyRecordError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "CompanyRecordError";
    this.code = code.startsWith("BERGBOK_") ? code : `BERGBOK_${code}`;
    this.details = details;
  }
}

/**
 * Create a new directory-backed Company Record.
 *
 * @param {{rootDir?: string, directory?: string, companyId: string,
 *   initialState?: {core?: object, domains?: object}, language?: "sv"|"en",
 *   actor?: object|string,
 *   clock?: Function}|string} options
 */
export async function create(options, additionalOptions = {}) {
  const normalized = normalizeOpenOptions(options, additionalOptions);
  requireText(normalized.companyId, "companyId");
  const rootDir = normalizeRoot(normalized.rootDir);
  const paths = storagePaths(rootDir);
  const clock = normalizeClock(normalized.clock);
  const language = normalizeLanguage(normalized.language, "language");
  await initializeDirectories(paths);

  await guard(async () =>
    withWriterLock(paths, async () => {
      if (await pathExists(paths.catalog)) {
        fail("ALREADY_EXISTS", `A Company Record already exists at ${rootDir}`);
      }

      const initial = normalizeInitialState(normalized.initialState);
      const state = createStateEnvelope({
        companyId: normalized.companyId,
        sequence: 0,
        core: initial.core,
        domains: initial.domains,
      });
      await writeImmutableSealed(paths, state);

      const catalog = initialCatalog(normalized.companyId, state.ref, language);
      const event = await appendEvent(paths, catalog, clock, "company.created", {
        actor: normalizeActor(normalized.actor),
        state_ref: state.ref,
        language,
      });
      const sealedCatalog = sealCatalog(catalog, 1);
      await replaceCatalog(paths, sealedCatalog);
      return event;
    }),
  );

  return buildFacade({ rootDir, paths, companyId: normalized.companyId, clock });
}

/** Open an existing Company Record and verify all current trusted heads. */
export async function open(options, additionalOptions = {}) {
  const normalized = normalizeOpenOptions(options, additionalOptions);
  const rootDir = normalizeRoot(normalized.rootDir);
  const paths = storagePaths(rootDir);
  const clock = normalizeClock(normalized.clock);

  const catalog = await guard(() => loadCatalog(paths, normalized.companyId));
  await guard(() => verifyCurrentHeads(paths, catalog.payload));
  return buildFacade({ rootDir, paths, companyId: catalog.payload.company_id, clock });
}

export const createCompanyRecord = create;
export const openCompanyRecord = open;

function buildFacade({ rootDir, paths, companyId, clock }) {
  return Object.freeze({
    companyId,
    rootDir,
    ingest: (item, actor) => guard(() => ingest(paths, companyId, clock, item, actor)),
    reviseDocset: (period, expectedHead, changes) =>
      guard(() => reviseDocset(paths, companyId, clock, period, expectedHead, changes)),
    prepare: (domain, period, options = {}) =>
      guard(() => prepare(paths, companyId, clock, domain, period, options)),
    setLanguage: (language, actor) => guard(() => setLanguage(paths, companyId, clock, language, actor)),
    record: (caseRef, outcome) => guard(() => record(paths, companyId, clock, caseRef, outcome)),
    approve: (runRef, decision = {}) =>
      guard(() => approve(paths, companyId, clock, runRef, decision)),
    read: (refOrQuery) => guard(() => read(paths, companyId, refOrQuery)),
  });
}

async function setLanguage(paths, companyId, clock, languageInput, actorInput) {
  const language = normalizeLanguage(languageInput, "language");
  return withWriterLock(paths, async () => {
    const catalogBundle = await loadCatalog(paths, companyId);
    const catalog = cloneJson(catalogBundle.payload);
    const previousLanguage = catalog.settings?.language ?? "sv";
    if (previousLanguage === language) {
      return freezeResult({ company_id: companyId, language, changed: false, event_ref: null });
    }
    catalog.settings = { ...(catalog.settings ?? {}), language };
    const event = await appendEvent(paths, catalog, clock, "company.language_changed", {
      actor: normalizeActor(actorInput),
      previous_language: previousLanguage,
      language,
    });
    await saveCatalog(paths, catalogBundle, catalog);
    return freezeResult({ company_id: companyId, language, changed: true, event_ref: event.ref });
  });
}

async function ingest(paths, companyId, clock, item, actor) {
  requireObject(item, "item");
  return withWriterLock(paths, async () => {
    const catalogBundle = await loadCatalog(paths, companyId);
    const catalog = cloneJson(catalogBundle.payload);
    const logItem = await createLogItem(paths, catalog, companyId, item, actor, clock);
    await appendEvent(paths, catalog, clock, "log-item.ingested", {
      actor: normalizeActor(actor),
      log_item_ref: logItem.ref,
      suggested_period: logItem.payload.suggested_period,
    });
    await saveCatalog(paths, catalogBundle, catalog);
    return freezeResult(logItem.ref);
  });
}

async function reviseDocset(paths, companyId, clock, periodInput, expectedHeadInput, changesInput) {
  const period = normalizePeriod(periodInput);
  const { operations, actor } = normalizeChanges(changesInput);
  if (operations.length === 0) fail("INVALID_ARGUMENT", "changes must contain at least one operation");

  return withWriterLock(paths, async () => {
    const catalogBundle = await loadCatalog(paths, companyId);
    const catalog = cloneJson(catalogBundle.payload);
    const periodRecord = ensureWritablePeriod(catalog, period);
    const current = await loadDocsetHead(paths, catalog, period.id);
    assertExpectedHead(current?.ref ?? null, expectedHeadInput, period.id);

    let documents = current ? cloneJson(current.payload.documents) : [];
    const addedDocuments = [];
    const removedDocumentIds = [];

    for (const operation of operations) {
      requireObject(operation, "docset change");
      const op = operation.op ?? operation.operation;
      if (op === "add") {
        const item = operation.item ?? operation.document ?? operation;
        const logItemRef = item.log_item_ref ?? item.logItemRef;
        if (!logItemRef) fail("INVALID_ARGUMENT", "add requires log_item_ref");
        const logItem = await readImmutableSealed(
          paths,
          normalizeRef(logItemRef, "log_item_ref"),
          "log item",
        );
        await validateLogItem(paths, logItem, companyId);
        const document = await createPeriodDocument(
          paths,
          catalog,
          companyId,
          period.id,
          logItem,
          item,
          actor,
          clock,
        );
        documents.push(documentEntry(document));
        addedDocuments.push(document);
      } else if (op === "copy") {
        const source = await resolveCopySource(paths, catalog, operation);
        const logItem = await readImmutableSealed(paths, source.payload.log_item_ref, "copied log item");
        await validateLogItem(paths, logItem, companyId);
        const document = await createPeriodDocument(paths, catalog, companyId, period.id, logItem, {
          filename: operation.filename ?? source.payload.filename,
          media_type: operation.media_type ?? operation.mediaType ?? source.payload.media_type,
          role: operation.role ?? source.payload.role,
          metadata: {
            ...cloneJson(source.payload.metadata ?? {}),
            ...cloneJson(operation.metadata ?? {}),
          },
          copied_from_document_ref: source.ref,
        }, actor, clock);
        documents.push(documentEntry(document));
        addedDocuments.push(document);
      } else if (op === "remove") {
        const documentId = operation.document_id ?? operation.documentId ?? operation.id;
        requireText(documentId, "remove.document_id");
        const before = documents.length;
        documents = documents.filter((entry) => entry.document_id !== documentId);
        if (documents.length === before) fail("NOT_FOUND", `Document ${documentId} is not in the docset`);
        removedDocumentIds.push(documentId);
      } else if (op === "update" || op === "set_role") {
        const documentId = operation.document_id ?? operation.documentId ?? operation.id;
        requireText(documentId, "update.document_id");
        const index = documents.findIndex((entry) => entry.document_id === documentId);
        if (index < 0) fail("NOT_FOUND", `Document ${documentId} is not in the docset`);
        const entry = documents[index];
        documents[index] = {
          ...entry,
          ...(operation.filename ? { filename: operation.filename } : {}),
          ...(operation.media_type || operation.mediaType
            ? { media_type: operation.media_type ?? operation.mediaType }
            : {}),
          ...(operation.role ? { role: operation.role } : {}),
          ...(operation.metadata
            ? { metadata: { ...cloneJson(entry.metadata ?? {}), ...cloneJson(operation.metadata) } }
            : {}),
        };
      } else {
        fail("INVALID_ARGUMENT", `Unknown docset change operation: ${op}`);
      }
    }

    assertUniqueDocumentIds(documents);
    const docset = await persistDocset(paths, companyId, periodRecord.period, current, documents, {
      actor,
      operation: "revise",
      operation_count: operations.length,
    }, clock);
    setDocsetHead(catalog, periodRecord, docset.ref);
    markWorking(periodRecord);
    await appendEvent(paths, catalog, clock, "docset.revised", {
      actor,
      period_id: period.id,
      previous_docset_ref: current?.ref ?? null,
      docset_ref: docset.ref,
      added_document_refs: addedDocuments.map((document) => document.ref),
      removed_document_ids: removedDocumentIds,
    });
    await saveCatalog(paths, catalogBundle, catalog);
    return freezeResult({
      docset,
      added_documents: addedDocuments,
      removed_document_ids: removedDocumentIds,
      period_status: periodRecord.status,
    });
  });
}

async function prepare(paths, companyId, clock, domain, periodInput, options) {
  requireText(domain, "domain");
  requireObject(options, "options");
  const period = normalizePeriod(periodInput);

  return withWriterLock(paths, async () => {
    const catalogBundle = await loadCatalog(paths, companyId);
    const catalog = cloneJson(catalogBundle.payload);
    const periodRecord = ensureWritablePeriod(catalog, period);

    let docset = await loadDocsetHead(paths, catalog, period.id);
    if (!docset) {
      docset = await persistDocset(paths, companyId, periodRecord.period, null, [], {
        actor: normalizeActor(options.actor),
        operation: "initialize-empty",
      }, clock, 0);
      setDocsetHead(catalog, periodRecord, docset.ref);
    }
    if (options.expectedDocsetHead !== undefined || options.expected_docset_head !== undefined) {
      assertExpectedHead(
        docset.ref,
        options.expectedDocsetHead ?? options.expected_docset_head,
        period.id,
      );
    }
    await validateDocset(paths, docset, companyId, period.id);

    const previousState = await readImmutableSealed(paths, catalog.state_head, "current State");
    validateState(previousState, companyId);
    if (options.expectedStateRef || options.expected_state_ref) {
      const expectedState = normalizeRef(options.expectedStateRef ?? options.expected_state_ref, "expected State");
      if (!sameRef(expectedState, previousState.ref)) {
        fail("STALE_STATE", "The current State differs from the expected State", {
          expected_ref: expectedState,
          actual_ref: previousState.ref,
        });
      }
    }

    const requestedUpstreams = options.upstreamRefs ?? options.upstream_refs ?? [];
    if (!Array.isArray(requestedUpstreams)) fail("INVALID_ARGUMENT", "upstreamRefs must be an array");
    const upstreamResults = [];
    const seenUpstreams = new Set();
    for (const candidate of requestedUpstreams) {
      const ref = normalizeRef(candidate, "upstream reference");
      if (seenUpstreams.has(contentRefKey(ref))) continue;
      const wrapper = await readImmutableSealed(paths, ref, "approved upstream result");
      await validateApprovedUpstream(paths, catalog, wrapper, companyId, period.id, true);
      upstreamResults.push(wrapper);
      seenUpstreams.add(contentRefKey(ref));
    }
    upstreamResults.sort((left, right) => contentRefKey(left.ref).localeCompare(contentRefKey(right.ref)));

    const upstreamSnapshot = await currentUpstreamSnapshot(paths, catalog, companyId, period.id);
    const stableId = `${companyId}:${period.id}:${domain}:case`;
    const version = nextNamedVersion(catalog.versions.case, stableId);
    const caseBundle = sealContent({
      schemaId: SCHEMA.case,
      stableId,
      version,
      payload: {
        contract_version: CONTRACT_VERSION,
        company_id: companyId,
        domain,
        language: catalog.settings?.language ?? "sv",
        period: cloneJson(periodRecord.period),
        docset,
        previous_state: previousState,
        upstream_results: upstreamResults,
        upstream_snapshot: upstreamSnapshot,
        effective_policies: cloneJson(options.effectivePolicies ?? options.effective_policies ?? {}),
        context: cloneJson(options.context ?? {}),
        prepared_by: normalizeActor(options.actor),
        prepared_at: now(clock),
      },
    });
    assertConsolidationCase(caseBundle);
    await writeImmutableSealed(paths, caseBundle);

    periodRecord.case_heads[domain] = caseBundle.ref;
    periodRecord.status = "preliminary";
    await appendEvent(paths, catalog, clock, "case.prepared", {
      actor: normalizeActor(options.actor),
      period_id: period.id,
      domain,
      language: catalog.settings?.language ?? "sv",
      case_ref: caseBundle.ref,
      docset_ref: docset.ref,
      previous_state_ref: previousState.ref,
      upstream_refs: upstreamResults.map((item) => item.ref),
    });
    await saveCatalog(paths, catalogBundle, catalog);
    return freezeResult(caseBundle);
  });
}

async function record(paths, companyId, clock, caseRefInput, outcomeInput) {
  const caseRef = normalizeRef(caseRefInput, "caseRef");
  return withWriterLock(paths, async () => {
    const catalogBundle = await loadCatalog(paths, companyId);
    const catalog = cloneJson(catalogBundle.payload);
    const caseBundle = await readImmutableSealed(paths, caseRef, "ConsolidationCase");
    await validateCase(paths, caseBundle, companyId);

    const outcome = cloneJson(outcomeInput);
    try {
      assertModuleOutcome(outcome, { caseRef: caseBundle.ref, domain: caseBundle.payload.domain });
    } catch (error) {
      throw fromContractError(error);
    }
    const outcomeSha256 = sha256Json(outcome);
    const stableId = `${companyId}:${caseBundle.payload.period.id}:${caseBundle.payload.domain}:run`;
    const version = nextNamedVersion(catalog.versions.run, stableId);
    const run = sealContent({
      schemaId: SCHEMA.run,
      stableId,
      version,
      payload: {
        contract_version: CONTRACT_VERSION,
        company_id: companyId,
        period_id: caseBundle.payload.period.id,
        domain: caseBundle.payload.domain,
        case_ref: caseBundle.ref,
        outcome,
        outcome_sha256: outcomeSha256,
        proposal_digest: outcome.kind === "proposal" ? proposalDigest(outcome) : null,
        recorded_at: now(clock),
      },
    });
    await writeImmutableSealed(paths, run);
    catalog.run_refs.push(run.ref);

    const periodRecord = ensurePeriod(catalog, caseBundle.payload.period);
    if (periodRecord.status !== "closed") periodRecord.status = "preliminary";
    await appendEvent(paths, catalog, clock, "run.recorded", {
      period_id: caseBundle.payload.period.id,
      domain: caseBundle.payload.domain,
      case_ref: caseBundle.ref,
      run_ref: run.ref,
      outcome_kind: outcome.kind,
      outcome_sha256: outcomeSha256,
    });
    await saveCatalog(paths, catalogBundle, catalog);
    return freezeResult(run);
  });
}

async function approve(paths, companyId, clock, runRefInput, decisionInput) {
  const runRef = normalizeRef(runRefInput, "runRef");
  const decision = normalizeDecision(decisionInput);
  return withWriterLock(paths, async () => {
    const catalogBundle = await loadCatalog(paths, companyId);
    const catalog = cloneJson(catalogBundle.payload);
    const run = await readImmutableSealed(paths, runRef, "ConsolidationRun");
    await validateRun(paths, run, companyId);
    if (decision.expected_run_sha256 && decision.expected_run_sha256 !== run.ref.sha256) {
      fail("INTEGRITY_ERROR", "The approval decision names a different complete run hash", {
        expected_sha256: decision.expected_run_sha256,
        actual_sha256: run.ref.sha256,
      });
    }
    const caseBundle = await readImmutableSealed(paths, run.payload.case_ref, "ConsolidationCase");
    await validateCase(paths, caseBundle, companyId);
    const periodRecord = ensurePeriod(catalog, caseBundle.payload.period);
    if (periodRecord.status === "closed") fail("PERIOD_CLOSED", `Period ${caseBundle.payload.period.id} is closed`);
    if (catalog.approval_by_run[contentRefKey(run.ref)]) {
      fail("ALREADY_APPROVED", "This run already has an approval receipt", { run_ref: run.ref });
    }

    if (!decision.approved) {
      const receipt = await createReceipt(paths, catalog, companyId, clock, run, caseBundle, decision, null);
      catalog.approval_by_run[contentRefKey(run.ref)] = receipt.ref;
      periodRecord.status = "working";
      await appendEvent(paths, catalog, clock, "run.rejected", {
        actor: decision.actor,
        period_id: run.payload.period_id,
        domain: run.payload.domain,
        run_ref: run.ref,
        receipt_ref: receipt.ref,
      });
      await saveCatalog(paths, catalogBundle, catalog);
      return freezeResult({ receipt, state: null, upstream_result: null, output_snapshot: null });
    }

    if (run.payload.outcome.kind !== "proposal") {
      fail("NOT_APPROVABLE", `A ${run.payload.outcome.kind} outcome cannot be approved`);
    }
    await assertCaseIsCurrent(paths, catalog, caseBundle, run);
    const currentState = await readImmutableSealed(paths, catalog.state_head, "current State");
    const domainState = unpackProjectedDomainState(run.payload.outcome.projected_state, {
      domain: run.payload.domain,
      companyId,
      periodId: run.payload.period_id,
      previousState: currentState,
    });
    const nextCore = approvedCoreState(
      run.payload.outcome,
      currentState,
      run.payload.domain,
      caseBundle.payload.period.kind,
    );
    const nextState = createStateEnvelope({
      companyId,
      sequence: currentState.payload.sequence + 1,
      core: nextCore,
      domains: {
        ...cloneJson(currentState.payload.domains),
        [run.payload.domain]: domainState,
      },
      precedingStateRef: currentState.ref,
    });
    await writeImmutableSealed(paths, nextState);

    const receipt = await createReceipt(paths, catalog, companyId, clock, run, caseBundle, decision, nextState.ref);
    const outputSnapshot = createOutputSnapshot(run, receipt.ref, "approved");
    await writeImmutableSealed(paths, outputSnapshot);

    let upstreamResult = null;
    if (run.payload.domain === "payroll") {
      const facts = run.payload.outcome.canonical_outputs?.payroll_accounting_facts;
      if (facts !== undefined) {
        upstreamResult = await createPayrollUpstream(
          paths,
          catalog,
          companyId,
          run.payload.period_id,
          run,
          receipt,
          facts,
        );
      }
    }

    catalog.state_head = nextState.ref;
    catalog.state_refs.push(nextState.ref);
    catalog.approval_by_run[contentRefKey(run.ref)] = receipt.ref;
    catalog.output_snapshots[contentRefKey(run.ref)] = outputSnapshot.ref;
    periodRecord.approval_heads[run.payload.domain] = receipt.ref;
    periodRecord.approved_runs[run.payload.domain] = run.ref;
    periodRecord.approved_state_ref = nextState.ref;
    periodRecord.status = decision.close ? "closed" : "approved";

    await appendEvent(paths, catalog, clock, "run.approved", {
      actor: decision.actor,
      period_id: run.payload.period_id,
      domain: run.payload.domain,
      run_ref: run.ref,
      receipt_ref: receipt.ref,
      state_ref: nextState.ref,
      output_snapshot_ref: outputSnapshot.ref,
      upstream_result_ref: upstreamResult?.ref ?? null,
      period_status: periodRecord.status,
    });
    await saveCatalog(paths, catalogBundle, catalog);
    return freezeResult({
      receipt,
      state: nextState,
      upstream_result: upstreamResult,
      output_snapshot: outputSnapshot,
    });
  });
}

async function read(paths, companyId, refOrQuery) {
  const catalogBundle = await loadCatalog(paths, companyId);
  const catalog = catalogBundle.payload;
  if (looksLikeRef(refOrQuery) || looksLikeSealed(refOrQuery)) {
    const ref = normalizeRef(refOrQuery, "reference");
    const sealed = await readImmutableSealed(paths, ref);
    await validateBySchema(paths, catalog, sealed, companyId);
    return freezeResult(sealed);
  }
  if (typeof refOrQuery === "string") {
    if (refOrQuery === "timeline" || refOrQuery === "timeline.json") {
      return readTimeline(paths, catalog, { format: "json" });
    }
    if (refOrQuery === "timeline.md") return readTimeline(paths, catalog, { format: "markdown" });
    fail("INVALID_ARGUMENT", `Unknown read query: ${refOrQuery}`);
  }
  requireObject(refOrQuery, "read query");
  if (refOrQuery.ref) return read(paths, companyId, refOrQuery.ref);
  const kind = refOrQuery.kind ?? refOrQuery.type;
  if (kind === "timeline") return readTimeline(paths, catalog, refOrQuery);
  if (kind === "state" || kind === "state_head") {
    const state = await readImmutableSealed(paths, catalog.state_head, "current State");
    validateState(state, companyId);
    return freezeResult(state);
  }
  if (kind === "company_settings") {
    return freezeResult({
      company_id: companyId,
      language: catalog.settings?.language ?? "sv",
    });
  }
  if (kind === "period") {
    const period = normalizePeriod(refOrQuery.period ?? refOrQuery.period_id);
    const value = catalog.periods[period.id];
    if (!value) fail("NOT_FOUND", `Period ${period.id} does not exist`);
    return freezeResult(value);
  }
  if (kind === "docset" || kind === "docset_head") {
    const period = normalizePeriod(refOrQuery.period ?? refOrQuery.period_id);
    const docset = await loadDocsetHead(paths, catalog, period.id);
    if (!docset) return null;
    await validateDocset(paths, docset, companyId, period.id);
    return freezeResult(docset);
  }
  if (kind === "document") {
    const id = refOrQuery.documentId ?? refOrQuery.document_id ?? refOrQuery.id;
    requireText(id, "document id");
    const ref = catalog.document_refs[id];
    if (!ref) fail("NOT_FOUND", `Document ${id} does not exist`);
    const document = await readImmutableSealed(paths, ref, "original document");
    await validateDocument(paths, document, companyId);
    return freezeResult(document);
  }
  if (kind === "log_item") {
    const id = refOrQuery.logItemId ?? refOrQuery.log_item_id ?? refOrQuery.id;
    requireText(id, "log item id");
    const ref = catalog.log_item_refs[id];
    if (!ref) fail("NOT_FOUND", `Log item ${id} does not exist`);
    const logItem = await readImmutableSealed(paths, ref, "log item");
    await validateLogItem(paths, logItem, companyId);
    return freezeResult(logItem);
  }
  if (kind === "upstream" || kind === "upstream_result") {
    let ref;
    if (refOrQuery.upstreamRef ?? refOrQuery.upstream_ref) {
      ref = normalizeRef(refOrQuery.upstreamRef ?? refOrQuery.upstream_ref, "upstream reference");
    } else if (refOrQuery.stableId ?? refOrQuery.stable_id) {
      ref = catalog.upstream_heads[refOrQuery.stableId ?? refOrQuery.stable_id];
    } else {
      const period = normalizePeriod(refOrQuery.period ?? refOrQuery.period_id);
      ref = catalog.upstream_heads[payrollUpstreamStableId(companyId, period.id)];
    }
    if (!ref) fail("NOT_FOUND", "Approved upstream result does not exist");
    const wrapper = await readImmutableSealed(paths, ref, "approved upstream result");
    await validateApprovedUpstream(paths, catalog, wrapper, companyId, wrapper.payload.period_id, false);
    return freezeResult(wrapper);
  }
  if (kind === "output_snapshot") {
    const runRef = normalizeRef(refOrQuery.runRef ?? refOrQuery.run_ref, "runRef");
    const run = await readImmutableSealed(paths, runRef, "ConsolidationRun");
    await validateRun(paths, run, companyId);
    const approvedRef = catalog.output_snapshots[contentRefKey(run.ref)];
    if (approvedRef) {
      const snapshot = await readImmutableSealed(paths, approvedRef, "approved output snapshot");
      validateOutputSnapshot(snapshot, run, "approved");
      return freezeResult(snapshot);
    }
    return freezeResult(createOutputSnapshot(run, null, "preliminary"));
  }
  fail("INVALID_ARGUMENT", `Unknown read query kind: ${kind}`);
}

async function createLogItem(paths, catalog, companyId, item, actorInput, clock) {
  requireObject(item, "document item");
  const bytes = documentBytes(item);
  const filename = item.filename ?? item.name;
  const mediaType = item.media_type ?? item.mediaType ?? "application/octet-stream";
  requireText(filename, "document filename");
  requireText(mediaType, "document media type");

  const storedBlob = await writeImmutableBlob(paths, bytes);
  const number = catalog.next.log_item++;
  const stableId = `${companyId}:log:${String(number).padStart(6, "0")}`;
  const suggestedPeriodInput = item.suggested_period ?? item.suggestedPeriod ?? item.period ?? item.period_id ?? null;
  const suggestedPeriod = suggestedPeriodInput === null ? null : normalizePeriod(suggestedPeriodInput);
  const logItem = sealContent({
    schemaId: SCHEMA.logItem,
    stableId,
    version: 1,
    payload: {
      contract_version: CONTRACT_VERSION,
      company_id: companyId,
      log_item_id: stableId,
      filename,
      media_type: mediaType,
      sha256: storedBlob.sha256,
      byte_length: storedBlob.byte_length,
      content_base64: bytes.toString("base64"),
      metadata: cloneJson(item.metadata ?? {}),
      suggested_period: suggestedPeriod,
      received_by: normalizeActor(actorInput),
      received_at: now(clock),
    },
  });
  await writeImmutableSealed(paths, logItem);
  catalog.log_item_refs[stableId] = logItem.ref;
  return logItem;
}

async function createPeriodDocument(
  paths,
  catalog,
  companyId,
  periodId,
  logItem,
  item,
  actorInput,
  clock,
) {
  const number = catalog.next.document++;
  const stableId = `${companyId}:document:${String(number).padStart(6, "0")}`;
  const filename = item.filename ?? logItem.payload.filename;
  const mediaType = item.media_type ?? item.mediaType ?? logItem.payload.media_type;
  const role = item.role;
  requireText(filename, "period document filename");
  requireText(mediaType, "period document media type");
  requireText(role, "period document role");
  const copiedFrom = item.copied_from_document_ref
    ? normalizeRef(item.copied_from_document_ref, "copied_from_document_ref")
    : null;
  const document = sealContent({
    schemaId: SCHEMA.document,
    stableId,
    version: 1,
    payload: {
      contract_version: CONTRACT_VERSION,
      company_id: companyId,
      document_id: stableId,
      period_id: periodId,
      log_item_ref: logItem.ref,
      filename,
      media_type: mediaType,
      role,
      sha256: logItem.payload.sha256,
      byte_length: logItem.payload.byte_length,
      content_base64: logItem.payload.content_base64,
      metadata: {
        ...cloneJson(logItem.payload.metadata ?? {}),
        ...cloneJson(item.metadata ?? {}),
      },
      copied_from_document_ref: copiedFrom,
      assigned_by: normalizeActor(actorInput),
      assigned_at: now(clock),
    },
  });
  await writeImmutableSealed(paths, document);
  catalog.document_refs[stableId] = document.ref;
  return document;
}

function documentEntry(document) {
  const value = document.payload;
  return cloneJson({
    document_id: value.document_id,
    document_ref: document.ref,
    log_item_ref: value.log_item_ref,
    filename: value.filename,
    media_type: value.media_type,
    sha256: value.sha256,
    byte_length: value.byte_length,
    role: value.role,
    metadata: value.metadata,
    copied_from_document_ref: value.copied_from_document_ref,
    content_base64: value.content_base64,
  });
}

async function persistDocset(
  paths,
  companyId,
  period,
  previous,
  documents,
  change,
  clock,
  forcedVersion,
) {
  const version = forcedVersion ?? (previous ? Number(previous.ref.version) + 1 : 1);
  const docset = sealContent({
    schemaId: SCHEMA.docset,
    stableId: `${companyId}:${period.id}:docset`,
    version,
    payload: {
      contract_version: CONTRACT_VERSION,
      company_id: companyId,
      period: cloneJson(period),
      previous_docset_ref: previous?.ref ?? null,
      documents: cloneJson(documents),
      change: cloneJson(change),
      created_at: now(clock),
    },
  });
  await validateDocset(paths, docset, companyId, period.id);
  await writeImmutableSealed(paths, docset);
  return docset;
}

async function resolveCopySource(paths, catalog, operation) {
  const direct = operation.sourceRef ?? operation.source_ref ?? operation.documentRef ?? operation.document_ref ?? operation.from;
  if (direct && (looksLikeRef(direct) || looksLikeSealed(direct))) {
    const ref = normalizeRef(direct, "copy source document");
    const document = await readImmutableSealed(paths, ref, "copy source document");
    await validateDocument(paths, document, catalog.company_id);
    return document;
  }

  const sourcePeriodValue = operation.fromPeriod ?? operation.from_period;
  const documentId = operation.documentId ?? operation.document_id ?? operation.id;
  if (sourcePeriodValue && documentId) {
    const sourcePeriod = normalizePeriod(sourcePeriodValue);
    const docset = await loadDocsetHead(paths, catalog, sourcePeriod.id);
    if (!docset) fail("NOT_FOUND", `Source period ${sourcePeriod.id} has no docset`);
    const entry = docset.payload.documents.find((candidate) => candidate.document_id === documentId);
    if (!entry) fail("NOT_FOUND", `Document ${documentId} is not in source period ${sourcePeriod.id}`);
    const document = await readImmutableSealed(paths, entry.document_ref, "copy source document");
    await validateDocument(paths, document, catalog.company_id);
    return document;
  }
  fail("INVALID_ARGUMENT", "copy requires sourceRef or both fromPeriod and documentId");
}

async function createReceipt(paths, catalog, companyId, clock, run, caseBundle, decision, stateRef) {
  const version = catalog.next.receipt++;
  const timestamp = now(clock);
  const approvalScope = {
    company_id: companyId,
    period_id: run.payload.period_id,
    domain: run.payload.domain,
    case_ref: caseBundle.ref,
    run_ref: run.ref,
    proposed_changes: cloneJson(run.payload.outcome.proposed_changes),
  };
  const receipt = sealContent({
    schemaId: SCHEMA.receipt,
    stableId: `${companyId}:approval`,
    version,
    payload: {
      contract_version: CONTRACT_VERSION,
      company_id: companyId,
      period_id: run.payload.period_id,
      domain: run.payload.domain,
      decision: decision.approved ? "approved" : "rejected",
      actor: decision.actor,
      authority: decision.authority,
      approval_scope: approvalScope,
      note: decision.note,
      timestamp,
      decided_at: timestamp,
      run_ref: run.ref,
      complete_run_sha256: run.ref.sha256,
      case_ref: caseBundle.ref,
      outcome_sha256: run.payload.outcome_sha256,
      proposal_digest: run.payload.proposal_digest,
      exact_inputs: {
        docset_ref: caseBundle.payload.docset.ref,
        previous_state_ref: caseBundle.payload.previous_state.ref,
        upstream_refs: caseBundle.payload.upstream_results.map((item) => item.ref),
      },
      resulting_state_ref: stateRef,
      published_state_ref: stateRef,
    },
  });
  await writeImmutableSealed(paths, receipt);
  catalog.receipt_refs.push(receipt.ref);
  return receipt;
}

async function createPayrollUpstream(paths, catalog, companyId, periodId, run, receipt, facts) {
  try {
    verifySealedContent(facts, "payroll accounting facts");
  } catch (error) {
    throw fromContractError(error);
  }
  if (facts.ref.schema_id !== SCHEMA.payrollFacts) {
    fail("INVALID_UPSTREAM", `Expected ${SCHEMA.payrollFacts}, received ${facts.ref.schema_id}`);
  }
  if (facts.payload.company_id !== companyId || facts.payload.period_id !== periodId) {
    fail("INVALID_UPSTREAM", "Payroll accounting facts belong to a different company or period");
  }
  if (facts.payload.status !== "proposed") {
    fail("INVALID_UPSTREAM", "Payroll accounting facts must have proposed status before approval");
  }

  const stableId = payrollUpstreamStableId(companyId, periodId);
  const currentRef = catalog.upstream_heads[stableId];
  const version = currentRef ? Number(currentRef.version) + 1 : 1;
  const wrapper = sealContent({
    schemaId: SCHEMA.upstream,
    stableId,
    version,
    payload: {
      contract_version: CONTRACT_VERSION,
      status: "approved",
      trust: "approved_internal",
      company_id: companyId,
      period_id: periodId,
      source_domain: "payroll",
      source_run_ref: run.ref,
      approval_receipt_ref: receipt.ref,
      output: facts,
    },
  });
  await writeImmutableSealed(paths, wrapper);
  catalog.upstream_heads[stableId] = wrapper.ref;
  return wrapper;
}

function createOutputSnapshot(run, receiptRef, approvalStatus) {
  const version = approvalStatus === "approved" ? `approved:${receiptRef.sha256}` : "preliminary";
  const review = cloneJson(run.payload.outcome.review ?? {});
  return sealContent({
    schemaId: SCHEMA.outputSnapshot,
    stableId: `${run.ref.stable_id}:output-snapshot:${run.ref.sha256}`,
    version,
    payload: {
      contract_version: CONTRACT_VERSION,
      approval_status: approvalStatus,
      language: review.language ?? "sv",
      run_ref: run.ref,
      approval_receipt_ref: receiptRef,
      proposal_digest: run.payload.proposal_digest,
      canonical_outputs: cloneJson(run.payload.outcome.canonical_outputs),
      review,
    },
  });
}

async function assertCaseIsCurrent(paths, catalog, caseBundle, run) {
  const periodId = caseBundle.payload.period.id;
  const domain = caseBundle.payload.domain;
  const periodRecord = catalog.periods[periodId];
  const currentDocset = catalog.docset_heads[periodId] ?? null;
  if (!sameNullableRef(currentDocset, caseBundle.payload.docset.ref)) {
    fail("STALE_DOCSET", "The docset changed after this case was prepared", {
      case_docset_ref: caseBundle.payload.docset.ref,
      current_docset_ref: currentDocset,
    });
  }
  if (!sameNullableRef(periodRecord?.case_heads?.[domain] ?? null, caseBundle.ref)) {
    fail("STALE_CASE", "A newer case has superseded this run", {
      run_ref: run.ref,
      case_ref: caseBundle.ref,
      current_case_ref: periodRecord?.case_heads?.[domain] ?? null,
    });
  }
  const actualSnapshot = await currentUpstreamSnapshot(paths, catalog, catalog.company_id, periodId);
  const expectedSnapshot = caseBundle.payload.upstream_snapshot ?? [];
  if (canonicalStringify(actualSnapshot) !== canonicalStringify(expectedSnapshot)) {
    fail("STALE_UPSTREAM", "Approved upstream results changed after this case was prepared", {
      case_upstream_snapshot: expectedSnapshot,
      current_upstream_snapshot: actualSnapshot,
    });
  }
  for (const wrapper of caseBundle.payload.upstream_results) {
    await validateApprovedUpstream(paths, catalog, wrapper, catalog.company_id, periodId, true);
  }
  if (!sameRef(catalog.state_head, caseBundle.payload.previous_state.ref)) {
    fail("STALE_STATE", "The preceding State changed after this case was prepared", {
      case_state_ref: caseBundle.payload.previous_state.ref,
      current_state_ref: catalog.state_head,
    });
  }
}

async function validateCase(paths, caseBundle, companyId) {
  try {
    assertConsolidationCase(caseBundle);
  } catch (error) {
    throw fromContractError(error);
  }
  if (caseBundle.ref.schema_id !== SCHEMA.case || caseBundle.payload.company_id !== companyId) {
    fail("INTEGRITY_ERROR", "ConsolidationCase belongs to a different Company Record");
  }
  const storedDocset = await requireEmbeddedMatch(paths, caseBundle.payload.docset, "case docset");
  await validateDocset(paths, storedDocset, companyId, caseBundle.payload.period.id);
  const storedState = await requireEmbeddedMatch(paths, caseBundle.payload.previous_state, "case previous State");
  validateState(storedState, companyId);
  for (const wrapper of caseBundle.payload.upstream_results) {
    await requireEmbeddedMatch(paths, wrapper, "case upstream result");
  }
  if (!Array.isArray(caseBundle.payload.upstream_snapshot ?? [])) {
    fail("INTEGRITY_ERROR", "ConsolidationCase upstream_snapshot must be an array");
  }
}

async function validateRun(paths, run, companyId) {
  verifySchema(run, SCHEMA.run, "ConsolidationRun");
  if (run.payload.company_id !== companyId) fail("INTEGRITY_ERROR", "Run belongs to a different company");
  const actualOutcomeHash = sha256Json(run.payload.outcome);
  if (actualOutcomeHash !== run.payload.outcome_sha256) {
    fail("INTEGRITY_ERROR", "Run does not bind the complete ModuleOutcome", {
      expected_sha256: run.payload.outcome_sha256,
      actual_sha256: actualOutcomeHash,
    });
  }
  const caseBundle = await readImmutableSealed(paths, run.payload.case_ref, "run case");
  await validateCase(paths, caseBundle, companyId);
  try {
    assertModuleOutcome(run.payload.outcome, {
      caseRef: caseBundle.ref,
      domain: caseBundle.payload.domain,
    });
  } catch (error) {
    throw fromContractError(error);
  }
  if (run.payload.period_id !== caseBundle.payload.period.id || run.payload.domain !== caseBundle.payload.domain) {
    fail("INTEGRITY_ERROR", "Run metadata differs from its case");
  }
  const expectedProposalDigest = run.payload.outcome.kind === "proposal"
    ? proposalDigest(run.payload.outcome)
    : null;
  if (run.payload.proposal_digest !== expectedProposalDigest) {
    fail("INTEGRITY_ERROR", "Run proposal digest is invalid");
  }
}

async function validateApprovedUpstream(paths, catalog, wrapper, companyId, periodId, requireCurrent) {
  verifySchema(wrapper, SCHEMA.upstream, "approved upstream result");
  const value = wrapper.payload;
  if (
    value.contract_version !== CONTRACT_VERSION ||
    value.status !== "approved" ||
    value.trust !== "approved_internal" ||
    value.company_id !== companyId ||
    value.period_id !== periodId
  ) {
    fail("INVALID_UPSTREAM", "Upstream result is not a trusted approval for this company and period");
  }
  if (requireCurrent && !sameNullableRef(catalog.upstream_heads[wrapper.ref.stable_id] ?? null, wrapper.ref)) {
    fail("STALE_UPSTREAM", "A newer approved upstream result exists", {
      supplied_ref: wrapper.ref,
      current_ref: catalog.upstream_heads[wrapper.ref.stable_id] ?? null,
    });
  }
  try {
    verifySealedContent(value.output, "approved upstream output");
  } catch (error) {
    throw fromContractError(error);
  }
  const storedRun = await readImmutableSealed(paths, value.source_run_ref, "upstream source run");
  await validateRun(paths, storedRun, companyId);
  const receipt = await readImmutableSealed(paths, value.approval_receipt_ref, "upstream approval receipt");
  validateReceipt(receipt, companyId);
  if (
    receipt.payload.decision !== "approved" ||
    !sameRef(receipt.payload.run_ref, storedRun.ref) ||
    receipt.payload.period_id !== periodId ||
    receipt.payload.domain !== value.source_domain
  ) {
    fail("INVALID_UPSTREAM", "Upstream approval evidence does not bind its source run");
  }
  const facts = storedRun.payload.outcome.canonical_outputs?.payroll_accounting_facts;
  if (!facts || canonicalStringify(facts) !== canonicalStringify(value.output)) {
    fail("INVALID_UPSTREAM", "Upstream output differs from the output approved in its source run");
  }
}

async function currentUpstreamSnapshot(paths, catalog, companyId, periodId) {
  const refs = [];
  for (const ref of Object.values(catalog.upstream_heads)) {
    const wrapper = await readImmutableSealed(paths, ref, "current upstream result");
    if (wrapper.payload.company_id === companyId && wrapper.payload.period_id === periodId) {
      await validateApprovedUpstream(paths, catalog, wrapper, companyId, periodId, true);
      refs.push(wrapper.ref);
    }
  }
  return refs.sort((left, right) => contentRefKey(left).localeCompare(contentRefKey(right)));
}

function unpackProjectedDomainState(projectedInput, { domain, companyId, periodId }) {
  if (!looksLikeSealed(projectedInput)) {
    fail("INVALID_STATE", "projected_state must be a sealed domain-State bundle");
  }
  const projected = cloneJson(projectedInput);
  try {
    verifySealedContent(projected, "projected domain State");
  } catch (error) {
    throw fromContractError(error);
  }
  const expectedSchema = `se.bergbok.${domain}.state`;
  if (projected.ref.schema_id !== expectedSchema) {
    fail("INVALID_STATE", `Projected ${domain} State must use schema ${expectedSchema}`);
  }
  if (projected.payload.contract_version !== CONTRACT_VERSION) {
    fail("INVALID_STATE", "Projected domain State has an unsupported contract version");
  }
  if (projected.payload.company_id !== companyId) {
    fail("INVALID_STATE", "Projected domain State belongs to a different company");
  }
  const projectedPeriod = projected.payload.period_id ?? projected.payload.through_period_id;
  if (projectedPeriod !== undefined && projectedPeriod !== periodId) {
    fail("INVALID_STATE", "Projected domain State belongs to a different period");
  }
  return cloneJson(projected.payload);
}

function approvedCoreState(outcome, currentState, domain, periodKind) {
  const changes = outcome.proposed_changes ?? [];
  const coreChanges = changes.filter((change) => change?.action === "initialize_core_state");
  if (coreChanges.length > 1) fail("INVALID_PROPOSAL", "Proposal contains more than one core-State initialization");
  if (coreChanges.length === 0) return cloneJson(currentState.payload.core);
  if (domain !== "bookkeeping" || !["start", "import"].includes(periodKind)
      || currentState.payload.sequence !== 0
      || Object.keys(currentState.payload.core ?? {}).length > 0) {
    fail("INVALID_PROPOSAL", "Core State may only be initialized by a first Bookkeeping Start or Import approval");
  }
  const core = coreChanges[0].core;
  requireObject(core, "initialize_core_state.core");
  requireText(core.organization?.name, "initialize_core_state.core.organization.name");
  requireText(core.organization?.organization_number, "initialize_core_state.core.organization.organization_number");
  if (!/^\d{6}-\d{4}$/.test(core.organization.organization_number)) {
    fail("INVALID_PROPOSAL", "Initial organization number must use xxxxxx-xxxx");
  }
  if (!Array.isArray(core.enabled_modules) || !core.enabled_modules.includes("bookkeeping")) {
    fail("INVALID_PROPOSAL", "Initial core State must enable Bookkeeping");
  }
  return cloneJson(core);
}

async function validateDocset(paths, docset, companyId, periodId) {
  verifySchema(docset, SCHEMA.docset, "docset");
  if (docset.payload.company_id !== companyId || docset.payload.period?.id !== periodId) {
    fail("INTEGRITY_ERROR", "Docset belongs to a different company or period");
  }
  if (!Array.isArray(docset.payload.documents)) fail("INTEGRITY_ERROR", "Docset documents must be an array");
  assertUniqueDocumentIds(docset.payload.documents);
  for (const entry of docset.payload.documents) {
    requireText(entry.document_id, "docset document_id");
    requireText(entry.filename, "docset filename");
    requireText(entry.media_type, "docset media_type");
    requireText(entry.role, "docset role");
    requireDigest(entry.sha256, "docset document sha256");
    requireText(entry.content_base64, "docset content_base64");
    const bytes = decodeCanonicalBase64(entry.content_base64);
    if (sha256Bytes(bytes) !== entry.sha256 || bytes.length !== entry.byte_length) {
      fail("INTEGRITY_ERROR", `Portable bytes for ${entry.document_id} failed integrity validation`);
    }
    const document = await readImmutableSealed(paths, entry.document_ref, "docset original document");
    await validateDocument(paths, document, companyId);
    if (
      document.payload.document_id !== entry.document_id ||
      document.payload.sha256 !== entry.sha256 ||
      document.payload.byte_length !== entry.byte_length ||
      document.payload.content_base64 !== entry.content_base64
    ) {
      fail("INTEGRITY_ERROR", `Docset entry ${entry.document_id} differs from its original document`);
    }
  }
}

async function validateDocument(paths, document, companyId) {
  verifySchema(document, SCHEMA.document, "period document");
  if (document.payload.company_id !== companyId || document.payload.document_id !== document.ref.stable_id) {
    fail("INTEGRITY_ERROR", "Period document identity is invalid");
  }
  const bytes = decodeCanonicalBase64(document.payload.content_base64);
  if (sha256Bytes(bytes) !== document.payload.sha256 || bytes.length !== document.payload.byte_length) {
    fail("INTEGRITY_ERROR", "Period document metadata does not match its bytes");
  }
  const logItem = await readImmutableSealed(paths, document.payload.log_item_ref, "period document log item");
  await validateLogItem(paths, logItem, companyId);
  if (
    logItem.payload.sha256 !== document.payload.sha256 ||
    logItem.payload.byte_length !== document.payload.byte_length ||
    logItem.payload.content_base64 !== document.payload.content_base64
  ) {
    fail("INTEGRITY_ERROR", "Period document differs from its immutable Log item");
  }
}

async function validateLogItem(paths, logItem, companyId) {
  verifySchema(logItem, SCHEMA.logItem, "Log item");
  if (logItem.payload.company_id !== companyId || logItem.payload.log_item_id !== logItem.ref.stable_id) {
    fail("INTEGRITY_ERROR", "Log item identity is invalid");
  }
  const bytes = decodeCanonicalBase64(logItem.payload.content_base64);
  if (sha256Bytes(bytes) !== logItem.payload.sha256 || bytes.length !== logItem.payload.byte_length) {
    fail("INTEGRITY_ERROR", "Log item metadata does not match its original bytes");
  }
  const stored = await readImmutableBlob(paths, logItem.payload.sha256);
  if (!stored.equals(bytes)) fail("INTEGRITY_ERROR", "Original byte object differs from its Log item");
}

function validateState(state, companyId) {
  verifySchema(state, SCHEMA.state, "StateEnvelope");
  if (state.payload.company_id !== companyId || state.payload.sequence !== state.ref.version) {
    fail("INTEGRITY_ERROR", "StateEnvelope identity is invalid");
  }
}

function validateReceipt(receipt, companyId) {
  verifySchema(receipt, SCHEMA.receipt, "approval receipt");
  if (receipt.payload.company_id !== companyId || receipt.payload.complete_run_sha256 !== receipt.payload.run_ref.sha256) {
    fail("INTEGRITY_ERROR", "Approval receipt does not bind the complete run hash");
  }
  if (
    !receipt.payload.authority ||
    receipt.payload.authority.kind !== "role" ||
    !receipt.payload.approval_scope ||
    !receipt.payload.timestamp ||
    !("resulting_state_ref" in receipt.payload)
  ) {
    fail("INTEGRITY_ERROR", "Approval receipt is missing authority, scope, timestamp, or resulting State");
  }
}

function validateOutputSnapshot(snapshot, run, status) {
  verifySchema(snapshot, SCHEMA.outputSnapshot, "output snapshot");
  const expectedLanguage = run.payload.outcome.review?.language ?? "sv";
  if (
    snapshot.payload.approval_status !== status ||
    !sameRef(snapshot.payload.run_ref, run.ref) ||
    snapshot.payload.proposal_digest !== run.payload.proposal_digest ||
    canonicalStringify(snapshot.payload.canonical_outputs) !==
      canonicalStringify(run.payload.outcome.canonical_outputs)
    || (snapshot.payload.language !== undefined && snapshot.payload.language !== expectedLanguage)
    || (snapshot.payload.review !== undefined && canonicalStringify(snapshot.payload.review) !== canonicalStringify(run.payload.outcome.review))
  ) {
    fail("INTEGRITY_ERROR", "Output snapshot does not match its complete run");
  }
}

async function validateBySchema(paths, catalog, sealed, companyId) {
  if (sealed.ref.schema_id === SCHEMA.logItem) return validateLogItem(paths, sealed, companyId);
  if (sealed.ref.schema_id === SCHEMA.document) return validateDocument(paths, sealed, companyId);
  if (sealed.ref.schema_id === SCHEMA.docset) {
    return validateDocset(paths, sealed, companyId, sealed.payload.period.id);
  }
  if (sealed.ref.schema_id === SCHEMA.case) return validateCase(paths, sealed, companyId);
  if (sealed.ref.schema_id === SCHEMA.run) return validateRun(paths, sealed, companyId);
  if (sealed.ref.schema_id === SCHEMA.state) return validateState(sealed, companyId);
  if (sealed.ref.schema_id === SCHEMA.receipt) return validateReceipt(sealed, companyId);
  if (sealed.ref.schema_id === SCHEMA.upstream) {
    return validateApprovedUpstream(paths, catalog, sealed, companyId, sealed.payload.period_id, false);
  }
  if (sealed.ref.schema_id === SCHEMA.outputSnapshot) {
    const run = await readImmutableSealed(paths, sealed.payload.run_ref, "snapshot run");
    return validateOutputSnapshot(sealed, run, sealed.payload.approval_status);
  }
  if (sealed.ref.schema_id === SCHEMA.event) return validateEvent(sealed, companyId);
}

async function verifyCurrentHeads(paths, catalog) {
  validateCatalogPayload(catalog);
  const state = await readImmutableSealed(paths, catalog.state_head, "current State");
  validateState(state, catalog.company_id);
  for (const [periodId, ref] of Object.entries(catalog.docset_heads)) {
    const docset = await readImmutableSealed(paths, ref, "current docset");
    await validateDocset(paths, docset, catalog.company_id, periodId);
  }
  for (const ref of Object.values(catalog.upstream_heads)) {
    const wrapper = await readImmutableSealed(paths, ref, "current upstream result");
    await validateApprovedUpstream(paths, catalog, wrapper, catalog.company_id, wrapper.payload.period_id, true);
  }
  await loadTimeline(paths, catalog);
}

async function readTimeline(paths, catalog, query) {
  const events = await loadTimeline(paths, catalog);
  const periodId = query.period ? normalizePeriod(query.period).id : query.period_id;
  const selected = periodId ? events.filter((event) => event.payload.period_id === periodId) : events;
  const format = query.format ?? "json";
  if (format === "json") {
    return freezeResult({
      contract_version: CONTRACT_VERSION,
      company_id: catalog.company_id,
      events: selected.map((event) => event.payload),
    });
  }
  if (format !== "markdown" && format !== "md") fail("INVALID_ARGUMENT", `Unknown timeline format: ${format}`);
  const lines = [
    "# Company Record timeline",
    "",
    `Company: \`${catalog.company_id}\``,
    "",
    "| # | Time | Event | Period | Domain | Primary reference |",
    "|---:|---|---|---|---|---|",
  ];
  for (const event of selected) {
    const value = event.payload;
    const primary = value.receipt_ref ?? value.run_ref ?? value.case_ref ?? value.docset_ref ?? value.state_ref;
    lines.push(
      `| ${value.sequence} | ${escapeCell(value.recorded_at)} | ${escapeCell(value.type)} | ${escapeCell(value.period_id ?? "-")} | ${escapeCell(value.domain ?? "-")} | ${primary ? `\`${primary.sha256.slice(0, 12)}\`` : "-"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function loadTimeline(paths, catalog) {
  const events = [];
  let previous = null;
  for (const ref of catalog.timeline) {
    const event = await readImmutableSealed(paths, ref, "timeline event");
    validateEvent(event, catalog.company_id);
    if (!sameNullableRef(event.payload.previous_event_ref, previous)) {
      fail("INTEGRITY_ERROR", "Timeline event chain is broken", { event_ref: event.ref });
    }
    events.push(event);
    previous = event.ref;
  }
  return events;
}

function validateEvent(event, companyId) {
  verifySchema(event, SCHEMA.event, "timeline event");
  if (event.payload.company_id !== companyId || event.payload.sequence !== event.ref.version) {
    fail("INTEGRITY_ERROR", "Timeline event identity is invalid");
  }
}

async function requireEmbeddedMatch(paths, embedded, label) {
  try {
    verifySealedContent(embedded, label);
  } catch (error) {
    throw fromContractError(error);
  }
  const stored = await readImmutableSealed(paths, embedded.ref, label);
  if (canonicalStringify(stored) !== canonicalStringify(embedded)) {
    fail("INTEGRITY_ERROR", `${label} differs from its stored immutable object`);
  }
  return stored;
}

async function appendEvent(paths, catalog, clock, type, details) {
  const sequence = catalog.next.event++;
  const previousEventRef = catalog.timeline.at(-1) ?? null;
  const event = sealContent({
    schemaId: SCHEMA.event,
    stableId: `${catalog.company_id}:timeline`,
    version: sequence,
    payload: {
      contract_version: CONTRACT_VERSION,
      company_id: catalog.company_id,
      sequence,
      type,
      recorded_at: now(clock),
      previous_event_ref: previousEventRef,
      ...cloneJson(details),
    },
  });
  await writeImmutableSealed(paths, event);
  catalog.timeline.push(event.ref);
  return event;
}

async function loadCatalog(paths, expectedCompanyId) {
  const catalog = await readCatalog(paths);
  if (!catalog) fail("NOT_FOUND", `No Company Record exists at ${paths.root}`);
  verifySchema(catalog, SCHEMA.catalog, "Company Record catalog");
  validateCatalogPayload(catalog.payload);
  if (expectedCompanyId && catalog.payload.company_id !== expectedCompanyId) {
    fail("WRONG_COMPANY", `Expected ${expectedCompanyId}, found ${catalog.payload.company_id}`);
  }
  return catalog;
}

function validateCatalogPayload(catalog) {
  requireText(catalog.company_id, "catalog.company_id");
  if (!catalog.state_head || !catalog.periods || !catalog.docset_heads || !catalog.next) {
    fail("INTEGRITY_ERROR", "Company Record catalog is incomplete");
  }
  if (catalog.settings !== undefined) {
    if (!catalog.settings || typeof catalog.settings !== "object" || Array.isArray(catalog.settings)) {
      fail("INTEGRITY_ERROR", "Company Record catalog settings are invalid");
    }
    normalizeLanguage(catalog.settings.language ?? "sv", "catalog.settings.language");
  }
  for (const [periodId, record] of Object.entries(catalog.periods)) {
    try {
      assertPeriod(record?.period, `catalog.periods.${periodId}.period`);
    } catch (error) {
      fail("INTEGRITY_ERROR", `Company Record contains an invalid Period ${periodId}: ${error.message}`);
    }
    if (record.period.id !== periodId) fail("INTEGRITY_ERROR", `Company Record Period key ${periodId} does not match its ID`);
  }
}

async function saveCatalog(paths, previous, payload) {
  const sealed = sealCatalog(payload, Number(previous.ref.version) + 1);
  await replaceCatalog(paths, sealed);
}

function sealCatalog(payload, version) {
  return sealContent({
    schemaId: SCHEMA.catalog,
    stableId: `${payload.company_id}:catalog`,
    version,
    payload,
  });
}

function initialCatalog(companyId, stateRef, language = "sv") {
  return {
    contract_version: CONTRACT_VERSION,
    company_id: companyId,
    settings: { language: normalizeLanguage(language, "language") },
    next: { log_item: 1, document: 1, receipt: 1, event: 1 },
    versions: { case: {}, run: {} },
    state_head: stateRef,
    state_refs: [stateRef],
    log_item_refs: {},
    document_refs: {},
    docset_heads: {},
    periods: {},
    run_refs: [],
    receipt_refs: [],
    approval_by_run: {},
    output_snapshots: {},
    upstream_heads: {},
    timeline: [],
  };
}

function ensurePeriod(catalog, period) {
  let record = catalog.periods[period.id];
  if (record && period.kind !== undefined
      && canonicalStringify(record.period) !== canonicalStringify(period)) {
    fail("PERIOD_DEFINITION_MISMATCH", `Period ${period.id} already has a different definition`, {
      existing_period: record.period,
      requested_period: period,
    });
  }
  if (!record) {
    if (period.kind === undefined) {
      fail("PERIOD_DEFINITION_REQUIRED", `Creating Period ${period.id} requires id, kind, and canonical dates`);
    }
    record = {
      period: cloneJson(period),
      status: "working",
      docset_head: null,
      case_heads: {},
      approval_heads: {},
      approved_runs: {},
      approved_state_ref: null,
    };
    catalog.periods[period.id] = record;
  }
  return record;
}

function ensureWritablePeriod(catalog, period) {
  const record = ensurePeriod(catalog, period);
  if (record.status === "closed") fail("PERIOD_CLOSED", `Period ${period.id} is closed`);
  const requestedStateVersion = record.approved_state_ref?.version ?? null;
  const laterAuthoritativePeriod = Object.values(catalog.periods)
    .filter((candidate) => {
      if (candidate.period.id === period.id || !candidate.approved_state_ref) return false;
      if (requestedStateVersion !== null) return candidate.approved_state_ref.version > requestedStateVersion;
      return candidate.period.end > record.period.end;
    })
    .sort((left, right) => left.approved_state_ref.version - right.approved_state_ref.version)
    .at(-1)?.period.id;
  if (laterAuthoritativePeriod) {
    fail(
      "OUT_OF_SEQUENCE",
      `Period ${period.id} cannot be changed after ${laterAuthoritativePeriod} has authoritative State; apply late material to the last open period`,
      { requested_period_id: period.id, later_authoritative_period_id: laterAuthoritativePeriod },
    );
  }
  return record;
}

function setDocsetHead(catalog, periodRecord, ref) {
  catalog.docset_heads[periodRecord.period.id] = ref;
  periodRecord.docset_head = ref;
}

function markWorking(periodRecord) {
  if (periodRecord.status === "closed") fail("PERIOD_CLOSED", `Period ${periodRecord.period.id} is closed`);
  periodRecord.status = "working";
}

async function loadDocsetHead(paths, catalog, periodId) {
  const ref = catalog.docset_heads[periodId];
  if (!ref) return null;
  return readImmutableSealed(paths, ref, "current docset");
}

function nextNamedVersion(map, stableId) {
  const version = (map[stableId] ?? 0) + 1;
  map[stableId] = version;
  return version;
}

function normalizeChanges(input) {
  if (Array.isArray(input)) return { operations: input, actor: normalizeActor() };
  requireObject(input, "changes");
  if (input.op || input.operation) {
    return { operations: [input], actor: normalizeActor(input.actor) };
  }
  const operations = [];
  for (const item of input.add ?? []) operations.push({ op: "add", item });
  for (const item of input.copy ?? []) operations.push({ op: "copy", ...item });
  for (const item of input.remove ?? []) {
    operations.push(typeof item === "string" ? { op: "remove", document_id: item } : { op: "remove", ...item });
  }
  for (const item of input.update ?? []) operations.push({ op: "update", ...item });
  return { operations, actor: normalizeActor(input.actor) };
}

function assertExpectedHead(actualRef, expectedInput, periodId) {
  const expectedRef = expectedInput === null ? null : normalizeRef(expectedInput, "expected docset head");
  if (!sameNullableRef(actualRef, expectedRef)) {
    fail("STALE_DOCSET", `Docset head for ${periodId} changed`, {
      expected_ref: expectedRef,
      actual_ref: actualRef,
    });
  }
}

function normalizeDecision(input) {
  requireObject(input, "decision");
  const decisionWord = input.decision ?? input.status;
  if (decisionWord !== "approved" && decisionWord !== "rejected") {
    fail("INVALID_DECISION", "decision must explicitly be approved or rejected");
  }
  requireObject(input.actor, "decision.actor");
  const actor = normalizeActor(input.actor);
  requireText(actor.role, "decision.actor.role");
  const approved = decisionWord === "approved";
  const allowedRoles = approved ? new Set(["approver"]) : new Set(["approver", "reviewer", "operator"]);
  if (!allowedRoles.has(actor.role)) {
    fail("UNAUTHORIZED", `${actor.role} is not authorized to record a ${decisionWord} decision`);
  }
  const authority = cloneJson(input.authority ?? {});
  if (authority.kind !== "role" || authority.role !== actor.role || (approved && authority.role !== "approver")) {
    fail("UNAUTHORIZED", "decision authority must be the actor's authorized role");
  }
  return {
    approved,
    actor,
    authority,
    note: typeof input.note === "string" ? input.note : "",
    close: Boolean(input.close),
    expected_run_sha256: input.expectedRunSha256 ?? input.expected_run_sha256 ?? null,
  };
}

function normalizeOpenOptions(options, additional) {
  if (typeof options === "string") return { ...additional, rootDir: options };
  requireObject(options, "options");
  return { ...options, rootDir: options.rootDir ?? options.directory };
}

function normalizeRoot(rootDir) {
  requireText(rootDir, "rootDir");
  return path.resolve(rootDir);
}

function normalizeInitialState(input = {}) {
  if (looksLikeSealed(input)) {
    try {
      verifySealedContent(input, "initialState");
    } catch (error) {
      throw fromContractError(error);
    }
    input = input.payload;
  }
  requireObject(input, "initialState");
  return { core: cloneJson(input.core ?? {}), domains: cloneJson(input.domains ?? {}) };
}

function normalizePeriod(input) {
  if (typeof input === "string") {
    requireText(input, "period");
    return { id: input };
  }
  try {
    assertPeriod(input, "period");
  } catch (error) {
    throw fromContractError(error);
  }
  return cloneJson(input);
}

function normalizeActor(input) {
  if (input === undefined || input === null) return { id: "system" };
  if (typeof input === "string") {
    requireText(input, "actor");
    return { id: input };
  }
  requireObject(input, "actor");
  const actor = cloneJson(input);
  requireText(actor.id, "actor.id");
  return actor;
}

function normalizeRef(input, label) {
  const ref = looksLikeSealed(input) ? input.ref : input;
  try {
    assertContentRef(ref, label);
  } catch (error) {
    throw fromContractError(error);
  }
  return cloneJson(ref);
}

function documentBytes(item) {
  if (Buffer.isBuffer(item.bytes)) return Buffer.from(item.bytes);
  if (item.bytes instanceof Uint8Array) return Buffer.from(item.bytes);
  if (typeof item.bytes === "string") return Buffer.from(item.bytes, item.encoding === "base64" ? "base64" : "utf8");
  if (typeof item.content === "string") return Buffer.from(item.content, "utf8");
  if (typeof item.content_base64 === "string") return decodeCanonicalBase64(item.content_base64);
  fail("INVALID_ARGUMENT", "document item requires bytes, content, or content_base64");
}

function decodeCanonicalBase64(value) {
  requireText(value, "content_base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("INTEGRITY_ERROR", "content_base64 is not canonical base64");
  return bytes;
}

function assertUniqueDocumentIds(documents) {
  const ids = new Set();
  for (const item of documents) {
    if (ids.has(item.document_id)) fail("INTEGRITY_ERROR", `Duplicate document ID ${item.document_id}`);
    ids.add(item.document_id);
  }
}

function payrollUpstreamStableId(companyId, periodId) {
  return `${companyId}:${periodId}:payroll-accounting-facts`;
}

function verifySchema(sealed, schemaId, label) {
  try {
    verifySealedContent(sealed, label);
  } catch (error) {
    throw fromContractError(error);
  }
  if (sealed.ref.schema_id !== schemaId) {
    fail("INTEGRITY_ERROR", `${label} has schema ${sealed.ref.schema_id}, expected ${schemaId}`);
  }
}

function sameRef(left, right) {
  return contentRefKey(left) === contentRefKey(right);
}

function sameNullableRef(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left === null || left === undefined) && (right === null || right === undefined);
  }
  return sameRef(left, right);
}

function looksLikeRef(value) {
  return Boolean(value && typeof value === "object" && value.schema_id && value.sha256 && value.stable_id);
}

function looksLikeSealed(value) {
  return Boolean(value && typeof value === "object" && value.ref && Object.prototype.hasOwnProperty.call(value, "payload"));
}

function normalizeClock(clock) {
  if (clock === undefined) return () => new Date();
  if (typeof clock !== "function") fail("INVALID_ARGUMENT", "clock must be a function");
  return clock;
}

function now(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) fail("INVALID_ARGUMENT", "clock returned an invalid date");
  return date.toISOString();
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ARGUMENT", `${label} must be an object`);
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail("INVALID_ARGUMENT", `${label} must be a non-empty string`);
  }
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("INTEGRITY_ERROR", `${label} must be a lowercase SHA-256 digest`);
  }
}

function freezeResult(value) {
  return deepFreeze(cloneJson(value));
}

function fail(code, message, details = {}) {
  throw new CompanyRecordError(code, message, details);
}

function fromContractError(error) {
  if (error instanceof CompanyRecordError) return error;
  if (error instanceof StorageIntegrityError) {
    return new CompanyRecordError(error.code, error.message, error.details, error);
  }
  if (error instanceof ContractError) {
    return new CompanyRecordError("CONTRACT_ERROR", error.message, error.details, error);
  }
  return error;
}

async function guard(operation) {
  try {
    return await operation();
  } catch (error) {
    throw fromContractError(error);
  }
}
