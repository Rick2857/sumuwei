# WeChat health observation patch

Upstream: `thisnick/agent-wechat`, commit `21fe1185a01ec7f90864a529d9bb94da648255d5`, package `packages/agent-server-rust`.

The process/crash check still runs every second. A healthy desktop gets a full accessibility/screenshot observation every ten seconds. First observation, a failed observation, and a restarted process retain the fast check. Crash backoff, the 60-second unresponsive watchdog, active-action pause, and request-time authentication are unchanged. A healthy UI state change can take up to ten seconds to reach the background monitor; actual API requests still observe the live UI.

Extract the pinned commit with `git archive` so migration SQL keeps its canonical Git bytes. Do not build from a Windows working copy that converted SQL to CRLF: refinery migration checksums differ, so a fresh database can pass while an existing database refuses to open. Apply `health-observation.patch` with `git apply` from the package directory. Build and run all tests with the unchanged `Cargo.lock`:

Before building, run `node tools/wechat-performance/verify-migrations.mjs <agent-server-rust directory>` from the LG repository. This checks the exact pinned migration bytes without opening a database.

```sh
cargo test --locked --release -j1
cargo build --locked --release -j1
```

Upstream tests export TypeScript bindings. With read-only source mounts, set `TS_RS_EXPORT_DIR` to a writable build-volume directory (the server uses `/target/bindings`). The server build uses pinned `rust:1.93-bookworm` digest `sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31`, one CPU, and a 1400 MiB memory limit, with separate build/cache volumes and no production data or credentials. Keep Cargo checksum validation and `--locked` when using a registry mirror.

Validate fresh startup AND opening a database created by the original image binary in isolated containers before activation. Use synthetic credentials, fresh volumes and no network. Persist the tested binary with a read-only bind over `/opt/agent-server/agent-server`, keeping the pinned base image, existing account volumes, token mount, loopback ports, and resource/security settings. The audit record contains deployed hashes and rollback paths. Do not recreate a logged-in production container merely to apply the bind: the running API process can be replaced independently of the native WeChat client. A crashing API process can also terminate the upstream entrypoint through `set -e`, causing a container restart and requiring phone confirmation. Confirm that the container restart count, native client PID, and account remain unchanged.
