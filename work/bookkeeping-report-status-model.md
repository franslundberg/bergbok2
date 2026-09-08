# Bookkeeping report status model

- Status: Working design note — not accepted
- Date: 2026-09-07

## Purpose

This note develops the terminology and structure for a human-facing report about
the bookkeeping of a period. The same general report format should work while a
period is in progress, when processing needs more input, for an unapproved
proposal, and for later human-created or human-approved versions.

The model is not yet settled. In particular, it is expected to affect Contracts,
Company Record, Bookkeeping, Artifacts, and the web application. Nothing in this
note describes implemented behaviour unless explicitly identified as current
implementation.

## Main direction

Do not represent every report condition as one lifecycle status. Keep separate
dimensions for:

1. the dates and proportion of the period covered by the report;
2. the processing outcome, such as needing input or producing a proposal;
3. the existence and status of a human-created or human-approved version; and
4. whether the bookkeeping period remains open or has been closed.

These conditions can overlap. For example, a report may both cover an ongoing
period and need additional input. A complete proposal can later become a
preliminary version without changing what the original processing run produced.

The report header should show one dominant user-facing status. It should not show
apparently contradictory raw technical states such as `Förslag` and `Godkänd` as
two equally prominent badges. Technical run outcome and provenance can remain
available elsewhere in the report.

## Selected report header

The selected title names the artifact and its nominal period:

- Swedish: `Bokföringsrapport – maj 2026`
- English: `Bookkeeping report – May 2026`

The company identity and stable creation date appear in a quiet line above the
title. Exact coverage and version status appear in one compact line below it.
The useful summary follows immediately. Technical identifiers and provenance do
not delay the summary and can appear later in the report.

Swedish example:

```text
Fiktiv AB · 559999-0008 · Skapad 7 september 2026

Bokföringsrapport – maj 2026

12–31 maj 2026 · Preliminär version 2

Sammanfattning
…
```

English example:

```text
Fiktiv AB · 559999-0008 · Created 7 September 2026

Bookkeeping report – May 2026

12–31 May 2026 · Preliminary version 2

Summary
…
```

The company identity makes the artifact self-contained when viewed outside a
Bergbok session, even though it is normally already known in the application.
It is visually secondary because it is fixed across the company's reports.

`Skapad` / `Created` means when the snapshot or version was created. It does not
mean when someone later re-rendered or downloaded the report. This keeps the
displayed date stable under deterministic re-rendering.

## Dimensions

### Period coverage

Coverage states what the report actually includes. It is not an approval level.

| Swedish | English | Meaning |
|---|---|---|
| `Pågående` | `In progress` | The end of the period has not been reached. |
| `Del av perioden` | `Partial period` | The report covers an explicit date interval rather than the whole period. |
| `Hela perioden` | `Full period` | The report covers the complete defined period. |

The report should always state its exact coverage, for example `1–18 maj 2026`,
even when the nominal bookkeeping period is all of May.

Reserve `Bearbetar` / `Processing` for a bookkeeping run that is actively
executing, so it is not confused with the period status `Pågående` / `In
progress`.

### Processing outcome

Processing outcome describes what a run was able to produce. It does not by
itself express human acceptance.

| Swedish | English | Meaning |
|---|---|---|
| `Behöver kompletteras` | `Needs input` | Questions or missing material prevent a complete proposal. |
| `Förslag` | `Proposal` | A complete proposal is ready for human consideration but has not become a human-created version. |

The existing `out_of_scope` outcome also needs a place in the report model, but
its final user-facing treatment has not been discussed.

### Version status

The working user-facing sequence is:

| Swedish | English |
|---|---|
| `Förslag` | `Proposal` |
| `Preliminär` | `Preliminary` |
| `Godkänd` | `Approved` |
| `Slutlig` | `Final` |

`Förslag` originates from processing. The later terms describe human action and
version state. The exact boundary between `Godkänd`, `Slutlig`, and closing the
period remains to be decided.

## Preliminary version

The agreed concept is:

> A preliminary version is an immutable, human-created version that is expected
> to be replaced or revised.

Creating it is an explicit and auditable human action. The status does not
prescribe why the customer creates the version or how the customer should use
it.

Agreed terminology:

| | Swedish | English |
|---|---|---|
| Status | `Preliminär` | `Preliminary` |
| Action | `Skapa preliminär version` | `Create preliminary version` |

In the selected compact header, the status is presented as `Preliminär version
2` / `Preliminary version 2`. No explanatory sentence defining `Preliminär` or
`Preliminary` is needed in the frequently viewed header.

### Terminology not selected

The following preliminary-version terms were considered and rejected:

- `Preliminärt godkänd` / `Preliminarily approved`: these sound like uncertain
  or qualified approval rather than a deliberate version state.
- `Frisläpp som preliminär` / `Release as preliminary`: the Swedish wording is
  too informal and resembles software deployment or publication.
- `Godkänn för intern rapportering` / `Approve for internal reporting`: this
  assumes and prescribes a customer use that Bergbok does not yet know.
- `Fastställ som preliminär version`: `fastställ` may sound more definitive than
  the intended status.

## Tentative status presentation

The following is a working presentation map, not an accepted lifecycle model:

| Situation | Dominant Swedish status | English status | Supporting information |
|---|---|---|---|
| Period end not reached | `Pågående` | `In progress` | Exact covered date interval |
| Questions or missing material | `Behöver kompletteras` | `Needs input` | What is needed before a complete proposal can be made |
| Complete and awaiting human action | `Förslag` | `Proposal` | Full or partial coverage and that no version has been created |
| Human creates a preliminary version | `Preliminär` | `Preliminary` | Version and stable creation date |
| Human approves a version | `Godkänd` | `Approved` | Version and approval evidence |
| Human approves the final version | `Slutlig` | `Final` | Version, approval evidence, and period closure if that relationship is adopted |

## Current implementation conflicts

The present implementation uses `preliminary` for an unapproved preview, which
conflicts with the meaning developed here:

- [`contracts/output-snapshot.schema.json`](../contracts/output-snapshot.schema.json)
  allows only `preliminary` and `approved` as `approval_status` values.
- [`modules/artifacts/src/index.mjs`](../modules/artifacts/src/index.mjs) treats
  every status other than `approved` as a preview.
- [`modules/artifacts/src/private/report/model.mjs`](../modules/artifacts/src/private/report/model.mjs)
  renders the current Swedish `preliminary` status as `Förhandsvisning – inte
  godkänd`.
- [`apps/web/lib/bergbok/application.ts`](../apps/web/lib/bergbok/application.ts)
  uses the period status `preliminary` for an unapproved proposal.

The current term will probably need to become `preview`, `unapproved`, or an
equivalent technical state before `preliminary` can mean an explicitly created
human version. No migration decision has been made.

## Open questions

- Which combinations of coverage, processing outcome, version status, and
  period status are valid?
- Is a preliminary version available for a partial period, or only after the
  complete period has been processed?
- Is `Godkänd` an authoritative version of an open period, and what changes are
  allowed after it is created?
- Is `Slutlig` a version status, or is it the presentation derived from an
  approved version plus a separate closed-period event?
- What exact human actions and authority are required for approved and final
  versions?
- Which statuses are persisted facts and which are derived presentation?
- How are superseded versions presented and retained?
- How should `out_of_scope`, failed runs, and runs still executing appear in the
  common report format?
- How should partial coverage interact with monthly approval of the transaction
  delta and yearly approval of balances?
- What filenames, version identifiers, and download metadata should each report
  state use?

## Expected areas of impact

When the model is accepted, implementation work is likely to affect:

- shared contracts and schemas;
- Company Record events, snapshots, approvals, and version history;
- Bookkeeping run outcomes and review metadata;
- deterministic Artifacts report models and HTML/PDF renderers;
- web application period state, actions, labels, and API behaviour;
- tests, fixtures, migration handling, and documentation.

Once the open questions are resolved, the accepted decision should be recorded
separately under `decisions/`, following the repository's decision-record style.
