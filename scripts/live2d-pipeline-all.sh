#!/usr/bin/env bash
# End-to-end: character.png -> psd2live-compliant PSD -> Cubism 4 model -> verification.
# Every step is idempotent and re-runnable from scratch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPE="$ROOT/live2d-pipeline"

export JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"

echo "############ 1/5  PSD dependencies ############"
( cd "$ROOT" && node -e "require.resolve('ag-psd')" 2>/dev/null || pnpm add -D ag-psd )

echo "############ 2/5  segentation + PSD ############"
node "$PIPE/tools/segment.mjs"
node "$PIPE/tools/build-psd.mjs"

echo "############ 3/5  build psd2live ############"
bash "$ROOT/scripts/live2d-build-psd2live.sh"

echo "############ 4/5  rig the model ############"
bash "$ROOT/scripts/live2d-run-psd2live.sh"

echo "############ 5/5  verify ############"
node "$PIPE/tools/verify.mjs"

echo
echo "DONE. Model: $ROOT/resources/live2d/models/whale-maid/"
