#!/usr/bin/env bash
# Rig the whale-maid PSD into a Live2D Cubism 4 model family with psd2live's CLI.
# Prereq: scripts/live2d-build-psd2live.sh has run, out/whale-maid.psd exists.
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/live2d-pipeline"
SRC_DIR="$PIPE_DIR/build/psd2live"
GRADLE_BIN="$PIPE_DIR/build/gradle-dist/gradle-9.6.1/bin/gradle"
PSD="$PIPE_DIR/out/whale-maid.psd"
OUTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/resources/live2d/models/whale-maid"

# psd2live targets JDK 21. Prefer an existing JAVA_HOME when it is already 21,
# otherwise ask the platform for one, so this works on any machine.
if [ -z "${JAVA_HOME:-}" ] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -q 'version "21\.'; then
  if [ -x /usr/libexec/java_home ]; then
    JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
  fi
fi
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "psd2live needs JDK 21; set JAVA_HOME to a 21 install" >&2
  exit 1
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
# A stale proxy in ~/.gradle/gradle.properties (pointing at a port nothing
# listens on) makes every Gradle network call fail with "Connection refused".
# The file is left untouched; the proxy is cleared for this build only.
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
