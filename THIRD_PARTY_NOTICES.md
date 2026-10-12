# Third-party components

Su Muwei (sumuwei; formerly Project LG) source and documentation are distributed under Apache-2.0. Dependencies retain their original licenses. Installing a package does not relicense it under this repository's license.

The JavaScript dependency versions and transitive package graph are recorded in `pnpm-lock.yaml`. The distribution uses packages including ElizaOS, PGlite, Drizzle ORM, Mozilla Readability, Tesseract.js, InkJS, Math.js, rss-parser, Croner, and Promptfoo. Their copyright and license files are supplied by their respective packages when installed.

Python integration manifests pin optional MCP/OCR/desktop packages. Consult each installed package's own license before redistribution. Project-local workflow instructions under `resources/workflow-skills/` are part of this source distribution; references to external projects do not include those projects' runtime installations.

The following optional external assets and applications are **not bundled**:

- Open-LLM-VTuber and its web frontend: separate upstream licensing, including custom frontend and Live2D terms.
- Live2D Cubism SDK, BOOTH character models, backgrounds, screenshots, and demonstration recordings.
- ASR/TTS/OCR model weights, synthesized reference voices, and Python virtual environments.
- NapCat installations, accounts, cookies, authentication tokens, and configuration containing private identifiers.
- Upstream research checkout copies and their source files formerly retained as local development artifacts.

The historical inventory in `docs/post-lv2/External-Runtime-Inventory.md` describes a development environment. It does not grant rights to download or redistribute an asset, and does not establish that all optional components have standard open-source licenses. Optional integrations require the user to obtain the appropriate assets and accept their upstream terms independently.
