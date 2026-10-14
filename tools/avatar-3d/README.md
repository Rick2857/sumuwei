# LG 3D presentation

Optional local three-vrm preview and voice-shell adapter. See [the public setup and boundaries](../../docs/3D-VOICE.md).

Install with `npm ci --ignore-scripts --no-audit --no-fund`; explicitly run `npm run sample` before previewing the pinned upstream example, then `npm start` (loopback 12403).

`npm run check` and `npm test` require no model or database. `npm run test:browser` additionally requires the downloaded sample and an installed Microsoft Edge. Aoba/import tests require assets obtained independently; no VRM is bundled.

The LG-shell connection is opt-in, loopback-only, and consumes the canonical speech playback factory. Static preview never opens a database. The 3D presentation is not another personality, memory or tool backend.

Dependencies: Three.js 0.180.0 and three-vrm 3.5.5, each MIT; pinned packages and integrity are in package-lock.json. Their licenses do not cover external models. The sample uses VRM Public License 1.0, separately retained inside the downloaded model. Aoba licensing is the operator's responsibility.

Code-only runtime snapshot and PG tests are utilities for explicitly isolated, operator-owned environments; they are not production activation evidence for this public copy. Historical patch helpers describe an earlier shutdown implementation and are not required by the current core.
