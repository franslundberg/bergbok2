# Public module handbook

The public package root exposes five namespaces and the shared outer-contract
helpers. Paths, filesystem layouts, calculation kernels, validation strategies,
model clients, and execution controls are intentionally absent from processor
interfaces.

```js
import {
  CompanyRecord,
  Bookkeeping,
  Payroll,
  Artifacts,
  EvaluationLab,
} from "@bergbok/modular-system";
```

## 1. Company Record

Company Record is the sole authoritative writer. Its initial adapter is one
inspectable directory per company.

```text
CompanyRecord.create({ rootDir, companyId, initialState?, language?, actor?, clock? })
    -> CompanyRecord
CompanyRecord.open({ rootDir, companyId?, clock? }) -> CompanyRecord

record.ingest(item, actor) -> LogItemRef
record.reviseDocset(period, expectedHead, changes) -> DocsetRevision
record.prepare(domain, period, options?) -> ConsolidationCase
record.setLanguage("sv" | "en", actor) -> LanguageChange
record.record(caseRef, ModuleOutcome) -> ConsolidationRun
record.approve(runRef, decision) -> ApprovalResult
record.read(ref | query) -> immutable snapshot
```

`ingest` preserves the original bytes and returns a stable immutable Log item
reference. It does not assign accounting meaning or mutate a period. A Docset
revision explicitly adds or copies a Log item into a period, and optimistic
`expectedHead` checking prevents lost updates. A copy gets a new stable period
document ID while retaining identical original bytes.

A Period is defined once with one canonical object. Start and Import use
`{id, kind, end}`; an ordinary Period uses `{id, kind: "ordinary", start, end}`
with inclusive ISO dates. A string ID may refer to a Period after that full
definition has been stored, but cannot create or redefine one.

`prepare` is the deep read operation. It freezes a portable case with the exact
Docset, exact preceding State, effective policies, and selected immutable
upstream results. Company Record uses stored Period dates and authoritative
State lineage—not Period names—to reject changes to earlier work after a later
Period has authoritative State. Late material belongs in the last open Period.

`record` persists the complete outcome without making it authoritative.
`approve` requires an explicit authorized decision:

```js
{
  decision: "approved", // or "rejected"
  actor: { id: "reviewer-1", role: "approver" },
  authority: { kind: "role", role: "approver" },
  expectedRunSha256: "...", // optional but recommended
  close: false,
}
```

Approval recomputes and verifies the complete run, exact case inputs, current
Docset, predecessor State, and upstream-result heads. Only a `proposal` can
publish State. A changed byte or stale reference invalidates eligibility.

Useful read queries include `{kind:"state"}`, `{kind:"period", period}`,
`{kind:"docset", period}`, `{kind:"output_snapshot", runRef}`, and
`{kind:"timeline", format:"markdown"}`.

`read({kind:"company_settings"})` returns the current presentation language.
It defaults to Swedish (`sv`) for new and legacy records. `setLanguage` records
a Company Record timeline event and affects only cases prepared afterward;
`prepare` freezes the selected language into the case.

## 2. Bookkeeping

```text
await Bookkeeping.consolidate(ConsolidationCase, variantRef?)
    -> ModuleOutcome
```

Bookkeeping accepts only a case whose domain is `bookkeeping`. A raw Docset is
assessed by a bounded model agent inside a read-only Docker worker and its typed
candidate is checked by the private deterministic Accounting Kernel. The
`bookkeeping-input` role remains available as an offline deterministic adapter
for tests and aggregate demos. Start, Import, and arbitrary inclusive ordinary
intervals are supported for the narrow Swedish Pilot profile. The operation
returns one of:

- `proposal`, with a sealed projected Bookkeeping State, canonical bookkeeping
  output, provenance, warnings, evidence, and a Markdown review;
- `needs_input`, with explicit questions and no projected State; or
- `out_of_scope`, with explicit reasons and no projected State.

Bookkeeping resolves the frozen case language (Swedish by default for legacy
cases), writes it to `review.language`, and localizes module-generated review
text. Source-provided names, descriptions, and quoted evidence remain
unchanged.

Bookkeeping module version 2.0.0 writes schema-v2 monetary fields as Decision
0001 Money strings. It reads schema-v1 integer-ore inputs and preceding State
through one boundary adapter without rewriting sealed historical content.

The public interface does not expose the accounting validator or calculation
kernel. Bookkeeping accepts Payroll only as immutable `PayrollAccountingFacts`
inside an authority-bearing upstream wrapper. These facts contain semantic
expenses and liabilities, not account numbers. Bookkeeping's assessment must
assign every fact to an account; deterministic validation derives the journal
amounts from the sealed facts and rejects missing, duplicate, or unknown
assignments. It rejects a mutable or bare Payroll proposal.

A first Start or Import proposal may include evidence-backed core-State
initialization. Start publishes zero Bookkeeping State and no transactions.
Import publishes balanced imported balances, open items, and verification
continuity; its exact Docset and Run retain the detailed historical evidence.
Company Record accepts initialization only against empty S0 and under the same
explicit approval that publishes Bookkeeping State. Ordinary runs cannot
rewrite core identity and must immediately continue the preceding
`through_date`.


**Resources for bookkeeping agent**. Note 2026-09-04 by Frans. 

The current implementation gives AI data from the 
last State and current Docset, that is: `S[n-1], D[n]`.
As the system evolves, we may make the following additional resources available to the 
AI agent:

```text
  history: read-only company history view
  knowledge: approved Bergbok knowledge collections
  web: web-search capability
```

These resources can be made available to the AI in different ways. 
The `book` command-line tool for the AI workspace is one option. 
Passing more data directly in the `consolidate()` call is another.
We can also give the AI a direct tool to use, specified to Open AI.
In addition to the `shell` tool that it gets today.

With the Evalution Lab that we are developing, we will be able to measure the
quality of bookkeeping and with that we can test what additional resources
to provide to AI and in what way.


## 3. Payroll

```text
await Payroll.consolidate(ConsolidationCase, variantRef?)
    -> ModuleOutcome
```

Payroll has the same outer shape as Bookkeeping but owns different rules and
State. The current `simple-payroll-demo-v1` profile reads immutable Markdown or
text documents with role `payroll-evidence`. A fixed private GPT-5.6 Luna High
assessor returns structured extracted facts and line citations; deterministic
code checks document integrity, schema, citations, dates, monetary amounts, and
profile limits before the private kernel calculates salary, ordinary absence,
signed correction, payslip, payment instruction, AGI data, projected State,
and normalized semantic accounting facts.

One `payroll-input` JSON document remains as a transitional, offline-compatible
path. If normalized input and raw evidence occur together, Payroll returns
`needs_input` instead of choosing silently. The model and reasoning profile are
private and fixed; only credentials come from the environment.

Payroll returns proposals only. It never writes the ledger, approves a run,
sends a payment, or files a report. Company Record turns proposed accounting
facts into an approved immutable upstream wrapper; Bookkeeping owns the
consumer-facing facts schema and chooses the ledger treatment during its own
assessment. Payroll fixes the amounts and obligations; Bookkeeping chooses the
accounts.

Payroll module version 2.0.0 likewise writes schema-v2 Money strings and reads
schema-v1 normalized input and preceding State through an explicit adapter.

The initial policy values are illustrative demo rules, not authoritative
Swedish payroll law.

Payroll also resolves the case language and records it in `review.language`;
generated review text and payslip labels use that frozen language.

## 4. Artifacts

```text
Artifacts.render(outputSnapshot, artifactProfile) -> ArtifactBundle
```

Registered profiles are `review-markdown-v1`, `sie4-v1`, `vat-xml-v1`,
`vat-verification-pdf-v1`, and `payslips-pdf-v1`. Rendering is deterministic:
the bundle embeds every file's bytes, media type, byte length, and SHA-256.
Artifacts derived from a preliminary snapshot are visibly marked as previews.

Artifacts performs no submission, filing, payment, email, or delivery.

Review Markdown and payslip PDFs use the language frozen in the output
snapshot; callers cannot override it at render time. SIE, VAT XML, and VAT
verification PDF content remain unchanged. Artifact bundles expose the
resolved language for the human-facing profiles.

## 5. Evaluation Lab (development only)

```text
EvaluationLab.evaluate(testCase, candidate, gradingProfile?)
    -> EvaluationPackage
EvaluationLab.runTrials(testCase, variants, trialPlan)
    -> ExperimentPackage
```

Evaluation Lab owns references and Grading Manuals and never supplies them to a
candidate runner. It separates deterministic contract/economic failures from
semantic findings, supports declared account equivalence, rejects invented
transactions or evidence, and reports repeated-run pass rate, cost, time, and
steps. Trial counts and thresholds belong to the versioned grading profile;
there is no global five-run rule.

`loadCaseDirectory` is available from the explicitly named
`@bergbok/modular-system/evaluation-lab/directory-adapter` export. The common
case layout is:

```text
case/
├── manifest.json
├── input/
│   ├── state/
│   └── docset/
├── reference/
│   ├── state/
│   └── outputs/
└── grading-manual.md
```

An independent AI semantic grader can later be installed as a private Lab
adapter. It is intentionally not part of production validation or approval.

## Shared outer contracts

The language-neutral schemas under `contracts/` cover `ContentRef`,
`ConsolidationCase`, `ModuleOutcome`, `StateEnvelope`, `ApprovalReceipt`, and
`ArtifactBundle`. Domain payload schemas evolve independently under their owner.
The JavaScript reference exports `PERIOD_KINDS` and `assertPeriod` for the
canonical Period definition. All approval-relevant content is canonicalized
and SHA-256 bound.
