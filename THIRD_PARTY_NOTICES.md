# Third-party components

Su Muwei (sumuwei; formerly Project LG) source and documentation are distributed under Apache-2.0. Dependencies retain their original licenses. Installing a package does not relicense it under this repository's license.

The JavaScript dependency versions and transitive package graph are recorded in `pnpm-lock.yaml`. The distribution uses packages including ElizaOS, PGlite, Drizzle ORM, Mozilla Readability, Tesseract.js, InkJS, Math.js, rss-parser, Croner, and Promptfoo. Their copyright and license files are supplied by their respective packages when installed.

The server edition explicitly declares `@huggingface/transformers` 4.3.0 (Apache-2.0, as declared by its installed package). Model weights and optional native runtime binaries are not bundled. The WeChat adapter talks to an independently supplied bridge; no bridge implementation, image, login state or vendor application is redistributed here.

The optional thin host declares node-postgres `pg` 8.23.1 (MIT, as declared by its installed package) and its TypeScript type package. It does not redistribute a PostgreSQL server or its data.

Reminder calendar parsing additionally uses [chrono-node 2.10.3](https://github.com/wanasit/chrono), under the MIT license. Its package supplies the upstream license; no dependency runtime files are bundled. AstrBot future-task and Home Assistant calendar-offset interfaces informed the reminder design; their implementations and runtimes are not bundled.

Optional `tools/avatar-3d` and `experiments/omni-realtime` dependencies have separate package-lock.json files: Three.js 0.180.0, three-vrm 3.5.5 and ws 8.22.0 retain their MIT licenses. Playwright is an optional test dependency under Apache-2.0. No dependency runtime files are bundled. The explicit example downloader fetches a pinned VRM Public License 1.0 model for local use; that model is not part of the source distribution. Aoba/other VRM assets require their own applicable terms, independently of these library licenses.

Python integration manifests pin optional MCP/OCR/desktop packages. Consult each installed package's own license before redistribution. Project-local workflow instructions under `resources/workflow-skills/` are part of this source distribution; references to external projects do not include those projects' runtime installations.

The following optional external assets and applications are **not bundled**:

- Open-LLM-VTuber and its web frontend: separate upstream licensing, including custom frontend and Live2D terms.
- Live2D Cubism SDK, BOOTH character models, backgrounds, screenshots, and demonstration recordings.
- ASR/TTS/OCR model weights, synthesized reference voices, and Python virtual environments.
- NapCat installations, accounts, cookies, authentication tokens, and configuration containing private identifiers.
- Upstream research checkout copies and their source files formerly retained as local development artifacts.

The historical inventory in `docs/post-lv2/External-Runtime-Inventory.md` describes a development environment. It does not grant rights to download or redistribute an asset, and does not establish that all optional components have standard open-source licenses. Optional integrations require the user to obtain the appropriate assets and accept their upstream terms independently.

The optional Xidian undergraduate timetable integration adapts IDS/eHall protocols from [BenderBlog/traintime_pda at e780e4d01ea740c979ff5c31b9db439dbc586864](https://github.com/BenderBlog/traintime_pda/tree/e780e4d01ea740c979ff5c31b9db439dbc586864). `src/infrastructure/xidian/client.ts` and `src/infrastructure/xidian/timetable.ts` retain MPL-2.0 file-level licensing, independently of the project's Apache-2.0 license. The local slider matcher `scripts/xidian/solve-slider.py` retains the upstream MIT notice. See [copyright and modification notices](scripts/xidian/NOTICE.md) and [full MPL-2.0 text](scripts/xidian/MPL-2.0.txt). No upstream desktop binary, user credentials, sessions or timetable data are bundled.
