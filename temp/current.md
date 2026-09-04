

## Proposed normative documentation

I would add one short, authoritative “Period model” section to the [Bergbok System Concept](./b/B059-bergbok-sep/04-system-concept/bergbok-system-concept.md:123):

> **Period** is Bergbok’s internal name for one durable unit of State-producing work. A Period owns its Documents, immutable Runs, Proposals, and approval history. It is not necessarily a calendar period.
>
> A Period has one of these kinds:
>
> - `start` — establishes a new company’s initial State. It contains startup and company information but no bookkeeping transactions.
> - `import` — establishes the State imported from a previous bookkeeping system through a specified date.
> - `ordinary` — processes bookkeeping for an explicit inclusive date interval. The interval may be a partial month, month, week, quarter, or another date range.
>
> A Run is one immutable processing attempt for an exact preceding State and exact Docset version. Several Runs may belong to the same Period. Approval of a Proposal advances authoritative State.
>
> Period is primarily internal terminology. Users normally see the specific labels `Start`, `Import`, `2026-05`, or or `Year-end 2026`.

I would then summarize the implemented contract in [MODULES.md](~/fl/bergbok2/MODULES.md:69), while [modules/bookkeeping/README.md](~/fl/bergbok2/modules/bookkeeping/README.md:27) should explain only the actual demo flow.

## Date semantics

I suggest documenting these rules:

```text
start
  end = day before Bergbok Start Date
  no ordinary bookkeeping transaction delta

import
  end = day before Bergbok Start Date
  establishes imported balances, history and open items

ordinary
  start and end are required and inclusive
  start must immediately follow the preceding Bookkeeping State’s through_date
  interval length is unrestricted

year_end
  reserved until its relationship to the last ordinary Period is designed
```

`year_end` needs special care because it may follow December while sharing its accounting date. We should not pretend it is an ordinary non-overlapping interval until that is designed.

## Required code changes

Several are real semantic changes:

1. **Contracts**

   The contract currently permits only `opening | ordinary` and requires Opening to have no lower bound. That must become the new Period-kind model in [contracts/src/index.mjs](~/fl/bergbok2/contracts/src/index.mjs:114) and [consolidation-case.schema.json](~/fl/bergbok2/contracts/consolidation-case.schema.json:32).

2. **Bookkeeping modes**

   The AI candidate and deterministic kernel currently understand only `opening` and `ordinary`. They need distinct behavior for:

   - `start`: core initialization and zero opening bookkeeping State; transactions prohibited.
   - `import`: imported balances/history/open items.
   - `ordinary`: transaction-producing date interval.
   - `year_end`: initially an explicit unsupported/reserved outcome.

3. **Demo lifecycle**

   The demo currently creates `opening-before-START_DATE`, puts all May evidence there, and only accepts `YYYY-MM` ordinary IDs in [workflow.mjs](~/fl/bergbok2/modules/bookkeeping/demo/workflow.mjs:33).

   It should instead create:

   ```text
   Start
   2026-05, covering 2026-05-12 through 2026-05-31
   2026-06, covering 2026-06-01 through 2026-06-30
   ```

   The fixtures must be split into startup information and May bookkeeping documents.

4. **Arbitrary ordinary intervals**

   The kernel is mostly ready because it validates explicit dates and `through_date`. The demo CLI is not: it derives bounds from `YYYY-MM`. It will eventually need explicit interval arguments or stored Period definitions.

5. **Company Record ordering**

   The late-material protection currently orders only IDs matching `YYYY-MM`. That would silently fail for weeks, quarters, custom intervals, Start, and Import. It must use Period dates and State lineage rather than lexically comparing monthly IDs.

6. **Compatibility**

   The approved `run-009` must remain an immutable legacy artifact. New code should stop creating `opening` Periods while retaining the ability to inspect old `opening` runs. It must not reinterpret or rewrite them.

Your June run can continue under the existing approved legacy chain. I would make the new model apply to newly created workspaces. No files changed.

> Make the proposed changes with the following changes and notes:
>
> - Remove the "year\_end" mode. We can add it later if/when needed.
> - "A Period owns its Documents, immutable Runs, Proposals, and approval history.". Perhaps Docsets should be used in the sentence. And not sure about "immutable". Remove the word unless you think it is important, I find it confusing.&#x20;
> - Compatibiilty: not required. Remove all previous runs. Don't want to keep generated data from old runs.
>
> User input response
>
> - Which generated runs should this change remove?
>   - Bookkeeping only (Recommended)
> - How fully should the new Import Period be implemented now?
>   - Working Import flow (Recommended)
> - How should arbitrary ordinary date intervals be supplied in the demo CLI?
>   - Explicit dates (Recommended)
>
