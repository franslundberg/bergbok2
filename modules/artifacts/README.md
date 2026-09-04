# Artifacts

Artifacts deterministically materializes canonical output data behind:

```text
render(outputSnapshot, artifactProfile) -> ArtifactBundle
```

Format-specific renderers are private under `src/private/`. The module performs
no submission, payment, filing, email, or other delivery action, and it marks
unapproved material as preview output.

Review Markdown and payslip PDFs use the `sv` or `en` language frozen in the
output snapshot. The renderer has no language override; snapshots without
language metadata remain Swedish for compatibility. SIE, VAT XML, and VAT
verification PDFs are unchanged by this setting.

Run `npm run test:artifacts` or `npm run demo:artifacts` from the repository
root. See the root [module handbook](../../MODULES.md) for supported profiles.
