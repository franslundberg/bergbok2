import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { render } from "../src/index.mjs";
import { sha256Bytes } from "../../../contracts/src/canonical.mjs";
import { sealContent, verifySealedContent } from "../../../contracts/src/index.mjs";

const outputs = {
  bookkeeping: {
    generated_date: "2026-03-31",
    organization: { name: "Example AB", organization_number: "559999-9999" },
    ledger: {
      transactions: [{
        verification_id: "A1",
        date: "2026-03-12",
        description: "Customer payment",
        lines: [
          { account: "1930", account_name: "Bank", debit_ore: 12500, credit_ore: 0 },
          { account: "1510", account_name: "Receivables", debit_ore: 0, credit_ore: 12500 },
        ],
      }],
    },
    vat_period: {
      reporting_period_start: "2026-01-01",
      reporting_period_end: "2026-03-31",
      declaration_boxes_sek: { "10": 100, "11": 0, "12": 0, "48": 20, "49": 80 },
    },
  },
};

function snapshot(status = "preliminary") {
  return sealContent({
    schemaId: "se.bergbok.output-snapshot",
    stableId: "example:2026-03:bookkeeping",
    version: 1,
    payload: { approval_status: status, language: "en", review: { language: "en" }, canonical_outputs: outputs },
  });
}

function v2Snapshot(status = "approved", vatAmount = "100.00 SEK") {
  return sealContent({
    schemaId: "se.bergbok.output-snapshot",
    schemaVersion: "2.0",
    stableId: "example:2026-03:bookkeeping-v2",
    version: 1,
    payload: {
      schema_version: "2.0",
      approval_status: status,
      canonical_outputs: {
        bookkeeping: {
          schema_version: "2.0",
          generated_date: "2026-03-31",
          organization: { name: "Example AB", organization_number: "559999-9999" },
          ledger: {
            currency: "SEK",
            transactions: [{
              verification_id: "A1",
              date: "2026-03-12",
              description: "Customer payment",
              lines: [
                { account: "1930", account_name: "Bank", debit: "125.00 SEK", credit: "0.00 SEK" },
                { account: "1510", account_name: "Receivables", debit: "0.00 SEK", credit: "125.00 SEK" },
              ],
            }],
          },
          vat_period: {
            reporting_period_start: "2026-01-01",
            reporting_period_end: "2026-03-31",
            declaration_boxes: { "10": vatAmount, "11": "0.00 SEK", "12": "0.00 SEK", "48": "20.00 SEK", "49": "80.00 SEK" },
          },
        },
      },
    },
  });
}

function payslipSnapshot(schemaVersion) {
  const canonical = schemaVersion === "2.0";
  return sealContent({
    schemaId: "se.bergbok.output-snapshot",
    schemaVersion,
    stableId: `example:2026-03:payslip-${schemaVersion}`,
    version: 1,
    payload: {
      ...(canonical ? { schema_version: "2.0" } : {}),
      approval_status: "approved",
      canonical_outputs: {
        payroll: {
          ...(canonical ? { schema_version: "2.0" } : {}),
          period_id: "2026-03",
          payslips: [{
            employee_id: "employee-1",
            employee_name: "Demo Employee",
            period_id: "2026-03",
            ...(canonical
              ? { gross_pay: "30000.00 SEK", tax_withheld: "9000.00 SEK", net_pay: "21000.00 SEK" }
              : { gross_pay_ore: 3_000_000, tax_withheld_ore: 900_000, net_pay_ore: 2_100_000 }),
          }],
        },
      },
    },
  });
}

function artifactBytes(artifact) {
  const bytes = Buffer.from(artifact.content_base64, "base64");
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(sha256Bytes(bytes), artifact.sha256);
  return bytes;
}

test("rendering is deterministic and the complete artifact bundle is sealed", () => {
  const first = render(snapshot("approved"), "sie4-v1");
  const second = render(snapshot("approved"), "sie4-v1");
  assert.deepEqual(first, second);
  verifySealedContent(first);
  assert.match(artifactBytes(first.payload.artifacts[0]).toString("utf8"), /#VER "A" 1 20260312/);
});

test("unapproved SIE, XML, Markdown, and PDF are visibly marked as previews", () => {
  const cases = [
    ["sie4-v1", "utf8", /PREVIEW - NOT APPROVED/],
    ["vat-xml-v1", "latin1", /PREVIEW - NOT APPROVED/],
    ["review-markdown-v1", "utf8", /PREVIEW - this material is not approved/],
    ["vat-verification-pdf-v1", "latin1", /PREVIEW - NOT APPROVED/],
  ];
  for (const [profile, encoding, pattern] of cases) {
    const bundle = render(snapshot(), profile);
    assert.equal(bundle.payload.preview, true);
    assert.match(artifactBytes(bundle.payload.artifacts[0]).toString(encoding), pattern);
  }
});

test("approved artifacts omit preview marking", () => {
  const bundle = render(snapshot("approved"), "vat-verification-pdf-v1");
  assert.equal(bundle.payload.preview, false);
  assert.doesNotMatch(artifactBytes(bundle.payload.artifacts[0]).toString("latin1"), /NOT APPROVED/);
  assert.match(artifactBytes(bundle.payload.artifacts[0]).toString("latin1", 0, 8), /^%PDF-1/);
});

test("review and payslip artifacts use Swedish when the snapshot has no language", () => {
  const swedish = render(sealContent({
    schemaId: "se.bergbok.output-snapshot",
    stableId: "example:2026-03:swedish",
    version: 1,
    payload: {
      approval_status: "preliminary",
      canonical_outputs: outputs,
    },
  }), "review-markdown-v1");
  assert.equal(swedish.payload.language, "sv");
  assert.match(artifactBytes(swedish.payload.artifacts[0]).toString("utf8"), /# Bergbok granskningspaket/);
  assert.match(artifactBytes(swedish.payload.artifacts[0]).toString("utf8"), /FÖRHANDSVISNING/);

  const payslip = render(payslipSnapshot("2.0"), "payslips-pdf-v1");
  assert.equal(payslip.payload.language, "sv");
  assert.match(artifactBytes(payslip.payload.artifacts[0]).toString("latin1"), /Lönespecifikation/);
  assert.match(artifactBytes(payslip.payload.artifacts[0]).toString("latin1"), /Bruttolön/);
});

test("format profiles match reviewed golden hashes", async () => {
  const golden = JSON.parse(await readFile(new URL("./golden/artifact-hashes.json", import.meta.url), "utf8"));
  for (const [status, approvalStatus] of [["approved", "approved"], ["preliminary", "preliminary"]]) {
    for (const [profile, expectedSha256] of Object.entries(golden[status])) {
      const bundle = render(snapshot(approvalStatus), profile);
      assert.equal(bundle.payload.artifacts[0].sha256, expectedSha256, `${status} ${profile}`);
    }
  }
});

test("v1 and v2 Money payloads render equivalent SIE and VAT artifacts", () => {
  for (const profile of ["sie4-v1", "vat-xml-v1", "vat-verification-pdf-v1"]) {
    const legacy = render(snapshot("approved"), profile).payload.artifacts[0];
    const canonical = render(v2Snapshot("approved"), profile).payload.artifacts[0];
    assert.equal(canonical.sha256, legacy.sha256, profile);
  }
});

test("v1 and v2 payslips render equivalent artifacts", () => {
  const legacy = render(payslipSnapshot("1.0"), "payslips-pdf-v1").payload.artifacts[0];
  const canonical = render(payslipSnapshot("2.0"), "payslips-pdf-v1").payload.artifacts[0];
  assert.equal(canonical.sha256, legacy.sha256);
});

test("VAT rendering rejects fractional-krona canonical boxes", () => {
  assert.throws(() => render(v2Snapshot("approved", "100.01 SEK"), "vat-xml-v1"), /whole SEK/);
});

test("artifact rendering rejects mixed v2 and legacy money fields and schema mismatches", () => {
  const source = v2Snapshot();
  const mixedPayload = structuredClone(source.payload);
  mixedPayload.canonical_outputs.bookkeeping.ledger.transactions[0].lines[0].debit_ore = 12500;
  const mixed = sealContent({
    schemaId: source.ref.schema_id,
    schemaVersion: "2.0",
    stableId: "example:mixed",
    version: 1,
    payload: mixedPayload,
  });
  assert.throws(() => render(mixed, "sie4-v1"), /unit-suffixed/);

  const mismatch = sealContent({
    schemaId: source.ref.schema_id,
    schemaVersion: "2.0",
    stableId: "example:mismatch",
    version: 1,
    payload: { ...structuredClone(source.payload), schema_version: "1.0" },
  });
  assert.throws(() => render(mismatch, "sie4-v1"), /schema versions disagree/);
});
