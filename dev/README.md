# Development support

This is not a Bergbok product module. It contains small development-only
helpers shared by the current JavaScript demos.

`demo-run-directory.mjs` allocates human-readable, non-overwriting run
directories such as `run-001`, `run-002`, and `run-003`. Directory creation is
atomic, so concurrent demo invocations cannot claim the same run number.

Run its concurrency test with `npm run test:dev` from the repository root.
