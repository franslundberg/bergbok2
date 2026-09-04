# Architecture

## Public building blocks

Bergbok starts with five public modules:

1. **Company Record** is the sole authoritative memory and write boundary for a
   company.
2. **Bookkeeping** turns a fixed bookkeeping case into questions, an
   out-of-scope result, or a proposal.
3. **Payroll** does the same for the deliberately narrow Simple Payroll
   profile.
4. **Artifacts** renders canonical output data deterministically. It does not
   deliver or submit anything.
5. **Evaluation Lab** is a development-only module for independent grading and
   repeated experiments. It is not part of production approval.

The runtime dependency direction is:

```text
thin workflow
    |
    +--> Company Record.prepare(...) --> immutable ConsolidationCase
    |                                      |                 |
    |                                      v                 v
    |                                Payroll           Bookkeeping
    |                                      |                 |
    |                                      +-- facts --------+
    |                                                        |
    +<-- Company Record.record/approve <---- Proposal --------+
    |
    `--> Artifacts.render(approved or preview snapshot)

development only: Evaluation Lab --> public processor interface
```

`consolidate` is an operation implemented independently by Bookkeeping and
Payroll. Consolidation is not another peer module.

## Thin workflows

Onboarding, monthly administration, payroll scheduling, year-end work, and
reporting chat remain thin workflows above the modules. They coordinate public
operations but do not acquire domain logic or authoritative storage access.

This makes the modules reusable building blocks. A later system variant can
compose a different workflow, replace a module, or add a genuinely distinct
domain implementation. For example, a Norwegian payroll implementation can
honor the same outer processor contract while owning its different rules and
State payload. Bookkeeping remains coupled only to the normalized accounting
facts it owns as the consumer.

## Private supporting libraries

Agent Runtime, Docker integration, model clients, validators, retry loops,
accounting calculations, and payroll calculations are private supporting
libraries. They are separately tested, but are not Bergbok's public conceptual
interface. Callers cannot choose arbitrary models, mounts, tools, paths,
credentials, or network policies.

Ordinary tests and the current Bookkeeping path are intentionally offline. The
Payroll evidence path now includes a fixed private GPT-5.6 Luna High assessor,
strict structured output, one bounded repair attempt, and deterministic
evidence/citation validation. The kernels under
`modules/bookkeeping/src/private/` and `modules/payroll/src/private/` still
prove the authority boundary: the model extracts
facts, while deterministic code calculates and the processor returns only a
proposal. The public operation changes only by becoming asynchronous.

## Stable envelopes, versioned payloads

Only the outer contracts are candidates for early stability:

- content references carry schema ID, schema version, stable ID, version, and
  SHA-256;
- a Consolidation Case contains the exact Docset, exact preceding State,
  effective policies, and immutable upstream results;
- a processor returns one of `proposal`, `needs_input`, or `out_of_scope`;
- State is an envelope whose domain payloads evolve independently;
- approval binds the complete recorded Proposal, not selected State files.

Canonical JSON and shared technical value formats are defined by the portable
contracts. The first implementation uses inspectable directory bundles.
Storage paths are adapter details and do not cross processor boundaries.

## Authority invariants

- Company Record is the only authoritative writer.
- Processing modules receive immutable snapshots and return proposals only.
- Payroll never writes the ledger.
- Bookkeeping consumes payroll only through an authority-bearing immutable
  wrapper created by Company Record (or a separately trusted external import).
- Payroll's handoff contains exact semantic expenses and liabilities but no
  account numbers. Bookkeeping assessment chooses the accounts using State,
  history, evidence, policy, and accounting knowledge; deterministic code
  preserves every sealed payroll amount while constructing the journal.
- A changed Docset, predecessor State, upstream result, or Proposal byte makes
  a recorded run ineligible for approval.
- Artifacts never submit, pay, email, or file.
- Production contract validation and independent Evaluation Lab grading remain
  separate.

## When to add a module

A new public module needs substantial independent rules, lifecycle,
testing/versioning needs, or authorization. A named implementation concern is
not enough. Prefer an ordinary private supporting library whenever the concern
can remain behind an existing deep interface.
