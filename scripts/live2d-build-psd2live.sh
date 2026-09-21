#!/usr/bin/env bash
# Build psd2live (Kotlin/JVM) from source on macOS.
# No published macOS binary exists — Releases are Windows-only.
#
# Handles the two environment traps on this machine:
#   1. ~/.gradle/gradle.properties pins a dead proxy (127.0.0.1:7890)  -> neutralised per-invocation
#   2. the gradlew wrapper cannot download its distribution            -> standalone Gradle 9.6.1 used
# Neither config file is modified.
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/live2d-pipeline"
BUILD_DIR="$PIPE_DIR/build"
SRC_DIR="$BUILD_DIR/psd2live"
GRADLE_VERSION=9.6.1
GRADLE_HOME="$BUILD_DIR/gradle-dist/gradle-$GRADLE_VERSION"
GRADLE_BIN="$GRADLE_HOME/bin/gradle"
TARBALL_URL="https://codeload.github.com/tsunehimatoi/psd2live/tar.gz/refs/heads/master"
GRADLE_URL="https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"

export JAVA_HOME=/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"

# strip the stale proxy for every JVM Gradle forks
JVMARGS="-Xmx8g -Dfile.encoding=UTF-8 -Dhttp.nonProxyHosts=* -Dhttp.proxyHost= -Dhttps.proxyHost= -Dhttp.proxyPort= -Dhttps.proxyPort="

mkdir -p "$BUILD_DIR"

# ── 1. source ────────────────────────────────────────────────────────────────
if [ ! -f "$SRC_DIR/build.gradle.kts" ]; then
  echo "==> fetching psd2live source"
  curl -fL --max-time 600 --retry 3 -o "$BUILD_DIR/psd2live.tar.gz" "$TARBALL_URL"
  tar xzf "$BUILD_DIR/psd2live.tar.gz" -C "$BUILD_DIR"
  mv "$BUILD_DIR/psd2live-master" "$SRC_DIR"
fi
echo "==> source: $SRC_DIR"

# ── 2. gradle ────────────────────────────────────────────────────────────────
if [ ! -x "$GRADLE_BIN" ]; then
  echo "==> fetching Gradle $GRADLE_VERSION"
  curl -fL --max-time 900 --retry 3 -o "$BUILD_DIR/gradle-$GRADLE_VERSION-bin.zip" "$GRADLE_URL"
  mkdir -p "$BUILD_DIR/gradle-dist"
  unzip -q -o "$BUILD_DIR/gradle-$GRADLE_VERSION-bin.zip" -d "$BUILD_DIR/gradle-dist"
fi
"$GRADLE_BIN" --version | head -5

# ── 3. build ─────────────────────────────────────────────────────────────────
cd "$SRC_DIR"
echo "==> gradle compileKotlin"
"$GRADLE_BIN" compileKotlin --console=plain --no-daemon -Dorg.gradle.jvmargs="$JVMARGS"
echo "==> BUILD OK  (main class io.github.psd2live.MainKt)"
