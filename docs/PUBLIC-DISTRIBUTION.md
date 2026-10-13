# Public distribution boundaries

The initial public release started a separate Git history. The 2026-10-13 update continues that public history from `7aaba6496d2ebb0f13183cfa5d2b718b5e7903c0`; it does not import the private development history. It includes selected working-tree PostgreSQL changes, not only the original development HEAD, while preserving public-only safeguards, licensing, and dependency pins. The owner selected the public title 苏沐薇 and the repository name `sumuwei`. Historical documents retain the development codename Project LG.

The public copy excludes all historical `artifacts/`, production databases, environment files, generated presentations/PDFs, temporary folders, third-party runtime installations and private media. Only two 1px image fixtures are bundled as binary files.

Personal QQ identifiers are replaced with synthetic numbers. The original user's nickname and education example are replaced with fictional values. Windows home paths use a placeholder username. These transformations are confined to this distribution; they do not modify the original development checkout.

Historical design documents and milestone reports are retained as technical background where selected. Their old commit hashes, evidence paths, activation states and acceptance counts refer to the original development repository. The original runtime artifacts are deliberately absent, and the historical reports are not fresh evidence for this public copy. Corpus and source fingerprints affected by substitutions require new measurements; do not silently reuse old hash-based acceptance results.

`pnpm ci:offline` requires a fresh checkout without local configuration or data. It initializes and closes a schema-only synthetic database, then verifies it through the controlled migration entry, then runs the original `pnpm m4.5:ci`. The migration-copy check therefore has a closed synthetic source, never a copy of the developer's actual database. The original final gate summarizer can exit zero while G14 is `not-run`. The static prompt-capability audit remains enabled; its historical runtime-prompt check is explicitly NOT RUN when the private archive is absent. Fresh production-copy live validation is not included, and no old live evidence is copied to make G14 green.

Apache-2.0 applies to the Su Muwei (sumuwei) source distribution. It does not authorize redistribution of external models or avatars. See the root NOTICE and THIRD_PARTY_NOTICES.md.

The pinned Handlebars patch is a distribution-only dependency change. Remaining registry advisories and the actual verification results are recorded separately once checks complete.

The PostgreSQL source, trial Compose/SQL tools and migration documents are included. The developer's credentials, database, dump/snapshot files and production activation records remain excluded. The private checkout's repository-registration document is not copied because it describes a different Git history. PostgreSQL integration and production-operation scripts require the operator's own explicit environment; public offline CI does not reuse the developer's running PostgreSQL or model accounts. Multi-user QQ groups, the management UI and the zero-failure refusal policy are planned work, not capabilities certified by this source update.

This update publishes the source snapshot selected before validation. Later additions to the shared development checkout's in-progress multi-user design drafts are excluded; they are not silently mixed into the verified PostgreSQL update.
