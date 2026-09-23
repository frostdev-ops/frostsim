#!/usr/bin/env bash
# Kept for callers that run it with bash (scripts/update-engines.mjs); the logic lives in bootstrap-engine.mjs.
exec node "$(dirname "$0")/bootstrap-engine.mjs" "$@"
