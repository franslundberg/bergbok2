# Company Record

Company Record is Bergbok's sole authoritative company-memory and write
boundary. Its public facade is implemented in `src/index.mjs`; filesystem and
atomic-storage mechanics remain private under `src/private/`.

```text
CompanyRecord.create({ rootDir, companyId, initialState?, language?, actor?, clock? })
    -> CompanyRecord
CompanyRecord.open({ rootDir, companyId?, clock? }) -> CompanyRecord

ingest(item, actor) -> LogItemRef
reviseDocset(period, expectedHead, changes) -> DocsetRevision
prepare(domain, period, options) -> ConsolidationCase
setLanguage("sv" | "en", actor) -> LanguageChange
record(caseRef, outcome) -> ConsolidationRun
approve(runRef, decision) -> ApprovalResult
read(ref | query) -> immutable snapshot
```

The Company Record presentation language is Swedish (`sv`) by default. English
can be selected at creation or changed later with `setLanguage`; changes are
recorded in the timeline and apply only to future prepared cases. Use
`read({ kind: "company_settings" })` to inspect the current value. Each case
freezes the language it inherited, so later company-level changes cannot alter
existing cases, runs, approvals, or output snapshots.

Every recorded run can be read as a preliminary `OutputSnapshot` v2. Approval
publishes an approved snapshot of the same complete outcome. The snapshot binds
approval status, frozen language, run reference, proposal digest, company,
domain, complete Period, Docset and preceding-State references, the complete
`ModuleOutcome`, and the run's recorded timestamp. It is the only persisted
source for approval review rendering; Company Record does not persist a second
report model.

The first approved Bookkeeping Start or Import may initialize core State. That
initialization must include a complete quarterly BAS VAT policy, and later
periods cannot rewrite it. Company Record therefore owns the trusted reporting
cadence that Bookkeeping receives when preparing subsequent cases.

Run its automatic tests with `npm run test:company-record` and its human-scale
demo with `npm run demo:company-record` from the repository root. The default
demo output is a concise walkthrough and the complete machine-readable result
is written to `summary.json`. Use `npm run demo:company-record -- --json` to
print that result as JSON instead.

By default, each execution creates the next `demo/generated/run-NNN` package.
For an explicit destination, use `--output DIRECTORY`; the earlier positional
`DIRECTORY` form remains supported. A run package contains the exact visible
input bytes, a developer report, JSON and Markdown timelines, the full summary,
and the inspectable Company Record store.

See the root [module handbook](../../MODULES.md) for the complete public contract.
