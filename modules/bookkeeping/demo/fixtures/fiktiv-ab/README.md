# Fiktiv AB demo fixture

These are synthetic, non-operational bookkeeping documents copied from the
`bergbok1/fiktiv-ab` test fixture. Names, identifiers, addresses, accounts, and
amounts were deliberately altered for development. Do not use them for real
payments, filings, registration, or identity checks.

`periods.json` is the fixture's machine-readable Period catalog. It owns the
Period IDs, kinds, dates, and source Document directory for this demo.

`Uppstart/` contains only company and startup information and establishes zero
Bookkeeping State through 2026-05-11. `2026-05/` contains bookkeeping evidence
for the inclusive interval 2026-05-12 through 2026-05-31. `2026-06/`,
`2026-07/`, and `2026-08/` contain the subsequent ordinary intervals
2026-06-01 through 2026-06-30, 2026-07-01 through 2026-07-31, and 2026-08-01
through 2026-08-31. Each directory is copied into a new demo workspace so the
audience can inspect and edit the exact Documents used by a run.

## Regenerated Documents

`generators/openai-receipt.mjs` builds the two OpenAI receipts,
`2026-08/260819-1-ai-from-openai.pdf` and `2026-08/260821-1-ai-from-openai.pdf`.
Run it with `node generators/openai-receipt.mjs`; it writes into `2026-08/` by
default, or into a directory given as the first argument. Output is
deterministic, so re-running it produces byte-identical files and leaves the
working tree clean.

**2026-09-12. Both receipts now name FIKTIV AB in Bill to and Ship to.** They
previously named Filippa Stark as the customer while carrying the company's VAT
number. That combination is realistic, since OpenAI keeps the account name and
the tax ID in separate fields, and it was inherited from the real receipts the
fixture was built from. It was removed anyway: the company card pays these
purchases directly, so a private name on the document contradicted the payment
route, and the defect was accidental rather than placed, so nothing recorded
what a reader was supposed to conclude from it. The default scenario should be
straightforward, with document defects moved into deliberate variants that state
their expected outcome.

The same regeneration replaced the customer email, which read
`Filippaundberg@gmail.com`. That string was a leftover from the identity
rewrite: the first name was substituted but the tail of the original address
survived. It is now `filippa.stark@example.com`, matching `bolaget-fiktiv.md`.
**The two Anthropic receipts, `2026-08/260817-1-ai-from-anthropic.pdf` and
`260817-2-ai-from-anthropic.pdf`, still carry the same leftover tail and have
not been regenerated.**

The Hostup domain invoice, `2026-08/260806-1-domains-from-hostup.pdf`, still
names Filippa Stark and is **left that way on purpose**. There the document and
the money agree, because she paid privately with Swish and was reimbursed the
same day, and the amount is under the 4 000 kr limit for a simplified invoice.
It is a realistic case of an account not yet renamed to the company.

The receipts were rebuilt rather than edited because the captured originals draw
text one glyph at a time across three font subsets, which makes a name change a
byte-level rewrite of glyph ids and advances. The generator makes the customer
identity a parameter instead. It is not a pixel copy of the originals: they use
Inter SemiBold, and the generator ships Regular and Medium, so headings and
labels are set in Medium. Assets in `generators/assets/` are the Inter fonts,
under the SIL Open Font License, and the OpenAI logo extracted from the original
PDF.

The superseded originals remain in git history and in the copies under
`../../generated/run-*/documents/2026-08/`. Run `run-029` and the review in
`sk26/b/B059-bergbok-sep/11-check-bk-against-book/` predate this change and
describe the old documents.
