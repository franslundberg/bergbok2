# Bookkeeping

Bookkeeping owns Swedish bookkeeping interpretation, calculation, projected
Bookkeeping State, canonical bookkeeping outputs, and review material behind
one public operation:

```text
await consolidate(ConsolidationCase, variantRef?) -> ModuleOutcome
```

Accounting calculations, input parsing, payroll-facts validation, and review
narrative validation are private supporting libraries under `src/private/`.
Bookkeeping cannot approve, render reports, or persist authoritative State.

Bookkeeping resolves `ConsolidationCase.payload.language` (`sv` or `en`, with
Swedish as the legacy default), records it in `review.language`, and localizes
module-generated review text. Source-provided names, descriptions, and quoted
evidence remain unchanged.

Module version 4.0.0 emits schema-v3 input, output, State, and period-delta
payloads with canonical Decision 0001 Money strings such as `"48406.36 SEK"`.
A single boundary adapter still reads sealed schema-v1 integer-ore input and
State. Schema-v2 Bookkeeping data has no compatibility adapter.

Start establishes the company-owned bookkeeping policy from evidence. The
current Pilot accepts BAS plus quarterly VAT reporting with explicit input,
output, and settlement accounts. Once approved, later periods receive this
policy from trusted company State. The kernel—not AI—derives calendar-quarter
boundaries. Non-quarter-end periods reject declaration boxes and VAT closing
entries; quarter-end periods require a final transaction on the cycle end that
matches the declaration and clears configured VAT accounts to settlement.

Each outcome contains a structured review with a frozen language, one
consolidation summary, and exactly one strong plain-text summary for every
canonical transaction. Each transaction summary combines the event with its
bookkeeping treatment and includes a reason only for a material assumption,
tax classification, or non-obvious judgment. The canonical transaction
description remains available for bookkeeping formats and integrations but is
not a second narrative in the human report. Proposal canonical outputs contain
the complete Bookkeeping output and its period delta. Artifacts turns the later
`OutputSnapshot` into the human-readable HTML and PDF; Bookkeeping does not
produce Markdown.

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
Documents for Start, partial May, June, July, and August. The fixture period catalog in
`demo/fixtures/fiktiv-ab/periods.json` supplies each Period's ID and dates. It
runs only Start and produces an unapproved Proposal. After each approval the
terminal prints the exact next command. The complete fixture flow is:

```sh
npm run demo:bookkeeping -- approve --workspace PATH --run RUN_ID
npm run demo:bookkeeping -- run --workspace PATH --period 2026-05
npm run demo:bookkeeping -- approve --workspace PATH --run RUN_ID
npm run demo:bookkeeping -- run --workspace PATH --period 2026-06
npm run demo:bookkeeping -- approve --workspace PATH --run RUN_ID
npm run demo:bookkeeping -- run --workspace PATH --period 2026-07
npm run demo:bookkeeping -- approve --workspace PATH --run RUN_ID
npm run demo:bookkeeping -- run --workspace PATH --period 2026-08
npm run demo:bookkeeping -- status --workspace PATH
```

To run the complete fixture catalog non-interactively, automatically approve
each complete proposal, and continue through the months, use:

```sh
npm run demo:bookkeeping:complete
```

This defaults to `gpt-5.6-luna`; pass `--model gpt-5.6-sol` to use Sol,
`--actor NAME` to set the approver, or `--allow-web` to enable filtered public
egress. The runner stops before approval when a period needs input, is out of
scope, or fails technically.

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

If a run returns `needs_input`, open its review report, then add an answer note or missing source to the
visible Period directory and run that Period again. A Period from the fixture
catalog needs only its ID; a custom ordinary Period still needs explicit
bounds. Each rerun freezes a new
Docset version; approval rejects a Proposal if the visible bytes have changed.

`gpt-5.6-luna` with high reasoning is the
default; pass `--model gpt-5.6-sol` for the stronger model or `--allow-web` to
enable filtered public egress. The API key is read from `OPENAI_API_KEY` or the
repository's untracked `.env.local` and is never mounted into Docker.
The AI worker allows up to 100 model calls and 60 minutes for one assessment,
alongside independent per-call, tool-output, and container resource limits.

Use `npm run demo:bookkeeping:offline` for the fixed, no-network example. Each
completed Bookkeeping run writes `review-source.json`, `review.html`, and
`review.pdf` alongside technical case and outcome diagnostics.
See the root [module handbook](../../MODULES.md) for the full boundary.
