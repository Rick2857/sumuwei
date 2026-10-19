#!/bin/sh
# One implementation for deployment and maintenance; no PGDATA copies.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd)
exec node "$ROOT/node_modules/tsx/dist/cli.mjs" "$HERE/postgresql-backup.ts" backup "$@"
