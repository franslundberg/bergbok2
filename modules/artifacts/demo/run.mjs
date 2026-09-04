import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { render } from "../src/index.mjs";
import { prettyCanonicalJson } from "../../../contracts/src/canonical.mjs";
import { sealContent } from "../../../contracts/src/index.mjs";
import { allocateRunDirectory } from "../../../dev/demo-run-directory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : await allocateRunDirectory(path.join(here, "generated"));

const canonicalOutputs = {
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
        evidence_ids: ["260312-1"],
        lines: [
          { account: "1930", account_name: "Bank", debit: "125.00 SEK", credit: "0.00 SEK" },
          { account: "1510", account_name: "Accounts receivable", debit: "0.00 SEK", credit: "125.00 SEK" },
        ],
      }],
    },
    vat_period: {
      reporting_period_start: "2026-01-01",
      reporting_period_end: "2026-03-31",
      declaration_boxes: { "10": "100.00 SEK", "11": "0.00 SEK", "12": "0.00 SEK", "48": "20.00 SEK", "49": "80.00 SEK" },
    },
  },
  payroll: {
    schema_version: "2.0",
    period_id: "2026-03",
    payslips: [{
      employee_id: "employee-1",
      employee_name: "Demo Employee",
      period_id: "2026-03",
      gross_pay: "30000.00 SEK",
      tax_withheld: "9000.00 SEK",
      net_pay: "21000.00 SEK",
    }],
  },
};

const approvedSnapshot = sealContent({
  schemaId: "se.bergbok.output-snapshot",
  schemaVersion: "2.0",
  stableId: "example-ab:2026-03:approved-output",
  version: 1,
  payload: {
    schema_version: "2.0",
    approval_status: "approved",
    language: "sv",
    review: { language: "sv" },
    canonical_outputs: canonicalOutputs,
  },
});
const previewSnapshot = sealContent({
  schemaId: "se.bergbok.output-snapshot",
  schemaVersion: "2.0",
  stableId: "example-ab:2026-03:preview-output",
  version: 1,
  payload: {
    schema_version: "2.0",
    approval_status: "preliminary",
    language: "sv",
    review: { language: "sv" },
    canonical_outputs: canonicalOutputs,
  },
});

const jobs = [
  ["approved-sie", approvedSnapshot, "sie4-v1"],
  ["approved-vat-xml", approvedSnapshot, "vat-xml-v1"],
  ["approved-vat-pdf", approvedSnapshot, "vat-verification-pdf-v1"],
  ["approved-payslips", approvedSnapshot, "payslips-pdf-v1"],
  ["preview-review", previewSnapshot, "review-markdown-v1"],
  ["preview-sie", previewSnapshot, "sie4-v1"],
];
const reportRows = [];
await mkdir(outputRoot, { recursive: true });
for (const [name, snapshot, profile] of jobs) {
  const first = render(snapshot, profile);
  const second = render(snapshot, profile);
  if (first.ref.sha256 !== second.ref.sha256) throw new Error(`${profile} was not reproducible`);
  const directory = path.join(outputRoot, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "bundle.json"), prettyCanonicalJson(first));
  for (const artifact of first.payload.artifacts) {
    await writeFile(path.join(directory, artifact.filename), Buffer.from(artifact.content_base64, "base64"));
    reportRows.push(`| ${profile} | ${first.payload.language ?? "—"} | ${first.payload.preview ? "yes" : "no"} | ${artifact.filename} | \`${artifact.sha256}\` |`);
  }
}

await writeFile(path.join(outputRoot, "manifest.json"), prettyCanonicalJson({
  schema_id: "se.bergbok.demo-run",
  schema_version: "1.0",
  module: "artifacts",
  source_refs: [approvedSnapshot.ref, previewSnapshot.ref],
  profiles: jobs.map(([, , profile]) => profile),
}));
await writeFile(path.join(outputRoot, "report.md"), [
  "# Artifacts demo",
  "",
  "Every profile was rendered twice through the public `Artifacts.render` interface and produced the same bundle digest.",
  "",
  "| Profile | Language | Preview | File | SHA-256 |",
  "|---|---|---:|---|---|",
  ...reportRows,
  "",
  "Preview material is visibly marked. No artifact was submitted, filed, emailed, or paid.",
  "",
].join("\n"));

console.log(outputRoot);
