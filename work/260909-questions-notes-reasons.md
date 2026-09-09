# Questions, Notes, and Reasons in Bookkeeping results

- Status: Selected terminology; implementation not started
- Date: 2026-09-09

## Purpose

This report defines a clearer vocabulary for matters that Bookkeeping needs to
present to a human after a Consolidation run. The selected result concepts are:

- `Questions` — matters that block a defensible bookkeeping proposal;
- `Notes` — material, non-blocking information that the human should see when
  reviewing the result; and
- `Reasons` — explanations of why the case is outside the supported profile.

The Swedish user-facing term for `Notes` is **Noteringar**. An individual item is
a **Notering**. `Noter` is not selected because it can be confused with the
formal notes to annual financial statements.

This is a design report. It describes the selected direction and its expected
implementation consequences, not current system behaviour unless explicitly
stated.

## Decision

Remove `Warnings` from the public Bookkeeping result vocabulary and replace the
field with typed `Notes`.

`Warnings` is too broad for the approval surface. It currently risks mixing
accounting assumptions, missing evidence, noteworthy facts, deterministic
inconsistencies, and technical conditions. Those matters do not have the same
meaning and should not produce the same human response.

The resulting model is:

| Result concept | Swedish | Effect | Human response |
|---|---|---|---|
| `Questions` | `Frågor` | Blocking | Answer or amend the material, then run Bookkeeping again |
| `Notes` | `Noteringar` | Non-blocking | Consider them as part of reviewing and approving the result |
| `Reasons` | `Orsaker` | Out of scope | Understand why Bookkeeping did not produce a proposal |

Technical diagnostics and invalid bookkeeping do not belong in any of these
three categories. They remain internal errors, validation findings, or
operational logs.

## Questions

A Question states that Bookkeeping cannot produce a defensible complete
proposal without additional information or corrected material.

Examples include:

- an amount cannot be established;
- two authoritative documents contradict each other in a way that changes the
  bookkeeping treatment;
- the date, counterparty, or VAT treatment cannot be selected defensibly; or
- external evidence contradicts the proposed ledger and a human decision is
  required.

A run with Questions has the outcome `needs_input` and is not approvable. The
human answers by adding or correcting attributable material in the Docset. A
new Consolidation run then produces a new immutable result; the earlier result
and its Questions remain in history.

Suggested shape:

```json
{
  "question_id": "BKQ1",
  "code": "MISSING_AMOUNT",
  "prompt": "Vilket belopp gäller?",
  "path": "bookkeeping_input.transactions[0].amount",
  "evidence_document_ids": ["document-17"]
}
```

A Note must never be used merely to avoid asking a necessary Question.

## Notes

A Note is material information that a human should know when reviewing the
Bookkeeping result, but which does not prevent a defensible proposal.

Notes are part of the result being reviewed. They are not chat messages,
technical logs, or informal comments added after the run.

### Initial Note kinds

Use a small controlled set initially:

| Kind | Meaning | Example |
|---|---|---|
| `assumption` | A premise that is not established directly but supports a defensible treatment | No customs decision is assumed to have been received during the period, so no import VAT is booked |
| `missing_evidence` | A known absence limits a check or reconciliation without making the proposal indefensible | No bank statement was available, so account 1930 was not reconciled to an external closing balance |
| `information` | Material context that should be prominent in the review but is not itself uncertain | An invoice remains unpaid at the end of the period |

The set should remain narrow. New kinds should be introduced only when they
change how the reader understands or acts on the Note.

Suggested shape:

```json
{
  "note_id": "BKN1",
  "kind": "assumption",
  "code": "CUSTOMS_DECISION_NOT_RECEIVED",
  "text": "Inget tullbeslut antas ha mottagits under perioden.",
  "consequence": "Ingen importmoms bokförs i perioden.",
  "evidence_document_ids": ["supplier-invoice-17"]
}
```

Each Note should state:

1. what is known, missing, or assumed;
2. the consequence for the bookkeeping or its verification; and
3. the relevant evidence or affected source when one exists.

Notes should be concise, specific, and material. Do not repeat facts that are
already clear in the transaction list, open-item list, reconciliation section,
or VAT section unless their significance would otherwise be easy to miss.

### Assumptions are not permanent facts

Approval does not make an assumption objectively true. It approves the
bookkeeping treatment on the disclosed premise.

If contrary evidence arrives later, that evidence is processed according to the
period lifecycle and the necessary correction or later transaction is recorded.
The approved historical report still shows which premise was used at the time.

Enduring company facts, accounting policies, and other canonical economic
memory belong in approved State. A Note is not a substitute for State. If later
processing must act on a pending matter, the result should also create an
appropriate machine-readable state item instead of expecting future
Consolidation to interpret prose from an old Note.

## Reasons

Reasons explain why Bookkeeping classified the case as `out_of_scope` rather
than producing a proposal.

Examples include evidence that the company or transaction falls outside the
activated Pilot profile. An out-of-scope result must contain at least one Reason
and is not approvable.

Suggested shape:

```json
{
  "code": "OUTSIDE_PROFILE",
  "message": "Ärendet kräver hantering utanför den aktiverade pilotprofilen.",
  "evidence_document_ids": ["document-17"]
}
```

A Reason is not a Question. Asking for more information is appropriate only if
the answer could allow the current profile to produce a defensible result.

## Outcome rules

| Outcome | Questions | Notes | Reasons | Approvable |
|---|---:|---:|---:|---|
| `proposal` | None | Zero or more | None | Yes |
| `needs_input` | One or more | Zero or more | None | No |
| `out_of_scope` | None | Zero or more | One or more | No |

Notes may accompany any outcome because useful non-blocking context can remain
even when another matter blocks the proposal or places the case outside the
profile. Only Notes contained in an approved proposal become part of an
approved Bookkeeping result.

## Approval semantics

Approving a period should approve one exact Bookkeeping run, including its
proposed changes, canonical outputs, review narrative, and Notes.

The intended human meaning is:

> The bookkeeping result, including its disclosed Notes, is approved.

This wording is preferable to saying that every Note is independently
“approved.” For an assumption, the treatment based on that assumption is
accepted. For missing evidence, the approver acknowledges the disclosed
limitation. For information, the approver accepts the result with that context
made visible.

There is no separate approval action per Note. If a Note is unacceptable, the
human rejects or requests a change to the proposal, and a new run is produced.

The approval receipt should make this scope legible, even when the existing
complete-run hash already binds the full result technically. It could record the
included Note IDs alongside the exact run and outcome hashes. The approval UI
should also state the number of Notes, for example:

> Du godkänner bokföringen inklusive 2 noteringar.

The approved OutputSnapshot and every later rendering must preserve the exact
Notes and selected language from the approved run.

## Report presentation

Place **Noteringar** immediately after the report summary and before the detailed
bookkeeping sections. This makes material qualifications visible before the
human considers individual transactions and balances.

Suggested Swedish presentation:

```text
Noteringar

Antagande
Inget tullbeslut antas ha mottagits under perioden.
Konsekvens: Ingen importmoms bokförs i perioden.

Saknat underlag
Kontoutdrag för företagskontot saknas.
Konsekvens: Konto 1930 har inte stämts av mot ett externt saldo.
```

Suggested labels:

| Kind | Swedish | English |
|---|---|---|
| `assumption` | `Antagande` | `Assumption` |
| `missing_evidence` | `Saknat underlag` | `Missing evidence` |
| `information` | `Information` | `Information` |

When there are no Notes, omit the section. Questions and Reasons should retain
their own headings rather than being combined with Notes into one general
notice section.

## Reclassification of current Warnings

Existing warning-producing conditions must be reviewed individually. They
should not be mechanically renamed to Notes.

| Current condition | Proposed treatment |
|---|---|
| AI states a defensible premise and its bookkeeping consequence | `Note: assumption` |
| Bank statement or other corroborating evidence is absent, but proceeding remains defensible | `Note: missing_evidence` |
| Material non-uncertain context deserves prominence | `Note: information` |
| Open-item totals disagree with the ledger accounts they are meant to explain | Blocking deterministic validation error |
| Reconciliation contradicts external evidence | Question or blocking validation result, depending on whether human judgment is required |
| Candidate JSON or schema is invalid | Internal validation feedback; never a human Note |
| Worker timeout, model retry, or infrastructure condition | Operational log or failed run; never a Bookkeeping Note |

The important boundary is whether a valid and defensible bookkeeping proposal
exists. Notes disclose the basis and limitations of such a proposal; they do
not excuse an invalid proposal.

## Current implementation and expected change

The current shared `ModuleOutcome` exposes `questions`, `warnings`, and
`reasons`. Bookkeeping also instructs the AI to put stated assumptions into the
`warnings` array. The report renderer presents non-empty Questions, Warnings,
and Reasons together as notices.

The selected design changes this to `questions`, typed `notes`, and `reasons`.
Likely implementation areas are:

- the shared ModuleOutcome contract and any published schemas;
- the Bookkeeping AI candidate contract, instructions, and candidate validator;
- deterministic Bookkeeping classification of present warning conditions;
- Bookkeeping result assembly and localization;
- Company Record validation, approval scope, and OutputSnapshot handling;
- Artifacts report model plus HTML, PDF, and JSON rendering;
- web run events, review presentation, and approval wording; and
- tests, fixtures, checked-in examples, and compatibility handling.

Because removing `warnings` changes a public result contract, it should be
treated as a contract-version change rather than an unversioned rename.

Historical runs must remain readable. A compatibility renderer may present an
old `warnings` item as a clearly labelled legacy warning or generic legacy Note,
but it must not silently classify every historical warning as an assumption.

## Acceptance criteria for implementation

An implementation of this design is complete when:

- new Bookkeeping outcomes use `questions`, typed `notes`, and `reasons`, with
  no public `warnings` field;
- Questions remain blocking and only proposals are approvable;
- every Note has a recognized kind, meaningful text, and an explicit
  bookkeeping or verification consequence;
- deterministic inconsistencies cannot pass merely by becoming Notes;
- the human report shows Noteringar prominently and omits the section when
  empty;
- approval binds the exact Notes and tells the approver that they are included;
- approved report artifacts preserve the Notes unchanged;
- Notes are not silently promoted into company facts or future accounting
  policy;
- old stored runs remain verifiable and renderable; and
- tests cover all Note kinds, classification boundaries, approval integrity,
  localization, and legacy outcomes.

## Remaining design choices

- Whether `information` is sufficiently precise or should be divided later
  based on real examples.
- Whether Questions and Reasons need an explicit `consequence` field comparable
  to Notes.
- Whether approval receipts should contain Note IDs, a Notes digest, or both.
- Which pending matters require canonical carry-forward State in addition to a
  human-facing Note.
- Whether a non-proposal report should present Notes before or after its
  Questions or Reasons.

