# Portable contracts

These JSON Schemas describe the language-neutral outer envelopes used by the
JavaScript reference implementation. Domain State and canonical output payloads
remain independently versioned by their owning modules.

The schemas validate shape, not authority. SHA-256 recomputation, freshness,
authorization, predecessor selection, and atomic publication are enforced by
Company Record.

The portable set is `ContentRef`, `ConsolidationCase`, `ModuleOutcome`,
`StateEnvelope`, `ApprovalReceipt`, `OutputSnapshot`, and `ArtifactBundle`.
`OutputSnapshot` v2 is the complete approval-bound source for review rendering;
it contains the complete ModuleOutcome and exact input-context references, not
duplicated review or canonical-output projections. Bookkeeping State, Payroll
State, and each canonical output retain their own schema IDs and versions.

The JSON Schemas are in this directory. `src/` contains the current JavaScript
reference implementation of sealing, hashing, canonical JSON, and runtime
contract checks; `test/` contains its conformance tests. Another language
implementation should follow the schemas and canonicalization profile rather
than importing this JavaScript code.

Consolidation cases may carry `language`, with the supported values `sv` and
`en`. It is optional for compatibility with older cases; consumers resolve a
missing value as Swedish. Module review metadata may likewise carry the same
language identifiers.

The hash profile is `bergbok-canonical-json-v1`: JSON objects are serialized
with recursively sorted keys, arrays retain order, strings use JSON escaping,
and numbers must be finite.

## Money

A canonical monetary amount is a JSON string containing:

1. an amount in the currency's major unit;
2. one ASCII space; and
3. an uppercase ISO 4217 currency code.

Examples:

```json
"48406.36 SEK"
"48406.00 SEK"
"-125.00 SEK"
```

For currencies with minor units, the amount always uses a decimal point and
exactly the number of decimal places specified for that currency. SEK therefore
always has two decimal places. A zero-exponent currency has no decimal point,
for example `"1000 JPY"`. Grouping separators, decimal commas, leading plus
signs, unnecessary leading zeroes, and negative zero are not canonical.

Canonical Money values are serialized amounts, not display formatting.
User-facing renderers may localize them, for example as `48 406,36 SEK`.

Deterministic calculations must parse Money into an exact internal
representation. Binary floating-point arithmetic must not be used for monetary
calculations.

Domain payload schema v2 uses this representation. Explicit adapters accept
the existing v1 integer-ore payloads; historical sealed payloads are never
silently reinterpreted or rewritten.

The deterministic exponent snapshot is exported as `ISO_4217_MINOR_UNITS`.
Its provenance is exported as `ISO_4217_SOURCE`: SIX Financial Information AG
List One, published 2026-01-01, source URL
`https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml`,
SHA-256
`838dfb991648cf36df939edd5fe3811737962b75a32252847d239cedd1e291c9`.
Only current entries with numeric minor units are included; retired codes and
List One entries marked `N.A.` are rejected.

The rationale and consequences are recorded in
[Decision 0001](../decisions/0001-canonical-money.md).
