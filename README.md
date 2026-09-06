# Bergbok modules

This directory contains the first executable modular-monolith implementation of
the Bergbok System Concept. It has exactly five public building blocks:

1. **Company Record** — authoritative company memory and the only write boundary.
2. **Bookkeeping** — fixed bookkeeping case to questions, proposal, or out-of-scope result.
3. **Payroll** — an independently runnable Simple Payroll processor.
4. **Artifacts** — deterministic rendering of approved or preview output data.
5. **Evaluation Lab** — development-only grading and repeatable experiments.

Onboarding, monthly administration, payroll scheduling, year-end work, and
reporting chat are deliberately absent here. They will be thin workflows that
compose these modules. The modules are building blocks, so another Bergbok
variant may later select a different implementation—for example, a payroll
module whose rules fit Norway—without turning workflows or implementation
machinery into new conceptual modules.

Agent runtimes, Docker integration, model clients, validators, accounting
calculations, and payroll calculations are private supporting libraries. They
are separately testable, but they are not public Bergbok modules.

## Run it

Node.js 22 or newer is the only requirement; ordinary tests make no network or
paid-model calls.

```sh
npm test
npm run demo
```

`npm run demo` executes a small thin workflow through public interfaces only:
new-company Start, previous-system Import, an ordinary interval, Payroll approval,
the authorized Payroll-to-Bookkeeping handoff, deterministic artifacts, and an
Evaluation Lab comparison. It writes an inspectable directory beneath
`integration/demo/generated/` and prints that directory's path.

`npm run demo:modules` executes one human-readable demo for each module. Each
demo emits its canonical result and relevant human artifacts beneath that
module's own `demo/generated/run-NNN/` directory. Bookkeeping review packages
contain source JSON, standalone HTML, and expanded PDF. Runs begin at `run-001`, increase
monotonically, and never overwrite an earlier run. Individual module tests are
available as `npm run test:company-record`, `npm run test:bookkeeping`, and
corresponding commands for the other modules, contracts, and integration.

The standalone Payroll demo is the one live-model exception: it assesses real
synthetic Markdown evidence with the fixed GPT-5.6 Luna High profile. Therefore
`npm run demo:payroll` and the Payroll step in `npm run demo:modules` require
`OPENAI_API_KEY` in the exported environment or an ignored root `.env.local`;
an exported value takes precedence. `npm run demo` remains offline through the
clearly identified transitional normalized-input path.

## Repository shape

The five modules live under `modules/`. Each owns its source, private
supporting libraries, automatic tests, demo, and generated demo evidence.
Shared language-neutral envelopes live under `contracts/`; only genuinely
cross-module tests and thin-workflow demos live under `integration/`.

```text
modules/
  company-record/   bookkeeping/   payroll/
  artifacts/        evaluation-lab/
contracts/        decisions/     integration/   provenance/   dev/
```

## Read next

- [ARCHITECTURE.md](ARCHITECTURE.md) explains boundaries and authority.
- [MODULES.md](MODULES.md) is the public interface handbook.
- [contracts/README.md](contracts/README.md) describes the portable JSON envelopes.
- [Decision 0001](decisions/0001-canonical-money.md) records the accepted
  canonical monetary representation.
- [provenance/README.md](provenance/README.md) records the read-only Demo 4 and Demo 7–9 baseline used during extraction.

## Current implementation boundary

This is an executable architecture and characterization scaffold, not a
production Swedish accounting or payroll product. The first adapters use
inspectable directory storage. Bookkeeping now has an isolated model-backed
Docset-to-Proposal workflow with deterministic accounting validation and
explicit Company Record approval. Payroll has a bounded model-backed vertical
slice over synthetic Markdown evidence plus deterministic calculation; the
`simple-payroll-demo-v1` policy does not imply that current Swedish law has been
encoded. Delivery, filing, payment, email, arbitrary model selection, and
arbitrary sandbox capabilities are not implemented.

The intended next storage adapter is one SQLite database per company. Further
model and sandbox adapters remain private behind Bookkeeping and Payroll and do
not change their public `consolidate` operations.
