#!/usr/bin/env bash
# Builds native linux/amd64 simc for the bench image, on an x86 Docker host (the VPS).
# Usage: build-native.sh <upstream sha>. Capped at 3 CPUs: the VPS also serves production.
set -euo pipefail
SHA="${1:?upstream sha}"
cd "$(dirname "$0")"
if [ "$(cat src/.sha 2>/dev/null)" != "$SHA" ]; then
  rm -rf src && mkdir src
  curl -fsSL "https://codeload.github.com/simulationcraft/simc/tar.gz/$SHA" | tar -xz -C src --strip-components=1
  echo "$SHA" > src/.sha
fi
mkdir -p out
docker run --rm --cpus 3 -v "$PWD/src:/src" -v "$PWD/out:/out" node:26-slim bash -ec '
  apt-get update -qq && apt-get install -y -qq --no-install-recommends cmake ninja-build g++ >/dev/null
  cmake -S /src -B /out/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_GUI=OFF -DBUILD_TESTING=OFF \
    -DSC_NO_NETWORKING=ON -DCMAKE_CXX_FLAGS="-DSC_USE_PTR=0"
  cmake --build /out/build -j 3
  cp /out/build/simc /out/simc'
ls -l out/simc
