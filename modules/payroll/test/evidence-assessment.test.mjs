import assert from "node:assert/strict";
import test from "node:test";

import { consolidate } from "../src/index.mjs";
import {
  PAYROLL_ASSESSMENT_SCHEMA,
  assessPayrollEvidence,
  prepareEvidenceDocuments,
} from "../src/private/assessment.mjs";
import { sha256Bytes } from "../../../contracts/src/canonical.mjs";
import { createStateEnvelope, sealContent, verifySealedContent } from "../../../contracts/src/index.mjs";

const KEY = "test-key-that-must-never-be-persisted";
const TEXTS = {
  employment: "# Agreement\nEmployee ID: employee-1\nEmployee: Kim Example\nIdentity: 19900101-0000\nDestination: SE00-DEMO\nFixed monthly salary: SEK 40,000\n",
  absence: "# Absence\nTwo approved full days of unpaid absence in September 2026.\n",
  messages: "# Messages\nDeduct SEK 500 in September for the August overpayment.\nPay salary on 25 September 2026.\n",
};

test("raw evidence uses the fixed Luna High Structured Outputs request and produces a sealed proposal", async () => {
  const requests = [];
  const restore = installFakeFetch([readyAssessment()], requests);
  try {
    const caseBundle = makeCase(evidenceDocuments());
    const result = await consolidate(caseBundle);
    assert.equal(result.kind, "proposal");
    assert.equal(result.canonical_outputs.payslip.payload.gross_pay, "36833.33 SEK");
    assert.equal(result.canonical_outputs.payslip.payload.tax_withheld, "11050.00 SEK");
    assert.equal(result.canonical_outputs.payslip.payload.net_pay, "25783.33 SEK");
    assert.equal(result.canonical_outputs.agi.payload.employer_contribution, "11573.03 SEK");
    assert.equal(result.projected_state.payload.employees[0].year_to_date.gross_pay, "116833.33 SEK");
    assert.equal(result.projected_state.payload.employees[0].year_to_date.tax_withheld, "35050.00 SEK");
    assert.equal(result.projected_state.payload.employees[0].year_to_date.net_pay, "81783.33 SEK");
    verifySealedContent(result.canonical_outputs.payroll_assessment);
    assert.equal(result.canonical_outputs.payroll_assessment.ref.schema_version, "2.0");
    assert.equal(result.canonical_outputs.payroll_assessment.payload.schema_version, "2.0");
    assert.equal(result.provenance.deterministic, false);
    assert.equal(result.provenance.assessment.mode, "model_assessment");
    assert.equal(result.provenance.calculation.deterministic, true);
    assert.equal(result.review.controls.assessment_citations_validated, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, "gpt-5.6-luna");
    assert.deepEqual(requests[0].reasoning, { effort: "high" });
    assert.equal(requests[0].store, false);
    assert.deepEqual(requests[0].tools, []);
    assert.equal(requests[0].text.format.type, "json_schema");
    assert.equal(requests[0].text.format.strict, true);
    assert.deepEqual(requests[0].text.format.schema, PAYROLL_ASSESSMENT_SCHEMA);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
  } finally {
    restore();
  }
});

test("model-declared missing facts and unsupported facts remain non-proposal outcomes", async () => {
  const missing = baseAssessment({
    status: "needs_input",
    employee: { employee_id: "employee-1", name: "Kim Example", personal_identity_number: null, payment_destination: null },
    payment_date: null,
    pay_components: [],
    citations: [],
    questions: [{ code: "MISSING_PAYMENT_DETAILS", field: "payment_date", prompt: "Confirm payment date and destination.", related_document_ids: ["messages"] }],
  });
  let restore = installFakeFetch([missing], []);
  try {
    const result = await consolidate(makeCase(evidenceDocuments()));
    assert.equal(result.kind, "needs_input");
    assert.equal(result.questions[0].code, "MISSING_PAYMENT_DETAILS");
    assert.ok(result.canonical_outputs.payroll_assessment);
    assert.equal(result.projected_state, null);
  } finally {
    restore();
  }

  const unsupported = baseAssessment({
    status: "out_of_scope",
    reasons: [{ code: "MULTIPLE_EMPLOYEES", message: "The evidence concerns multiple employees.", related_document_ids: ["employment"] }],
  });
  restore = installFakeFetch([unsupported], []);
  try {
    const result = await consolidate(makeCase(evidenceDocuments()));
    assert.equal(result.kind, "out_of_scope");
    assert.equal(result.reasons[0].code, "MULTIPLE_EMPLOYEES");
    assert.ok(result.canonical_outputs.payroll_assessment);
  } finally {
    restore();
  }
});

test("mixed raw and normalized input modes return needs_input without calling the model", async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("must not be called");
  };
  try {
    const normalized = document("normalized", JSON.stringify({}), "payroll-input", "application/json");
    const result = await consolidate(makeCase([...evidenceDocuments(), normalized]));
    assert.equal(result.kind, "needs_input");
    assert.equal(result.questions[0].code, "AMBIGUOUS_PAYROLL_INPUT_MODE");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tampered evidence is rejected before any API request", async () => {
  const documents = evidenceDocuments();
  documents[0] = { ...documents[0], sha256: "0".repeat(64) };
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("must not be called");
  };
  await assert.rejects(
    () => consolidate(makeCase(documents)),
    (error) => error.code === "BERGBOK_PAYROLL_EVIDENCE_INTEGRITY" && /SHA-256 mismatch/.test(error.message),
  );
  assert.equal(called, false);
  globalThis.fetch = originalFetch;
});

test("an invalid citation gets one repair call and a corrected assessment can proceed", async () => {
  const invalid = readyAssessment();
  invalid.citations[0].line_end = 999;
  const requests = [];
  const restore = installFakeFetch([invalid, readyAssessment()], requests);
  try {
    const result = await consolidate(makeCase(evidenceDocuments()));
    assert.equal(result.kind, "proposal");
    assert.equal(result.provenance.assessment.attempts, 2);
    assert.equal(requests.length, 2);
    assert.match(requests[1].input[0].content[0].text, /one allowed repair attempt/);
    assert.match(requests[1].input[0].content[0].text, /line_end exceeds the document/);
  } finally {
    restore();
  }
});

test("exhausted repair, refusal, timeout, and API failure are technical errors", async () => {
  const invalid = readyAssessment();
  invalid.citations[0].line_end = 999;
  let restore = installFakeFetch([invalid, invalid], []);
  try {
    await assert.rejects(() => consolidate(makeCase(evidenceDocuments())), { code: "BERGBOK_PAYROLL_ASSESSMENT_INVALID" });
  } finally {
    restore();
  }

  restore = installRawFetch(async () => responseObject({
    id: "resp-refusal",
    status: "completed",
    output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot assess." }] }],
  }));
  try {
    await assert.rejects(() => consolidate(makeCase(evidenceDocuments())), { code: "BERGBOK_PAYROLL_MODEL_REFUSAL" });
  } finally {
    restore();
  }

  restore = installRawFetch(async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });
  try {
    await assert.rejects(() => consolidate(makeCase(evidenceDocuments())), { code: "BERGBOK_PAYROLL_API_TIMEOUT" });
  } finally {
    restore();
  }

  restore = installRawFetch(async () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }));
  try {
    await assert.rejects(() => consolidate(makeCase(evidenceDocuments())), { code: "BERGBOK_PAYROLL_API_ERROR" });
  } finally {
    restore();
  }
});

test("evidence preparation rejects invalid UTF-8 and unsupported media", () => {
  const invalidUtf8 = {
    document_id: "bad",
    role: "payroll-evidence",
    media_type: "text/plain",
    content_base64: Buffer.from([0xc3, 0x28]).toString("base64"),
    byte_length: 2,
    sha256: sha256Bytes(Buffer.from([0xc3, 0x28])),
  };
  const invalid = prepareEvidenceDocuments([invalidUtf8]);
  assert.equal(invalid.ok, false);
  assert.match(invalid.questions[0].prompt, /valid UTF-8/);
  const unsupported = prepareEvidenceDocuments([document("pdf", "not a pdf", "payroll-evidence", "application/pdf")]);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.questions[0].code, "UNSUPPORTED_EVIDENCE_MEDIA_TYPE");
});

function readyAssessment() {
  return baseAssessment({
    status: "ready",
    employee: {
      employee_id: "employee-1",
      name: "Kim Example",
      personal_identity_number: "19900101-0000",
      payment_destination: "SE00-DEMO",
    },
    payment_date: "2026-09-25",
    pay_components: [
      { type: "fixed_monthly_salary", description: "Fixed monthly salary", amount: "40000.00 SEK", days: null, relates_to_period: null },
      { type: "ordinary_absence", description: "Two approved unpaid days", amount: null, days: 2, relates_to_period: null },
      { type: "correction", description: "August overpayment correction", amount: "-500.00 SEK", days: null, relates_to_period: "2026-08" },
    ],
    citations: [
      cite("employee.employee_id", "employment", 2),
      cite("employee.name", "employment", 3),
      cite("employee.personal_identity_number", "employment", 4),
      cite("employee.payment_destination", "employment", 5),
      cite("payment_date", "messages", 3),
      cite("pay_components[0]", "employment", 6),
      cite("pay_components[1]", "absence", 2),
      cite("pay_components[2]", "messages", 2),
    ],
  });
}

function baseAssessment(overrides = {}) {
  return {
    schema_version: "2.0",
    status: "needs_input",
    employee: { employee_id: null, name: null, personal_identity_number: null, payment_destination: null },
    payment_date: null,
    pay_components: [],
    citations: [],
    questions: [{ code: "MISSING_FACTS", field: "documents", prompt: "Provide the missing facts.", related_document_ids: [] }],
    warnings: [],
    reasons: [],
    ...overrides,
    ...(overrides.status === "ready" ? { questions: overrides.questions ?? [], reasons: overrides.reasons ?? [] } : {}),
    ...(overrides.status === "out_of_scope" ? { questions: overrides.questions ?? [] } : {}),
  };
}

function cite(factPath, documentId, line) {
  return { fact_path: factPath, document_id: documentId, line_start: line, line_end: line };
}

function evidenceDocuments() {
  return [
    document("employment", TEXTS.employment),
    document("absence", TEXTS.absence),
    document("messages", TEXTS.messages),
  ];
}

function document(documentId, text, role = "payroll-evidence", mediaType = "text/markdown") {
  const bytes = Buffer.from(text, "utf8");
  return {
    document_id: documentId,
    filename: `${documentId}.md`,
    role,
    media_type: mediaType,
    content_base64: bytes.toString("base64"),
    byte_length: bytes.length,
    sha256: sha256Bytes(bytes),
  };
}

function makeCase(documents) {
  const docset = sealContent({
    schemaId: "se.bergbok.docset",
    stableId: "example-ab:2026-09:docset",
    version: 1,
    payload: { documents },
  });
  const payrollState = sealContent({
    schemaId: "se.bergbok.payroll.state",
    schemaVersion: "2.0",
    stableId: "example-ab:payroll-state",
    version: 1,
    payload: {
      schema_version: "2.0",
      employees: [{
        employee_id: "employee-1",
        name: "Kim Example",
        year_to_date: {
          reporting_year: "2026",
          gross_pay: "80000.00 SEK",
          tax_withheld: "24000.00 SEK",
          employer_contribution_basis: "80000.00 SEK",
          employer_contribution: "25136.00 SEK",
          net_pay: "56000.00 SEK",
        },
      }],
    },
  });
  return sealContent({
    schemaId: "se.bergbok.consolidation-case",
    stableId: "example-ab:2026-09:payroll",
    version: 1,
    payload: {
      contract_version: "1.0",
      company_id: "example-ab",
      domain: "payroll",
      period: { id: "2026-09", kind: "ordinary", start: "2026-09-01", end: "2026-09-30" },
      docset,
      previous_state: createStateEnvelope({ companyId: "example-ab", sequence: 1, core: {}, domains: { payroll: payrollState } }),
      upstream_results: [],
      effective_policies: {
        core: { country: "SE", currency: "SEK" },
        payroll: {
          profile: "simple-payroll-demo-v1",
          daily_divisor: 30,
          withholding_basis_points: 3_000,
          employer_contribution_basis_points: 3_142,
        },
      },
    },
  });
}

function installFakeFetch(assessments, requests) {
  let index = 0;
  return installRawFetch(async (_url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${KEY}`);
    requests.push(JSON.parse(options.body));
    const assessment = assessments[Math.min(index, assessments.length - 1)];
    index += 1;
    return responseObject({
      id: `resp-test-${index}`,
      status: "completed",
      output_text: JSON.stringify(assessment),
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });
  });
}

function installRawFetch(fetchImpl) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalBase = process.env.OPENAI_BASE_URL;
  globalThis.fetch = fetchImpl;
  process.env.OPENAI_API_KEY = KEY;
  process.env.OPENAI_BASE_URL = "https://fake.openai.invalid/v1";
  return () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
  };
}

function responseObject(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
