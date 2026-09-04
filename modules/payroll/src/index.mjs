import { cloneJson } from "../../../contracts/src/canonical.mjs";
import {
  CONTRACT_VERSION,
  assertConsolidationCase,
  createModuleOutcome,
  normalizeLanguage,
  sealContent,
  parseMoney,
  verifySealedContent,
} from "../../../contracts/src/index.mjs";
import {
  SIMPLE_PAYROLL_PROFILE,
  calculateSimplePayroll,
} from "./private/kernel.mjs";
import {
  ASSESSMENT_PROFILE,
  assessPayrollEvidence,
  assessmentToPayrollInput,
  prepareEvidenceDocuments,
} from "./private/assessment.mjs";
import {
  LEGACY_PAYROLL_SCHEMA_VERSION,
  PAYROLL_SCHEMA_VERSION,
  adaptPayrollInput,
  adaptPayrollState,
  payrollToV2,
} from "./private/money-boundary.mjs";

const DOMAIN = "payroll";
const MODULE_VERSION = "2.0.0";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function consolidate(caseBundle, variantRef = undefined) {
  assertConsolidationCase(caseBundle);
  const caseValue = caseBundle.payload;
  const language = normalizeLanguage(caseValue.language ?? "sv", "ConsolidationCase.language");
  const profileId = variantId(variantRef);

  if (caseValue.domain !== DOMAIN) {
    return outOfScope(caseBundle, profileId, [{
      code: "UNSUPPORTED_DOMAIN",
      message: `Payroll cannot consolidate domain ${caseValue.domain}.`,
    }]);
  }
  if (profileId !== SIMPLE_PAYROLL_PROFILE.id) {
    return outOfScope(caseBundle, profileId, [{
      code: "UNSUPPORTED_RULES_PROFILE",
      message: `Payroll rules profile ${profileId ?? "(unnamed)"} is not supported.`,
      supported_profiles: [SIMPLE_PAYROLL_PROFILE.id],
    }]);
  }

  const documents = docsetDocuments(caseValue.docset.payload).map(normalizeDocument);
  const payrollDocuments = documents.filter((document) => document.role === "payroll-input");
  const evidenceDocuments = documents.filter((document) => document.role === "payroll-evidence");
  if (payrollDocuments.length > 0 && evidenceDocuments.length > 0) {
    return needsInput(caseBundle, profileId, [{
      code: "AMBIGUOUS_PAYROLL_INPUT_MODE",
      field: "docset.documents",
      prompt: "Use payroll-evidence documents or one transitional payroll-input document, not both.",
    }]);
  }
  if (payrollDocuments.length === 0 && evidenceDocuments.length === 0) {
    return needsInput(caseBundle, profileId, [{
      code: "MISSING_PAYROLL_INPUT",
      field: "docset.documents",
      prompt: "Add payroll-evidence text documents or one transitional JSON payroll-input document.",
    }]);
  }
  if (payrollDocuments.length > 1) {
    return needsInput(caseBundle, profileId, [{
      code: "AMBIGUOUS_PAYROLL_INPUT",
      field: "docset.documents[role=payroll-input]",
      prompt: "Keep exactly one transitional payroll-input document for this simple payroll run.",
    }]);
  }

  let input;
  let assessment = null;
  let evidence;
  let assessmentProvenance;
  let policySelection;
  if (evidenceDocuments.length > 0) {
    policySelection = selectPolicy(caseValue, null);
    if (policySelection.outOfScopeReasons.length > 0) {
      return outOfScope(caseBundle, profileId, policySelection.outOfScopeReasons);
    }
    if (policySelection.questions.length > 0) {
      return needsInput(caseBundle, profileId, policySelection.questions);
    }
    const prepared = prepareEvidenceDocuments(evidenceDocuments);
    if (!prepared.ok) return needsInput(caseBundle, profileId, prepared.questions);
    const assessed = await assessPayrollEvidence({
      companyId: caseValue.company_id,
      periodId: caseValue.period.id,
      previousPayrollState: previousPayrollDomain(caseValue.previous_state.payload),
      documents: prepared.documents,
      language,
    });
    assessment = sealAssessment(caseBundle, caseValue, assessed.assessment);
    evidence = evidenceDocuments.map((document) => evidenceRecord(caseValue, document));
    assessmentProvenance = {
      mode: "model_assessment",
      nondeterministic: true,
      ...assessed.runtime,
    };
    const outcomeOptions = {
      assessment,
      warnings: assessed.assessment.warnings,
      evidence,
      provenanceDetails: { assessment: assessmentProvenance },
    };
    if (assessed.assessment.status === "needs_input") {
      return needsInput(caseBundle, profileId, assessed.assessment.questions, outcomeOptions);
    }
    if (assessed.assessment.status === "out_of_scope") {
      return outOfScope(caseBundle, profileId, assessed.assessment.reasons, outcomeOptions);
    }
    input = assessmentToPayrollInput(assessed.assessment, caseValue.period.id);
  } else {
    const document = payrollDocuments[0];
    const decoded = decodeJsonDocument(document);
    if (!decoded.ok) {
      return needsInput(caseBundle, profileId, [{
        code: "INVALID_PAYROLL_INPUT_DOCUMENT",
        field: `document:${document.document_id}`,
        prompt: decoded.message,
      }]);
    }
    input = decoded.value;
    evidence = [evidenceRecord(caseValue, document)];
    assessmentProvenance = {
      mode: "provided_normalized_input",
      nondeterministic: false,
      profile_id: null,
      model: null,
      reasoning_effort: null,
      prompt_version: null,
      attempts: 0,
      response_ids: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
  }

  const inputProfile = input.rules_profile ?? input.profile_id;
  if (inputProfile && inputProfile !== SIMPLE_PAYROLL_PROFILE.id) {
    return outOfScope(caseBundle, profileId, [{
      code: "UNSUPPORTED_INPUT_PROFILE",
      message: `The payroll input requests unsupported profile ${inputProfile}.`,
      supported_profiles: [SIMPLE_PAYROLL_PROFILE.id],
    }], outcomeContext());
  }

  const components = Array.isArray(input.pay_components) ? input.pay_components : [];
  const unsupportedTypes = [...new Set(components
    .map((component) => component?.type)
    .filter((type) => typeof type === "string" && !SIMPLE_PAYROLL_PROFILE.supported_component_types.includes(type)))];
  if (unsupportedTypes.length > 0) {
    return outOfScope(caseBundle, profileId, unsupportedTypes.map((type) => ({
      code: "UNSUPPORTED_PAY_COMPONENT",
      message: `Pay component ${type} is outside ${SIMPLE_PAYROLL_PROFILE.id}.`,
      component_type: type,
    })), outcomeContext());
  }

  const questions = validateInput(input, caseValue.period.id);
  policySelection ??= selectPolicy(caseValue, input.payment_date);
  if (policySelection.outOfScopeReasons.length > 0) {
    return outOfScope(caseBundle, profileId, policySelection.outOfScopeReasons, outcomeContext());
  }
  questions.push(...policySelection.questions);
  if (questions.length > 0) {
    return needsInput(caseBundle, profileId, questions, {
      assessment,
      warnings: assessment?.payload?.warnings ?? [],
      evidence,
      provenanceDetails: { assessment: assessmentProvenance },
    });
  }

  try {
    input = adaptPayrollInput(input, "SEK");
  } catch (error) {
    return needsInput(caseBundle, profileId, [question(
      "INVALID_PAYROLL_MONEY",
      "pay_components",
      error instanceof Error ? error.message : String(error),
    )], {
      assessment,
      warnings: assessment?.payload?.warnings ?? [],
      evidence,
      provenanceDetails: { assessment: assessmentProvenance },
    });
  }

  let previousEmployees;
  try {
    previousEmployees = previousPayrollEmployees(caseValue.previous_state.payload);
  } catch (error) {
    return needsInput(caseBundle, profileId, [question(
      "INVALID_PREVIOUS_PAYROLL_MONEY",
      "previous_state.domains.payroll",
      error instanceof Error ? error.message : String(error),
    )], outcomeContext());
  }
  const previousEmployee = previousEmployees.find((employee) => employee.employee_id === input.employee.employee_id);
  const sourceResult = sealContent({
    schemaId: "se.bergbok.payroll.result",
    schemaVersion: PAYROLL_SCHEMA_VERSION,
    stableId: `${caseValue.company_id}:${caseValue.period.id}:${input.employee.employee_id}`,
    version: caseBundle.ref.version,
    payload: {
      contract_version: CONTRACT_VERSION,
      schema_version: PAYROLL_SCHEMA_VERSION,
      company_id: caseValue.company_id,
      period_id: caseValue.period.id,
      case_ref: cloneJson(caseBundle.ref),
      rules_profile: profileDescriptor(),
      input_document_ids: evidence.map((item) => item.document_id),
      payroll_assessment_ref: assessment?.ref ?? null,
      status: "proposed",
    },
  });

  const calculation = calculateSimplePayroll({
    companyId: caseValue.company_id,
    periodId: caseValue.period.id,
    documentIds: evidence.map((item) => item.document_id),
    input,
    policy: policySelection.policy,
    priorYearToDate: previousEmployee?.year_to_date ?? null,
    sourceResultRef: sourceResult.ref,
  });
  if (calculation.unsupported) {
    return outOfScope(caseBundle, profileId, [calculation.unsupported], outcomeContext());
  }

  const employees = previousEmployees
    .filter((employee) => employee.employee_id !== calculation.employeeState.employee_id)
    .map((employee) => payrollToV2(employee, "SEK"))
    .concat(calculation.employeeState)
    .sort((left, right) => left.employee_id.localeCompare(right.employee_id));
  const payrollState = sealContent({
    schemaId: "se.bergbok.payroll.state",
    schemaVersion: PAYROLL_SCHEMA_VERSION,
    stableId: `${caseValue.company_id}:payroll-state`,
    version: caseBundle.ref.version,
    payload: {
      contract_version: CONTRACT_VERSION,
      schema_version: PAYROLL_SCHEMA_VERSION,
      status: "projected",
      company_id: caseValue.company_id,
      through_period_id: caseValue.period.id,
      rules_profile: profileDescriptor(),
      employees,
    },
  });
  const payslip = sealOutput("payslip", caseBundle, caseValue, input, calculation.payslip);
  const payment = sealOutput("payment-instruction", caseBundle, caseValue, input, calculation.payment);
  const agi = sealOutput("agi-report", caseBundle, caseValue, input, calculation.agi);
  const accountingFacts = sealContent({
    schemaId: "se.bergbok.bookkeeping.payroll-accounting-facts",
    schemaVersion: PAYROLL_SCHEMA_VERSION,
    stableId: `${caseValue.company_id}:${caseValue.period.id}:payroll-accounting-facts`,
    version: caseBundle.ref.version,
    payload: calculation.accountingFacts,
  });

  return createModuleOutcome({
    kind: "proposal",
    domain: DOMAIN,
    caseRef: caseBundle.ref,
    proposedChanges: [{
      action: "replace_domain_state",
      domain: DOMAIN,
      state_ref: payrollState.ref,
    }],
    projectedState: payrollState,
    canonicalOutputs: {
      payroll: {
        contract_version: CONTRACT_VERSION,
        schema_version: PAYROLL_SCHEMA_VERSION,
        status: "proposed",
        period_id: caseValue.period.id,
        payslips: [cloneJson(payslip.payload)],
        payment_instructions: [cloneJson(payment.payload)],
        agi_reports: [cloneJson(agi.payload)],
      },
      payslip,
      payment,
      agi,
      payroll_accounting_facts: accountingFacts,
      ...(assessment ? { payroll_assessment: assessment } : {}),
    },
    warnings: assessment?.payload?.warnings ?? [],
    evidence,
    review: {
      language,
      status: "requires_human_approval",
      summary: language === "sv"
        ? `Föreslagen lön för ${input.employee.name}: bruttolön ${calculation.amounts.gross_pay}, nettolön ${calculation.amounts.net_pay}.`
        : `Proposed payroll for ${input.employee.name}: gross ${calculation.amounts.gross_pay}, net ${calculation.amounts.net_pay}.`,
      controls: {
        canonical_money: true,
        economic_facts_reconciled: true,
        policy_effective_on_payment_date: true,
        assessment_citations_validated: assessment !== null,
      },
      actions_performed: {
        state_written: false,
        approved: false,
        payment_sent: false,
        agi_filed_or_submitted: false,
      },
    },
    provenance: provenance(profileId, {
      assessment: assessmentProvenance,
      calculation: {
        deterministic: true,
        policy_source: policySelection.source,
        daily_divisor: policySelection.policy.daily_divisor,
        withholding_basis_points: policySelection.policy.tax_withholding_basis_points,
        employer_contribution_basis_points: policySelection.policy.employer_contribution_basis_points,
      },
    }),
  });

  function outcomeContext() {
    return {
      assessment,
      warnings: assessment?.payload?.warnings ?? [],
      evidence: evidence ?? [],
      provenanceDetails: assessmentProvenance ? { assessment: assessmentProvenance } : undefined,
    };
  }
}

function docsetDocuments(docset) {
  return Array.isArray(docset?.documents) ? docset.documents : [];
}

function normalizeDocument(value, index) {
  const payload = value?.payload && value?.ref ? value.payload : value;
  return {
    ...payload,
    document_id: payload?.document_id ?? payload?.id ?? value?.ref?.stable_id ?? `document-${index + 1}`,
  };
}

function decodeJsonDocument(document) {
  if (typeof document.content_base64 !== "string" || document.content_base64.length === 0) {
    return { ok: false, message: "The payroll-input document must contain content_base64." };
  }
  const compact = document.content_base64.replace(/\s/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    return { ok: false, message: "The payroll-input content_base64 is not valid base64." };
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.toString("base64") !== compact) {
    return { ok: false, message: "The payroll-input content_base64 is not canonical base64." };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: "The payroll-input document must contain valid UTF-8 JSON." };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("top level must be an object");
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: `The payroll-input document is not valid JSON: ${error.message}` };
  }
}

function validateInput(input, periodId) {
  const questions = [];
  requiredText(questions, input.schema_version, "schema_version", "Set payroll input schema_version to 2.0 (or 1.0 for legacy input).");
  if (input.schema_version && ![LEGACY_PAYROLL_SCHEMA_VERSION, SIMPLE_PAYROLL_PROFILE.input_schema_version].includes(input.schema_version)) {
    questions.push(question("UNSUPPORTED_INPUT_SCHEMA", "schema_version", `Use payroll input schema 1.0 or ${SIMPLE_PAYROLL_PROFILE.input_schema_version}.`));
  }
  if (input.period_id !== undefined && input.period_id !== periodId) {
    questions.push(question("PERIOD_MISMATCH", "period_id", `Set period_id to the case period ${periodId}.`));
  }
  if (!isDate(input.payment_date)) {
    questions.push(question("MISSING_PAYMENT_DATE", "payment_date", "Provide a valid payment_date in YYYY-MM-DD format."));
  }
  if (!input.employee || typeof input.employee !== "object" || Array.isArray(input.employee)) {
    questions.push(question("MISSING_EMPLOYEE", "employee", "Provide the employee object."));
  } else {
    requiredText(questions, input.employee.employee_id, "employee.employee_id", "Provide a stable employee_id.");
    requiredText(questions, input.employee.name, "employee.name", "Provide the employee name.");
    requiredText(questions, input.employee.personal_identity_number, "employee.personal_identity_number", "Provide the identity required for AGI data.");
    requiredText(questions, input.employee.payment_destination, "employee.payment_destination", "Provide the destination for the proposed salary payment.");
  }
  if (!Array.isArray(input.pay_components)) {
    questions.push(question("MISSING_PAY_COMPONENTS", "pay_components", "Provide a pay_components array."));
    return questions;
  }
  const salaries = input.pay_components.filter((component) => component?.type === "fixed_monthly_salary");
  if (salaries.length !== 1) {
    questions.push(question("FIXED_SALARY_COUNT", "pay_components", "Provide exactly one fixed_monthly_salary component."));
  }
  input.pay_components.forEach((component, index) => {
    const field = `pay_components[${index}]`;
    if (!component || typeof component !== "object" || Array.isArray(component)) {
      questions.push(question("INVALID_PAY_COMPONENT", field, "Each pay component must be an object."));
      return;
    }
    if (component.type === "fixed_monthly_salary") {
      positiveMoney(questions, component, "amount", input.schema_version, field, "Provide the positive fixed salary as canonical Money.");
      requiredText(questions, component.description, `${field}.description`, "Describe the fixed salary component.");
    } else if (component.type === "ordinary_absence") {
      const deductionField = input.schema_version === LEGACY_PAYROLL_SCHEMA_VERSION ? "deduction_ore" : "deduction";
      if (component.days !== undefined && component[deductionField] !== undefined) {
        questions.push(question("AMBIGUOUS_ABSENCE", field, "Provide absence as days or a deduction amount, not both."));
      } else if (component.days !== undefined) {
        if (!Number.isSafeInteger(component.days) || component.days <= 0) {
          questions.push(question("INVALID_ABSENCE_DAYS", `${field}.days`, "Provide ordinary absence as a positive whole number of days."));
        }
      } else {
        positiveMoney(questions, component, "deduction", input.schema_version, field, "Provide absence days or a positive canonical Money deduction.");
      }
      requiredText(questions, component.description, `${field}.description`, "Describe the ordinary absence.");
    } else if (component.type === "correction") {
      signedMoney(questions, component, "amount", input.schema_version, field, "Provide the signed correction as canonical Money.");
      requiredText(questions, component.description, `${field}.description`, "Describe the correction.");
    } else if (typeof component.type !== "string" || component.type.length === 0) {
      questions.push(question("MISSING_COMPONENT_TYPE", `${field}.type`, "Name the pay component type."));
    }
  });
  return deduplicateQuestions(questions);
}

function selectPolicy(caseValue, paymentDate) {
  const canonical = caseValue.effective_policies;
  if (canonical !== undefined) {
    const scopeReasons = [];
    if (canonical?.core?.country !== "SE") {
      scopeReasons.push({
        code: "UNSUPPORTED_PAYROLL_COUNTRY",
        message: `Payroll country ${canonical?.core?.country ?? "(missing)"} is outside ${SIMPLE_PAYROLL_PROFILE.id}; expected SE.`,
      });
    }
    if (canonical?.core?.currency !== "SEK") {
      scopeReasons.push({
        code: "UNSUPPORTED_PAYROLL_CURRENCY",
        message: `Payroll currency ${canonical?.core?.currency ?? "(missing)"} is outside ${SIMPLE_PAYROLL_PROFILE.id}; expected SEK.`,
      });
    }
    const selectedProfile = canonical?.payroll?.profile;
    if (selectedProfile !== SIMPLE_PAYROLL_PROFILE.id) {
      scopeReasons.push({
        code: "UNSUPPORTED_POLICY_PROFILE",
        message: `Effective payroll profile ${selectedProfile ?? "(missing)"} is outside this module.`,
        supported_profiles: [SIMPLE_PAYROLL_PROFILE.id],
      });
    }
    if (scopeReasons.length > 0) {
      return { policy: null, questions: [], outOfScopeReasons: scopeReasons, source: "effective_policies" };
    }
    const policy = {
      ...canonical.payroll,
      tax_withholding_basis_points: canonical.payroll.withholding_basis_points,
    };
    const questions = validatePolicyNumbers(policy, "effective_policies.payroll");
    return { policy, questions, outOfScopeReasons: [], source: "effective_policies" };
  }

  const raw = caseValue.policy?.payroll ?? caseValue.payroll_policy ?? null;
  const candidates = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const unsupported = candidates.find((policy) => {
    const id = policy?.rules_profile ?? policy?.profile_id ?? policy?.profile;
    return id && id !== SIMPLE_PAYROLL_PROFILE.id;
  });
  if (unsupported && candidates.every((policy) => (policy?.rules_profile ?? policy?.profile_id ?? policy?.profile) !== SIMPLE_PAYROLL_PROFILE.id)) {
    return {
      policy: null,
      questions: [],
      outOfScopeReasons: [{
        code: "UNSUPPORTED_POLICY_PROFILE",
        message: `The case policy requests unsupported profile ${unsupported.rules_profile ?? unsupported.profile_id ?? unsupported.profile}.`,
        supported_profiles: [SIMPLE_PAYROLL_PROFILE.id],
      }],
      source: "legacy_alias",
    };
  }
  const matching = candidates.filter((policy) => (policy?.rules_profile ?? policy?.profile_id ?? policy?.profile) === SIMPLE_PAYROLL_PROFILE.id);
  const effective = isDate(paymentDate)
    ? matching.find((policy) => isPolicyEffective(policy, paymentDate))
    : matching[0];
  if (!effective) {
    return {
      policy: null,
      outOfScopeReasons: [],
      source: "legacy_alias",
      questions: [question(
        "MISSING_EFFECTIVE_PAYROLL_POLICY",
        "policy.payroll",
        isDate(paymentDate)
          ? `Provide a ${SIMPLE_PAYROLL_PROFILE.id} policy effective on ${paymentDate}.`
          : `Provide a ${SIMPLE_PAYROLL_PROFILE.id} case policy.`,
      )],
    };
  }
  const normalized = {
    ...effective,
    daily_divisor: effective.daily_divisor ?? 30,
    tax_withholding_basis_points: effective.tax_withholding_basis_points ?? effective.withholding_basis_points,
  };
  const questions = validatePolicyNumbers(normalized, "policy.payroll");
  if (!isDate(effective.effective_from)) {
    questions.push(question("MISSING_POLICY_EFFECTIVE_FROM", "policy.payroll.effective_from", "Provide effective_from in YYYY-MM-DD format."));
  }
  if (effective.effective_to !== undefined && effective.effective_to !== null && !isDate(effective.effective_to)) {
    questions.push(question("INVALID_POLICY_EFFECTIVE_TO", "policy.payroll.effective_to", "Use YYYY-MM-DD or null for effective_to."));
  }
  return { policy: normalized, questions, outOfScopeReasons: [], source: "legacy_alias" };
}

function validatePolicyNumbers(policy, fieldRoot) {
  const questions = [];
  if (!Number.isSafeInteger(policy.daily_divisor) || policy.daily_divisor <= 0) {
    questions.push(question("INVALID_DAILY_DIVISOR", `${fieldRoot}.daily_divisor`, "Provide a positive integer daily_divisor."));
  }
  basisPoints(questions, policy.tax_withholding_basis_points, `${fieldRoot}.withholding_basis_points`);
  basisPoints(questions, policy.employer_contribution_basis_points, `${fieldRoot}.employer_contribution_basis_points`);
  return questions;
}

function isPolicyEffective(policy, date) {
  if (!isDate(policy?.effective_from)) return false;
  if (date < policy.effective_from) return false;
  if (policy.effective_to !== undefined && policy.effective_to !== null) {
    if (!isDate(policy.effective_to) || date > policy.effective_to) return false;
  }
  return true;
}

function previousPayrollEmployees(previousState) {
  const domain = previousPayrollDomain(previousState);
  if (!domain) return [];
  const normalized = adaptPayrollState(domain, "SEK");
  if (!Array.isArray(normalized?.employees)) return [];
  return normalized.employees.filter((employee) => employee && typeof employee.employee_id === "string");
}

function previousPayrollDomain(previousState) {
  const domain = previousState?.domains?.payroll;
  if (!domain?.payload || !domain?.ref) return domain ?? null;
  verifySealedContent(domain, "previous Payroll state");
  if (domain.payload.schema_version !== undefined && domain.payload.schema_version !== domain.ref.schema_version) {
    throw new TypeError("Previous Payroll state payload and ContentRef schema versions disagree");
  }
  return domain.payload;
}

function sealOutput(kind, caseBundle, caseValue, input, payload) {
  return sealContent({
    schemaId: `se.bergbok.payroll.${kind}`,
    schemaVersion: PAYROLL_SCHEMA_VERSION,
    stableId: `${caseValue.company_id}:${caseValue.period.id}:${input.employee.employee_id}:${kind}`,
    version: caseBundle.ref.version,
    payload,
  });
}

function needsInput(caseBundle, profileId, questions, options = {}) {
  const language = normalizeLanguage(caseBundle.payload.language ?? "sv", "ConsolidationCase.language");
  const localizedQuestions = localizePayrollQuestions(deduplicateQuestions(questions), language);
  return createModuleOutcome({
    kind: "needs_input",
    domain: DOMAIN,
    caseRef: caseBundle.ref,
    questions: localizedQuestions,
    warnings: options.warnings ?? [],
    evidence: options.evidence ?? [],
    canonicalOutputs: options.assessment ? { payroll_assessment: options.assessment } : {},
    review: {
      language,
      status: "needs_input",
      summary: language === "sv"
        ? "Löneunderlaget behöver kompletteras eller rättas innan ett förslag kan beräknas."
        : "Payroll needs additional or corrected input before it can calculate a Proposal.",
    },
    provenance: provenance(profileId, options.provenanceDetails),
    reasons: localizedQuestions.map((item) => ({ code: item.code, message: item.prompt })),
  });
}

function outOfScope(caseBundle, profileId, reasons, options = {}) {
  const language = normalizeLanguage(caseBundle.payload.language ?? "sv", "ConsolidationCase.language");
  const localizedReasons = localizePayrollReasons(reasons, language);
  return createModuleOutcome({
    kind: "out_of_scope",
    domain: DOMAIN,
    caseRef: caseBundle.ref,
    review: {
      language,
      status: "out_of_scope",
      summary: language === "sv"
        ? `Ärendet ligger utanför ${SIMPLE_PAYROLL_PROFILE.id}.`
        : `The case is outside ${SIMPLE_PAYROLL_PROFILE.id}.`,
    },
    warnings: options.warnings ?? [],
    evidence: options.evidence ?? [],
    canonicalOutputs: options.assessment ? { payroll_assessment: options.assessment } : {},
    provenance: provenance(profileId, options.provenanceDetails),
    reasons: localizedReasons,
  });
}

function provenance(profileId, details = {}) {
  return {
    module: "payroll",
    module_version: MODULE_VERSION,
    rules_profile: {
      requested: profileId,
      selected: profileId === SIMPLE_PAYROLL_PROFILE.id ? profileDescriptor() : null,
    },
    deterministic: details?.assessment?.nondeterministic !== true,
    side_effects: "none",
    ...details,
  };
}

function sealAssessment(caseBundle, caseValue, value) {
  return sealContent({
    schemaId: "se.bergbok.payroll.assessment",
    schemaVersion: PAYROLL_SCHEMA_VERSION,
    stableId: `${caseValue.company_id}:${caseValue.period.id}:payroll-assessment`,
    version: caseBundle.ref.version,
    payload: {
      contract_version: CONTRACT_VERSION,
      company_id: caseValue.company_id,
      period_id: caseValue.period.id,
      case_ref: cloneJson(caseBundle.ref),
      assessment_profile: {
        id: ASSESSMENT_PROFILE.id,
        prompt_version: ASSESSMENT_PROFILE.prompt_version,
      },
      ...cloneJson(value),
    },
  });
}

function evidenceRecord(caseValue, document) {
  return {
    document_id: document.document_id,
    role: document.role,
    docset_ref: cloneJson(caseValue.docset.ref),
  };
}

function profileDescriptor() {
  return { id: SIMPLE_PAYROLL_PROFILE.id, version: SIMPLE_PAYROLL_PROFILE.version };
}

function variantId(value) {
  if (value === undefined || value === null) return SIMPLE_PAYROLL_PROFILE.id;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return null;
  if (typeof value.id === "string") return value.id;
  if (typeof value.profile_id === "string") return value.profile_id;
  if (typeof value.stable_id === "string") return value.stable_id;
  if (typeof value.ref?.stable_id === "string") return value.ref.stable_id;
  return null;
}

function question(code, field, prompt) {
  return { code, field, prompt };
}

const SWEDISH_PAYROLL_MESSAGES = Object.freeze({
  AMBIGUOUS_PAYROLL_INPUT: "Behåll exakt ett övergångsdokument av typen payroll-input för den här lönekörningen.",
  AMBIGUOUS_PAYROLL_INPUT_MODE: "Använd löneunderlag eller ett övergångsdokument av typen payroll-input, inte båda.",
  FIXED_SALARY_COUNT: "Ange exakt en komponent av typen fixed_monthly_salary.",
  INVALID_PAY_COMPONENT: "Varje lönekomponent måste vara ett objekt.",
  INVALID_PAYROLL_EVIDENCE: "Löneunderlaget kunde inte läsas som giltig text.",
  MISSING_COMPONENT_TYPE: "Ange typen för lönekomponenten.",
  MISSING_EMPLOYEE: "Ange den anställdes uppgifter.",
  MISSING_PAY_COMPONENTS: "Ange en lista med lönekomponenter.",
  MISSING_PAYROLL_INPUT: "Lägg till textdokument med löneunderlag eller ett övergångsdokument av typen payroll-input.",
  MISSING_PAYROLL_EVIDENCE: "Lägg till minst ett text- eller Markdown-dokument med löneunderlag.",
  MISSING_PAYMENT_DATE: "Ange ett giltigt utbetalningsdatum i formatet YYYY-MM-DD.",
  PERIOD_MISMATCH: "Ange period_id för den aktuella perioden.",
  UNSUPPORTED_INPUT_PROFILE: "Det angivna löneunderlaget använder en profil som inte stöds.",
  UNSUPPORTED_PAY_COMPONENT: "Lönekomponenten stöds inte av den aktiverade profilen.",
  UNSUPPORTED_RULES_PROFILE: "Den angivna löneprofilen stöds inte.",
  INVALID_PAYROLL_MONEY: "Lönebeloppet är ogiltigt.",
  INVALID_PREVIOUS_PAYROLL_MONEY: "Det tidigare löneunderlagets belopp är ogiltigt.",
  MIXED_PAYROLL_MONEY_SCHEMA: "Blanda inte penningfält från schema 1.0 och 2.0.",
  INVALID_BASIS_POINTS: "Ange ett heltal från 0 till 10000 baspunkter.",
  MISSING_REQUIRED_TEXT: "Ange ett värde.",
  MISSING_POLICY_EFFECTIVE_FROM: "Ange effective_from i formatet YYYY-MM-DD.",
  INVALID_POLICY_EFFECTIVE_TO: "Ange YYYY-MM-DD eller null som effective_to.",
  INVALID_DAILY_DIVISOR: "Ange en positiv heltalsdivisor för dagsberäkningen.",
});

function localizePayrollQuestions(questions, language) {
  if (language !== "sv") return questions;
  return questions.map((item) => {
    const replacement = SWEDISH_PAYROLL_MESSAGES[item.code];
    return replacement ? { ...item, prompt: replacement } : item;
  });
}

function localizePayrollReasons(reasons, language) {
  if (language !== "sv") return reasons;
  return reasons.map((item) => {
    const replacement = SWEDISH_PAYROLL_MESSAGES[item.code];
    return replacement ? { ...item, message: replacement } : item;
  });
}

function requiredText(questions, value, field, prompt) {
  if (typeof value !== "string" || value.trim().length === 0) questions.push(question("MISSING_REQUIRED_TEXT", field, prompt));
}

function signedMoney(questions, component, baseField, schemaVersion, field, prompt) {
  const key = schemaVersion === LEGACY_PAYROLL_SCHEMA_VERSION ? `${baseField}_ore` : baseField;
  const other = schemaVersion === LEGACY_PAYROLL_SCHEMA_VERSION ? baseField : `${baseField}_ore`;
  if (component[other] !== undefined) {
    questions.push(question("MIXED_PAYROLL_MONEY_SCHEMA", `${field}.${other}`, `Do not mix schema 1.0 and 2.0 money fields.`));
    return;
  }
  if (schemaVersion === LEGACY_PAYROLL_SCHEMA_VERSION) {
    if (!Number.isSafeInteger(component[key])) questions.push(question("INVALID_LEGACY_MONEY", `${field}.${key}`, prompt));
    return;
  }
  try {
    parseMoney(component[key], { expectedCurrency: "SEK" });
  } catch {
    questions.push(question("INVALID_CANONICAL_MONEY", `${field}.${key}`, prompt));
  }
}

function positiveMoney(questions, component, baseField, schemaVersion, field, prompt) {
  const before = questions.length;
  signedMoney(questions, component, baseField, schemaVersion, field, prompt);
  if (questions.length !== before) return;
  const key = schemaVersion === LEGACY_PAYROLL_SCHEMA_VERSION ? `${baseField}_ore` : baseField;
  const minor = schemaVersion === LEGACY_PAYROLL_SCHEMA_VERSION
    ? BigInt(component[key])
    : parseMoney(component[key], { expectedCurrency: "SEK" }).minorUnits;
  if (minor <= 0n) questions.push(question("INVALID_POSITIVE_MONEY", `${field}.${key}`, prompt));
}

function basisPoints(questions, value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    questions.push(question("INVALID_BASIS_POINTS", field, "Provide an integer from 0 through 10000 basis points."));
  }
}

function isDate(value) {
  if (!DATE.test(value ?? "")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function deduplicateQuestions(questions) {
  const seen = new Set();
  return questions.filter((item) => {
    const key = `${item.code}:${item.field}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
