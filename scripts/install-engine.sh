#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
channel=live
variant=threaded
while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel) channel="${2:?--channel requires live or ptr}"; shift 2 ;;
    --fallback) variant=fallback; shift ;;
    *) echo "Unknown install option: $1" >&2; exit 1 ;;
  esac
done
case "$channel" in live) suffix= ;; ptr) suffix=-ptr ;; *) echo '--channel requires live or ptr' >&2; exit 1 ;; esac
build="build/wasm$suffix"
engine="${FROSTSIM_ENGINE_DIR:-public/engine${suffix:+/ptr}}"
engine_root="$engine"
manifest_args=()
if [ "$variant" = fallback ]; then
  build="$build-fallback"; engine="$engine/fallback"
  manifest_args=(--source-tree "build/engine-src$suffix-fallback")
  for patch in patches/*.patch; do
    [ -e "$patch" ] || break
    manifest_args+=(--patch "$patch")
  done
fi
mkdir -p "$engine"
cp "$build/simc.js" "$build/simc.wasm" "$engine/"
[ "$channel" != ptr ] || [ "$engine_root" = public/engine ] || cp public/engine/sim-worker.js "$engine_root/"
node scripts/engine-manifest.mjs --channel "$channel" --build-dir "$build" --engine-dir "$engine" ${manifest_args[@]+"${manifest_args[@]}"}
