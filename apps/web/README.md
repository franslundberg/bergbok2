# Bergbok web — Fiktiv AB

This is the first end-to-end Bergbok application. It composes the public
Company Record, Bookkeeping, and Artifacts interfaces without changing or
importing private module code. Fiktiv AB starts with empty Docsets: documents
must be uploaded through the authenticated web UI.

## Local setup

Requirements: Node.js 22+, Docker Desktop, an OpenAI API key, and SMTP settings
compatible with the Demo 5 authentication flow.

1. Copy `.env.example` to `.env.local` and fill every secret/path value.
2. From this directory run `npm install` and `npm run setup:manager`.
3. Build the read-only chat image with `npm run setup:chat-image`.
4. From the repository root build Bookkeeping's existing images with
   `npm run demo:bookkeeping -- setup`.
5. In separate terminals run `npm run workspace-manager`, `npm run worker`, and
   `npm run dev`.
6. Open `http://127.0.0.1:3006`.

After login, the left column selects a period, the middle column is the
conversation, and the right column shows the selected period's Underlag. Drop
files in the right column to assign them directly to the open period. The same
work can be driven from the conversation, for example:

- `Visa underlagen för Start`
- `Lägg till en anteckning till bolaget-fiktiv.md: ...`
- `Ta bort dokumentet ...`
- `Bokför Start`

Viewing, editing, removal, bookkeeping and change requests can be requested in
chat. Approving a proposal always requires the explicit `Godkänn` button in the
right-hand workbench.

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
requires Start, May, and June to become approved in order. It is never part of
the default suite.

The web UI polls durable jobs while assistant responses stream. A failed or
abandoned paid-model job is never retried automatically.
