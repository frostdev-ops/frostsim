#!/usr/bin/env bash
# Build entry point for WebAssembly engine (PLAN P00.5, P00.7); script is the authority for flags. Requires: source ~/emsdk/emsdk_env.sh.
# Key flags: -fwasm-exceptions (both compile & link, D11/D10), -sINITIAL_MEMORY (56.4 MB DBC), -DSC_USE_PTR=0, -sPTHREAD_POOL_SIZE (D11).
# Fallback (D4/P02.7): SC_NO_THREADING, no SharedArrayBuffer, sequential candidate jobs, manifest reports profilesets:false.
set -euo pipefail
cd "$(dirname "$0")/.."

VARIANT=threaded
[ "${1:-}" = "--fallback" ] && VARIANT=fallback

command -v emcmake >/dev/null || { echo "emcmake not found. Run: source ~/emsdk/emsdk_env.sh"; exit 1; }

# Build what engine.lock.json names, not checked-out HEAD.
DIRTY="$(git -C vendor/simc status --porcelain 2>/dev/null | head -10)"
if [ -n "$DIRTY" ]; then
  echo "build-engine: vendor/simc has local modifications, so what it contains is no longer the" >&2
  echo "              locked revision and a build from it would not be reproducible." >&2
  echo "$DIRTY" >&2
  echo >&2
  echo "              Inspect them before doing anything: git -C vendor/simc diff" >&2
  echo "              If they are wanted, save them as a patch and keep them:" >&2
  echo "                  git -C vendor/simc diff > patches/00NN-describe-it.patch" >&2
  echo "              This script will not discard them for you, and neither should you until" >&2
  echo "              you have looked at what they are." >&2
  exit 1
fi

LOCKED_COMMIT="$(node -p 'JSON.parse(require("fs").readFileSync("engine.lock.json","utf8")).upstream.commit')"
ACTUAL_COMMIT="$(git -C vendor/simc rev-parse HEAD 2>/dev/null || echo missing)"
if [ "$ACTUAL_COMMIT" != "$LOCKED_COMMIT" ]; then
  echo "build-engine: vendor/simc is at $ACTUAL_COMMIT, engine.lock.json wants $LOCKED_COMMIT."
  echo "              Run: npm run engine:bootstrap"
  exit 1
fi

# Engine patches never applied to vendor/simc (catalog reads it); patched variant builds from git worktree under build/ (gitignored).
# Worktree (not copy): simc's CMakeLists compiles git_revision into SC_GIT_REV for reports; copy would escape to frostsim repo.
stage_source() {
  local stage
  local stamp_file
  local stamp
  local staged_head
  stage="$1"
  stamp_file="$stage/.frostsim-stage"
  stamp="$LOCKED_COMMIT $(shasum -a 256 patches/*.patch 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"

  if [ -f "$stamp_file" ] && [ "$(cat "$stamp_file")" = "$stamp" ]; then
    staged_head="$(git -C "$stage" rev-parse HEAD 2>/dev/null || echo none)"
    if [ "$staged_head" = "$LOCKED_COMMIT" ]; then
      echo "build-engine: staging worktree $stage is current"
      return 0
    fi
  fi

  echo "build-engine: staging $LOCKED_COMMIT into $stage (vendor/simc's working tree is untouched)"
  if [ -e "$stage" ]; then
    git -C vendor/simc worktree remove --force "$(pwd)/$stage" 2>/dev/null || rm -rf "$stage"
  fi
  git -C vendor/simc worktree prune
  git -C vendor/simc worktree add --detach --force "$(pwd)/$stage" "$LOCKED_COMMIT" >/dev/null

  local root
  root="$(pwd)"
  for patch in patches/*.patch; do
    [ -e "$patch" ] || break
    echo "build-engine: applying $patch to the staging worktree"
    # patch (not git apply): git apply silently succeeds without patching in gitignored dirs; patch fails instead.
    ( cd "$stage" && patch -p1 --forward --dry-run -s < "$root/$patch" ) || {
      echo "build-engine: $patch does not apply to $LOCKED_COMMIT. Rebase it against the locked commit." >&2
      exit 1
    }
    ( cd "$stage" && patch -p1 --forward -s < "$root/$patch" )
    # Reverse dry-run succeeds only if patch is present (guard against no-op apply).
    ( cd "$stage" && patch -p1 --reverse --dry-run -s < "$root/$patch" ) || {
      echo "build-engine: $patch reported success but is not present in $stage." >&2
      exit 1
    }
  done

  echo "$stamp" > "$stamp_file"
}

COMMON_LINK="-fwasm-exceptions -sINITIAL_MEMORY=134217728 -sALLOW_MEMORY_GROWTH=1 \
  -sMAXIMUM_MEMORY=4gb -sMODULARIZE=1 -sEXPORT_NAME=createSimc -sENVIRONMENT=worker \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sEXPORTED_RUNTIME_METHODS=callMain,FS -sSTACK_SIZE=4mb"

if [ "$VARIANT" = threaded ]; then
  BUILD_DIR=build/wasm
  ENGINE_DIR=public/engine
  THREAD_CMAKE=-DSC_NO_THREADING=OFF
  CXX_FLAGS="-DSC_USE_PTR=0 -pthread -fwasm-exceptions"
  LINK_FLAGS="-pthread -sPTHREAD_POOL_SIZE=16 $COMMON_LINK"
else
  BUILD_DIR=build/wasm-fallback
  ENGINE_DIR=public/engine/fallback
  THREAD_CMAKE=-DSC_NO_THREADING=ON
  CXX_FLAGS="-DSC_USE_PTR=0 -fwasm-exceptions"
  LINK_FLAGS="$COMMON_LINK"
fi

# Threaded artifact: no patches, builds from vendor/simc. Fallback: needs patches, builds from staging tree.
SOURCE_DIR=vendor/simc
PATCH_ARGS=()
if [ "$VARIANT" = fallback ]; then
  SOURCE_DIR=build/engine-src-fallback
  stage_source "$SOURCE_DIR"
  for patch in patches/*.patch; do
    [ -e "$patch" ] || break
    PATCH_ARGS+=(--patch "$patch")
  done
fi

# ccache wraps emcc whole (Emscripten's documented way). The updater builds every upstream commit
# in a fresh workspace, so this is what turns a full rebuild into a changed-files rebuild.
LAUNCHER=()
if command -v ccache >/dev/null 2>&1; then LAUNCHER=(-DCMAKE_CXX_COMPILER_LAUNCHER=ccache -DCMAKE_C_COMPILER_LAUNCHER=ccache); fi

emcmake cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  ${LAUNCHER[@]+"${LAUNCHER[@]}"} \
  -DBUILD_GUI=OFF -DBUILD_TESTING=OFF \
  -DSC_NO_NETWORKING=ON \
  "$THREAD_CMAKE" \
  -DCMAKE_CXX_FLAGS="$CXX_FLAGS" \
  -DCMAKE_EXE_LINKER_FLAGS="$LINK_FLAGS"

cmake --build "$BUILD_DIR"

mkdir -p "$ENGINE_DIR"
cp "$BUILD_DIR/simc.js" "$BUILD_DIR/simc.wasm" "$ENGINE_DIR/"

# Manifest: identity, capabilities, hashes, sizes (binaries gitignored; manifest committed and validated by app).
node scripts/engine-manifest.mjs --build-dir "$BUILD_DIR" --engine-dir "$ENGINE_DIR" \
  --source-tree "$SOURCE_DIR" ${PATCH_ARGS[@]+"${PATCH_ARGS[@]}"}
