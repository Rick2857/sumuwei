# Agent instructions

Work only in this checkout. Do not access another checkout's configuration, database, accounts, or model installations.

Read `docs/architecture/invariants.md` before changing architecture or persistence. Use existing capability registry, policy/gateway, adapter, result, ledger/trace and reply-truth boundaries.

Keep changes surgical. Use isolated databases for tests. Never copy production data into test fixtures, logs, screenshots, commits or bug reports.

Run `pnpm typecheck` and relevant checks for code changes. Subsequent database tests must use isolated PostgreSQL, never production or a PGlite fallback. Existing PGlite test entries await migration; do not rerun them. Preserve historical PGlite evidence as `backend=pglite / historical`, never as PostgreSQL acceptance. `pnpm ci:source` runs only the listed no-database checks; full `m4.5:ci` and live gates are NOT RUN until the relevant database harnesses migrate. `pnpm ci:offline` refuses the legacy database lane explicitly. Historical aggregator exit zero could include a live gate marked not-run.

Historical documentation describes the original development repository; its source hashes, commit references and production activation statements do not prove this distribution was activated or that a fresh test run passed. See `docs/PUBLIC-DISTRIBUTION.md`.

Keep `.env*`, databases, generated artifacts, external models and private media out of Git. Stage only explicitly owned paths. Do not use `git add -A`.
