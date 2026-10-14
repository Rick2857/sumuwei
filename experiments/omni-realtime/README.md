# LG Omni realtime adapter

Public source for the optional native voice path. See [setup, authority and verification boundaries](../../docs/3D-VOICE.md).

Install with `npm ci --ignore-scripts --no-audit --no-fund`. `npm start` serves an offline demo at loopback 12410; `npm test` needs no credentials or database. Synthetic demo tones do not demonstrate pronunciation or model latency.

Copy `.env.local.example` to `.env.local` and configure your own credentials for `npm run live`. `npm run lg` additionally needs a verified isolated PostgreSQL instance and local test configuration; no developer configuration or database is bundled.

Model: qwen3.8-omni-flash-realtime; voice: Liora Mira. Audio upload starts only after a microphone click. Native API tools are empty; LG owns context, state, actions, memory and reply checking. Audio can precede the final check, with stop/correction on a detected rewrite. A second correction failure stops the turn.

The prototype remains single-page, bounded to ten minutes per connection. Local VAD is an energy detector, not measured human/echo robustness. Audio-volume mouth motion is not phoneme alignment. Original developer transcripts, audio, diagnostics and production recovery data are excluded. Fresh public tests are recorded separately in docs/PUBLIC-VERIFICATION.md.
