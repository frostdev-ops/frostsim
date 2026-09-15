#!/usr/bin/env bash
# Obtain exact upstream SimulationCraft revision from engine.lock.json into vendor/simc (PLAN P00.3); idempotent verification.
# Never tracks moving branch; commit is checked out detached; vendor/simc is read-only, refuses local mods.
set -euo pipefail
cd "$(dirname "$0")/.."

read -r REMOTE BRANCH COMMIT DIR <<<"$(node -e '
const l = JSON.parse(require("fs").readFileSync("engine.lock.json", "utf8")).upstream;
process.stdout.write([l.remote, l.branch, l.commit, l.path].join(" "));
')"

# FROSTSIM_ENGINE_DIR retargets checkout (clean-clone path untestable without destroying working checkout).
DIR="${FROSTSIM_ENGINE_DIR:-$DIR}"

if [ ! -d "$DIR/.git" ]; then
  echo "bootstrap: $DIR absent, fetching $COMMIT from $REMOTE"
  mkdir -p "$DIR"
  git -C "$DIR" init -q
  git -C "$DIR" remote add origin "$REMOTE"
  # Single-commit fetch (GitHub allows arbitrary reachable SHA); pulls ~360 MB tree not full history.
  git -C "$DIR" fetch -q --depth 1 origin "$COMMIT"
  git -C "$DIR" checkout -q --detach FETCH_HEAD
  echo "bootstrap: checked out $COMMIT"
  exit 0
fi

ACTUAL_REMOTE="$(git -C "$DIR" remote get-url origin 2>/dev/null || echo none)"
if [ "$ACTUAL_REMOTE" != "$REMOTE" ]; then
  echo "bootstrap: $DIR points at '$ACTUAL_REMOTE', lock says '$REMOTE'." >&2
  echo "           Refusing to repoint an existing checkout. Move it aside and rerun." >&2
  exit 1
fi

HEAD="$(git -C "$DIR" rev-parse HEAD)"
if [ "$HEAD" = "$COMMIT" ]; then
  DIRTY="$(git -C "$DIR" status --porcelain | head -5)"
  if [ -n "$DIRTY" ]; then
    echo "bootstrap: $DIR is at the locked commit but has local modifications:" >&2
    echo "$DIRTY" >&2
    echo "           vendor/simc is read-only; engine changes belong in patches/. Not touching it." >&2
    exit 1
  fi
  echo "bootstrap: $DIR already at $COMMIT (clean)"
  exit 0
fi

DIRTY="$(git -C "$DIR" status --porcelain | head -5)"
if [ -n "$DIRTY" ]; then
  echo "bootstrap: $DIR has local modifications; refusing to move it from $HEAD to $COMMIT." >&2
  echo "$DIRTY" >&2
  exit 1
fi

echo "bootstrap: moving $DIR from $HEAD to $COMMIT"
git -C "$DIR" fetch -q origin "$COMMIT" || git -C "$DIR" fetch -q origin "$BRANCH"
git -C "$DIR" checkout -q --detach "$COMMIT"
echo "bootstrap: checked out $COMMIT"
