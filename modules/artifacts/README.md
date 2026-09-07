# Artifacts

Artifacts deterministically materializes canonical output data behind:

```text
await render(outputSnapshot, artifactProfile) -> ArtifactBundle
```

Format-specific renderers are private under `src/private/`. The module performs
no submission, payment, filing, email, or other delivery action, and it marks
unapproved material as preview output.

`OutputSnapshot` v2 is the approval-bound, persisted review source. The private
review model validates and interprets it once; the HTML and PDF renderers only
lay out that shared model. The registered review profiles are:

- `review-source-json-v1` for the exact canonical snapshot;
- `review-html-v1` for standalone semantic HTML with collapsed transaction
  details;
- `review-pdf-v1` for a complete, fully expanded A4 report.

HTML and PDF show each Bookkeeping review transaction summary as its sole
human-facing narrative. Expanded details contain source and evidence IDs plus
the underlying accounts and amounts; the canonical ledger description remains
only in the exact source JSON and bookkeeping-format outputs such as SIE.

Review artifacts and payslip PDFs use the `sv` or `en` language frozen in the
snapshot. There is no language override and no legacy snapshot adapter. VAT
XML and VAT verification PDF dates come from the kernel-derived cycle start
and end in Bookkeeping schema v3.

Run `npm run test:artifacts` or `npm run demo:artifacts` from the repository
root. See the root [module handbook](../../MODULES.md) for supported profiles.
