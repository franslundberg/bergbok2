# Fiktiv AB demo fixture

These are synthetic, non-operational bookkeeping documents copied from the
`bergbok1/fiktiv-ab` test fixture. Names, identifiers, addresses, accounts, and
amounts were deliberately altered for development. Do not use them for real
payments, filings, registration, or identity checks.

`periods.json` is the fixture's machine-readable Period catalog. It owns the
Period IDs, kinds, dates, and source Document directory for this demo.

`Start/` contains only company and startup information and establishes zero
Bookkeeping State through 2026-05-11. `2026-05/` contains bookkeeping evidence
for the inclusive interval 2026-05-12 through 2026-05-31, and `2026-06/`
contains the next ordinary interval. Each directory is copied into a new demo
workspace so the audience can inspect and edit the exact Documents used by a
run.
