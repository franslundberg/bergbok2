# Bergbok web — Fiktiv AB

This is the first end-to-end Bergbok application. It composes the public
Company Record, Bookkeeping, and Artifacts interfaces without changing or
importing private module code. Fiktiv AB starts with empty Docsets: documents
must be uploaded through the authenticated web UI.

## Local setup

Requirements: Node.js 22+, Docker Desktop, an OpenAI API key, and SMTP settings
compatible with the Demo 5 authentication flow.

1. Copy `.env.example` to `.env.local` and fill every secret/path value.
2. Run `npm install` once at the repository root, then from this directory run
   `npm install` and `npm run setup:manager`.
3. Build the read-only chat image with `npm run setup:chat-image`.
4. From the repository root build Bookkeeping's existing images with
   `npm run demo:bookkeeping -- setup`.
5. In separate terminals run `npm run workspace-manager`, `npm run worker`, and
   `npm run dev`.
6. Open `http://127.0.0.1:3006`.

After login, the left column remains the company and status anchor. A shared
context bar spans the conversation and workbench: it shows Bokföring, the
selected period, its status, and the current activity. Selecting a period in
either the left column or the bar changes the same WorkContext and opens that
period's Underlag in the workbench. Drop files in the workbench, or use the
composer upload button, to assign them to the selected period. The same work
can be driven from the conversation, for example:

- `Visa underlagen för Uppstart`
- `Lägg till en anteckning till bolaget-fiktiv.md: ...`
- `Ta bort dokumentet ...`
- `Bokför Uppstart`

Viewing, editing, removal, bookkeeping and change requests can be requested in
chat. The first WorkContext version is bookkeeping-only: `documents`, `review`,
and `artifacts`. The text editor remains local workbench state. The selected
context is kept per browser tab in `sessionStorage`; old chat messages remain
readable without fabricated context metadata. Every completed Bookkeeping outcome has one report, shown as
sandboxed standalone HTML. It covers proposals, questions, and out-of-scope
results; transactions can be expanded for exact account, debit, and credit
details. The same immutable snapshot can be downloaded as canonical JSON or a
fully expanded PDF. Approving a proposal always requires the explicit
`Godkänn` button outside the report in the right-hand workbench.

The Uppstart assessment must extract Fiktiv AB's quarterly VAT cadence and account
configuration from evidence. Approval stores that policy in company core
State. May therefore shows the April–June cycle as not due, while June is due
and must include the declaration assessment and VAT closing entry.

Runtime data is stored under `../../var/` by default and is ignored. The source
fixture under `modules/bookkeeping/demo/fixtures/fiktiv-ab/` is used only by
tests or by a human selecting files in the browser; it is never preloaded.

## Checks

```sh
npm test
npm run test:docker
npm run build
```

The paid, nondeterministic walkthrough is opt-in. After the Bookkeeping and
chat images are available, `npm run test:live` uploads the repository's real
Fiktiv AB PDF/Markdown files through the same trusted intake function and
requires Uppstart, May, and June to become approved in order. It is never part of
the default suite.

The web UI polls durable jobs while assistant responses stream. A failed or
abandoned paid-model job is never retried automatically.

The authenticated endpoint
`GET /api/runs/:id/review?format=html|pdf|json` resolves the run through Company
Record and renders it through Artifacts. Approval persists the approved source
JSON, HTML, PDF, and SIE bundle. The application database stores only the
immutable run reference plus indexing and status data; it does not duplicate
the complete outcome for presentation.
