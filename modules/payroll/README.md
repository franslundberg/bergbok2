# Payroll

Payroll is independently runnable and owns payroll interpretation,
calculation, projected Payroll State, canonical payroll outputs, and normalized
economic accounting facts behind one public operation:

```text
await consolidate(ConsolidationCase, variantRef?) -> ModuleOutcome
```

The current implementation is the explicit `simple-payroll-demo-v1` profile.
It accepts one or more immutable `payroll-evidence` Markdown or text documents,
has a fixed private GPT-5.6 Luna High assessor extract cited facts, validates the
assessment deterministically, and passes only normalized facts to the private
calculation kernel under `src/private/`. One repair assessment is allowed when
the first structured result fails deterministic validation.

Version 2.0.0 emits schema-v2 Money strings in assessment, result, State,
payslip, payment, AGI, and accounting-facts payloads. A single boundary adapter
continues to read schema-v1 integer-ore normalized input and State without
rewriting historical content.

The older single `payroll-input` JSON document remains as an explicitly
transitional offline path for existing composition tests and demos. A Docset
containing both input modes returns `needs_input`. Callers cannot select the
model, reasoning effort, tools, sandbox, or network capabilities.

Payroll never approves, pays, files, writes authoritative State, or writes the
ledger. API failures, refusals, timeouts, and exhausted schema repair are
technical errors and never become proposals.

Payroll resolves the frozen case language (`sv` or `en`, defaulting legacy
cases to Swedish), records it in `review.language`, and uses it for generated
review text and human-facing payslip labels. Source-provided names and
descriptions remain unchanged.

`PayrollAccountingFacts` contains exact semantic expenses and liabilities such
as gross cash salary, employer contribution, withholding payable, and net
salary payable. It deliberately contains no ledger account numbers and no
prebuilt journal. Bookkeeping's assessment chooses the accounts from preceding
State, approved history, current evidence, explicit policy, and accounting
knowledge. Trusted validation then copies the exact sealed payroll amounts into
the proposed journal; Bookkeeping cannot silently recalculate them.

The synthetic case under `cases/simple-september/` contains an employment
agreement, absence report, employee messages, and coherent preceding Payroll
State. Its 30-day absence divisor, 30% withholding, and 31.42% employer
contribution are illustrative demo rules—not authoritative Swedish payroll
law.

Ordinary tests are offline:

```sh
npm run test:payroll
```

The standalone demo performs a real model assessment. Export
`OPENAI_API_KEY`, or place it in the ignored root `.env.local` file. An exported
value takes precedence.

```sh
npm run demo:payroll
npm run demo:payroll -- --json
npm run demo:payroll -- --case modules/payroll/cases/simple-september --output /tmp/payroll-run
```

See the root [module handbook](../../MODULES.md) for the full boundary.
