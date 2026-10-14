# LG native voice integration

The avatar-only reply port enters the existing formal ChatSession path: beginTurn, memory/tool gateways, ContextCompiler, native reply, existing reply guards, and completeTurn. CLI/QQ reply providers remain unchanged.

A private loopback callback authenticates compiled context before creating the upstream response. The page cannot choose a database, endpoint, prompt or tool. Context updates must be acknowledged before generation; cancellation resets the provider and discards stale audio generations.

Production entry loads operator-owned configuration. It checks actual PostgreSQL mounts and single ownership, uses an empty legacy PGlite fallback location, and does not copy or restore any private database. Dedicated qualification clients are returned before service/connection-pool shutdown. Inherited proxy settings are excluded for the production child; explicit local configuration can still provide them.

There is no public live-chain or production PASS claim. Installation, isolated PG, model assets and runtime boundaries are documented in docs/3D-VOICE.md; the public verification document records fresh offline results.
