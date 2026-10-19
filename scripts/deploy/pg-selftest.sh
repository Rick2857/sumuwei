#!/bin/sh
# Runs the maintained v22+/RLS/concurrent-writer suite on two isolated test containers.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd)
exec node "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/scripts/priority-backup-verify.ts" "$@"
