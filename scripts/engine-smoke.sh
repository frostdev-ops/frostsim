#!/usr/bin/env bash
# Relink engine as node CLI (PLAN P02.3, P02.4, P02.10): same objects, different environment. Engine properties transfer; browser lifecycle/cleanup do not. Pool ceiling must be measured in browser.
#
# Relink cached; only reruns when libengine.a is newer.
set -euo pipefail
cd "$(dirname "$0")/.."

VARIANT=threaded
CHANNEL=live
while [ "$#" -gt 0 ]; do
  case "$1" in
    --fallback) VARIANT=fallback; shift ;;
    --channel) CHANNEL="${2:?--channel requires live or ptr}"; shift 2 ;;
    *) break ;;
  esac
done
case "$CHANNEL" in live) SUFFIX= ;; ptr) SUFFIX=-ptr ;; *) echo '--channel requires live or ptr' >&2; exit 1 ;; esac
ENGINE_ROOT="${FROSTSIM_ENGINE_DIR:-public/engine${SUFFIX:+/ptr}}"

if [ "$VARIANT" = threaded ]; then
  BUILD_DIR=build/wasm$SUFFIX
  ENGINE_DIR=$ENGINE_ROOT
else
  BUILD_DIR=build/wasm$SUFFIX-fallback
  ENGINE_DIR=$ENGINE_ROOT/fallback
fi
CLI="$BUILD_DIR/simc-node.cjs"

command -v em++ >/dev/null || { echo "em++ not found. Run: source ~/emsdk/emsdk_env.sh"; exit 1; }
[ -f "$BUILD_DIR/engine/libengine.a" ] || { echo "no build tree at $BUILD_DIR. Run: npm run engine:build"; exit 1; }

# Match browser artifact's pool so thread sweep here means something there.
POOL="$(node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(String(m.capabilities.pthreadPoolSize));
' "$ENGINE_DIR/manifest.json" 2>/dev/null || echo 16)"
INITIAL_MEMORY="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const n=m.build.artifactFlags.initialMemory ?? Number(m.build.linkFlags.match(/-sINITIAL_MEMORY=(\d+)/)?.[1]); if(!Number.isInteger(n)||n<1)throw Error("Missing initial memory"); process.stdout.write(String(n))' "$ENGINE_DIR/manifest.json")"

if [ ! -f "$CLI" ] || [ "$BUILD_DIR/engine/libengine.a" -nt "$CLI" ]; then
  echo "engine-smoke: relinking node CLI (pool $POOL)..."
  # .cjs not .js/.mjs: glue is CommonJS; .js ESM breaks, .mjs infers EXPORT_ES6 and exits 0. Fallback has no pthreads.
  # Same allocator and LTO as the browser artifact (build-engine.sh), or the smoke measures a different engine.
  THREAD_FLAGS=(-pthread "-sPTHREAD_POOL_SIZE=$POOL" -sMALLOC=mimalloc)
  [ "$VARIANT" = fallback ] && THREAD_FLAGS=()

  em++ -O3 -flto -fwasm-exceptions ${THREAD_FLAGS[@]+"${THREAD_FLAGS[@]}"} \
    "$BUILD_DIR/CMakeFiles/simc.dir/engine/sc_main.cpp.o" "$BUILD_DIR/engine/libengine.a" \
    -o "$CLI" \
    -fwasm-exceptions ${THREAD_FLAGS[@]+"${THREAD_FLAGS[@]}"} "-sINITIAL_MEMORY=$INITIAL_MEMORY" \
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4gb -sENVIRONMENT=node,worker \
    -sNODERAWFS=1 -sEXIT_RUNTIME=1
fi

exec node "$CLI" "ptr=$([ "$CHANNEL" = ptr ] && echo 1 || echo 0)" "$@"
