#!/usr/bin/env bash
# LABELED LOCAL FAKE. Not the Gemini CLI. Not a Google account. No network.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/dist/src/fake-gemini.js" "$@"
