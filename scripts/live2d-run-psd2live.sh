#!/usr/bin/env bash
# Rig the whale-maid PSD into a Live2D Cubism 4 model family with psd2live's CLI.
# Prereq: scripts/live2d-build-psd2live.sh has run, out/whale-maid.psd exists.
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/live2d-pipeline"
SRC_DIR="$PIPE_DIR/build/psd2live"
GRADLE_BIN="$PIPE_DIR/build/gradle-dist/gradle-9.6.1/bin/gradle"
PSD="$PIPE_DIR/out/whale-maid.psd"
OUTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/resources/live2d/models/whale-maid"

export JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"
JVMARGS="-Xmx8g -Dfile.encoding=UTF-8 -Dhttp.nonProxyHosts=* -Dhttp.proxyHost= -Dhttps.proxyHost= -Dhttp.proxyPort= -Dhttps.proxyPort="

[ -f "$PSD" ] || { echo "missing $PSD — run tools/segment.mjs && tools/build-psd.mjs first" >&2; exit 1; }
mkdir -p "$OUTDIR"

cd "$SRC_DIR"
echo "==> psd2live CLI"
echo "    in : $PSD"
echo "    out: $OUTDIR"
"$GRADLE_BIN" run --console=plain --no-daemon -Dorg.gradle.jvmargs="$JVMARGS" \
  --args="--input $PSD --output $OUTDIR --atlas 4096 --mesh-spacing 64 --lang en"

echo "==> produced:"
ls -la "$OUTDIR"
