# Security and private data

Do not post credentials, private chat transcripts, account identifiers, production database files, or screenshots containing personal data in issues or pull requests. Reproduce problems with a fresh local database and synthetic inputs.

The public distribution does not include production credentials or enable the original developer's optional integrations. Capability permissions, targets, budgets, execution results, ledgers and reply-truth constraints remain enforced by the application. Review each capability before enabling it for your own environment.

## Dependency advisory snapshot — 2026-10-12

The public copy pins Handlebars 4.7.10 to address the three advisories affecting 4.7.9. A registry audit after the patch reports no critical or moderate advisories, with the following remaining findings:

- **node-forge 1.4.0 — high**, via the development/optional path `promptfoo > jks-js`: [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv). The audit snapshot supplied no patched version.
- **elliptic 6.6.1 — low**, via the runtime path `@elizaos/core > crypto-browserify`: [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84). The audit snapshot supplied no patched version.

These are dependency matches, not a demonstrated exploit of Project LG. No claim is made that every affected path is unreachable. Run `pnpm audit` for current information; an audit exit code of 1 is expected while these findings remain. Dependency fixes require compatibility checks.
