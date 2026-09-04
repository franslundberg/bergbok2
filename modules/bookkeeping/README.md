# Bookkeeping

Bookkeeping owns Swedish bookkeeping interpretation, calculation, projected
Bookkeeping State, canonical bookkeeping outputs, and review material behind
one public operation:

```text
await consolidate(ConsolidationCase, variantRef?) -> ModuleOutcome
```

Accounting calculations, input parsing, payroll-facts validation, and report
generation are private supporting libraries under `src/private/`. Bookkeeping
cannot approve or persist authoritative State.

Bookkeeping resolves `ConsolidationCase.payload.language` (`sv` or `en`, with
Swedish as the legacy default), records it in `review.language`, and localizes
module-generated review text. Source-provided names, descriptions, and quoted
evidence remain unchanged.

Version 2.0.0 emits schema-v2 domain payloads with canonical Decision 0001
Money strings such as `"48406.36 SEK"`. A single boundary adapter still reads
sealed schema-v1 integer-ore input and State; new output is always v2.

Approved upstream `PayrollAccountingFacts` contain semantic expenses and
liabilities without BAS account numbers. The Bookkeeping assessment assigns
each sealed `fact_id` to an account using the preceding State, approved
history, current evidence, explicit policy, and accounting knowledge. The
validator—not the model—copies the exact payroll amounts into debit and credit
lines and rejects incomplete or duplicate mappings.

Raw, user-visible Docsets use an isolated AI assessment loop followed by the
private deterministic Accounting Kernel. A Docset containing the explicit
`bookkeeping-input` role remains available as the offline deterministic test
adapter. Bookkeeping cannot approve or persist authoritative State.

From the repository root:

```sh
npm run test:bookkeeping
npm run demo:bookkeeping -- setup
npm run demo:bookkeeping
```

The second demo command creates a new Fiktiv AB workspace with visible
Documents for Start, partial May, and June. The fixture period catalog in
`demo/fixtures/fiktiv-ab/periods.json` supplies each Period's ID and dates. It
runs only Start and produces an unapproved Proposal. After each approval the
terminal prints the exact next command. The complete fixture flow is:

```sh
npm run demo:bookkeeping -- approve --workspace PATH --run RUN_ID
npm run demo:bookkeeping -- run --workspace PATH --period 2026-05
npm run demo:bookkeeping -- approve --workspace PATH --run RUN_ID
npm run demo:bookkeeping -- run --workspace PATH --period 2026-06
npm run demo:bookkeeping -- status --workspace PATH
```

The Fiktiv AB demo records `Filippa Stark` as the approver by default. Use
`--actor NAME` to override this when the fictional company gains another
authorized co-worker.

For a new company with your own startup Documents:

```sh
npm run demo:bookkeeping -- start --start-date YYYY-MM-DD --docset DIRECTORY --output WORKSPACE
```

For an existing company, Import establishes balances, open items, and
verification-series continuity through the day before the Bergbok Start Date:

```sh
npm run demo:bookkeeping -- import --start-date YYYY-MM-DD --docset DIRECTORY --output WORKSPACE
```

If a run returns `needs_input`, add an answer note or missing source to the
visible Period directory and run that Period again. A Period from the fixture
catalog needs only its ID; a custom ordinary Period still needs explicit
bounds. Each rerun freezes a new
Docset version; approval rejects a Proposal if the visible bytes have changed.

`gpt-5.6-luna` with high reasoning is the
default; pass `--model gpt-5.6-sol` for the stronger model or `--allow-web` to
enable filtered public egress. The API key is read from `OPENAI_API_KEY` or the
repository's untracked `.env.local` and is never mounted into Docker.

Use `npm run demo:bookkeeping:offline` for the old fixed, no-network example.
See the root [module handbook](../../MODULES.md) for the full boundary.
