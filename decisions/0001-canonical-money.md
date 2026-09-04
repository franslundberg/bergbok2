# Decision 0001: Canonical monetary amounts

- Status: Accepted
- Date: 2026-09-03

## Context

Bergbok passes monetary amounts between independently versioned modules, exact
deterministic calculations, engineers, and AI assessments. The representation
must be exact, compact in JSON and model context, understandable without an
implicit unit, and stable when canonical JSON is hashed.

The current v1 domain payloads use JSON numbers containing integer ore. That is
exact within JavaScript's safe-integer range, but exposes a Swedish minor unit
in portable contracts and requires people and models to convert ordinary
amounts before using them.

## Decision

The canonical portable `Money` representation is one JSON string containing a
fixed-scale decimal amount in the currency's major unit, one ASCII space, and
an uppercase ISO 4217 currency code:

```json
"48406.36 SEK"
```

The decimal scale follows the currency's minor unit. A zero-exponent currency
has no decimal point, for example `"1000 JPY"`. SEK values always contain
exactly two decimal places, including whole-krona amounts:

```json
"48406.00 SEK"
```

Canonical values do not contain grouping separators, decimal commas, leading
plus signs, unnecessary leading zeroes, or negative zero. Display renderers may
localize the same value independently.

Modules parse the portable value into an exact private arithmetic
representation, such as currency plus integer minor units. Monetary
calculations do not use binary floating point.

## Consequences

- A value carries its currency when moved or inspected outside its original
  object.
- The representation is concise and directly legible to engineers and models.
- Canonical spelling is unique for a supported currency and therefore suitable
  for hashing and equality checks.
- Shared parsing, validation, and formatting belong to the contracts
  implementation; individual modules must not invent variants.
- Existing sealed integer-ore payloads remain unchanged and are read through
  explicit schema-v1 adapters. Bookkeeping and Payroll emit schema-v2 domain
  payloads using canonical Money.

## Alternatives considered

- **Integer minor units:** exact and compact, but the scale is implicit and
  integer ore is currency-specific at the contract boundary.
- **JSON decimal numbers:** compact, but unsafe for exact portable monetary
  arithmetic because common JSON implementations use binary floating point.
- **A nested `{currency, value}` object:** explicit, but substantially more
  verbose in JSON and model context without avoiding decimal parsing.
- **No space before the currency code:** slightly smaller, but removes the
  clear lexical boundary between the amount and currency.
- **Optional decimal places:** slightly smaller for whole amounts, but less
  regular than the fixed-scale form commonly produced by financial systems.
