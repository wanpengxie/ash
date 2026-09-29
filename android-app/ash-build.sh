#!/bin/bash
# ash 构建脚本（macOS / Linux：Android SDK build-tools + JDK 17 及以上）
#
# 不重做 payload：node 运行时、DSH 内核、python/npm/git 等整包复用 DSH 官方 APK 的 assets，
# 只重新编译原生壳（src/ + res/ + AndroidManifest.xml），再把应用 ID 改成 ai.ash.agent。
#
# 用法：
#   BASE_APK=~/ash-build/DeepSeekHarness-official-v1.16.1.apk bash android-app/ash-build.sh
# 可选环境变量：
#   ANDROID_HOME   SDK 根目录（默认 ~/Library/Android/sdk）
#   BUILD_TOOLS    build-tools 目录（默认取最新）
#   ANDROID_JAR    platform android.jar（默认取最新 platform）
#   JAVA_HOME      JDK（默认 Android Studio 自带的 JBR）
#   ASH_KEYSTORE   签名密钥（默认 ~/.ash/ash-debug.jks，不存在则自动生成调试密钥）
set -euo pipefail

P="$(cd "$(dirname "$0")" && pwd)"
APP_ID="ai.ash.agent"
: "${BASE_APK:?请 export BASE_APK=<DSH 官方 APK 路径>}"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="${BUILD_TOOLS:-$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)}"
AJ="${ANDROID_JAR:-$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)/android.jar}"
JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
JAVA="$JAVA_HOME/bin"
# d8 / apksigner 是 java 包装脚本，也要能找到这个 JDK
export JAVA_HOME PATH="$JAVA:$PATH"
KS="${ASH_KEYSTORE:-$HOME/.ash/ash-debug.jks}"
OUT="$P/out-ash"

for t in "$BT/aapt" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$JAVA/javac" "$AJ" "$BASE_APK"; do
  [ -e "$t" ] || { echo "!! 缺少 $t"; exit 1; }
done

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/base" "$OUT/shizuku-cls"

echo "== 1/6 复用官方 payload =="
( cd "$OUT/base" && unzip -q "$BASE_APK" 'assets/*' )
ASSETS="$OUT/base/assets"
cp "$P/../mobile-patch/mobile.css" "$ASSETS/mobile.css"
cp "$P/../mobile-patch/mobile.js" "$ASSETS/mobile.js"
ls -la "$ASSETS"

echo "== 2/6 aapt 生成 R =="
"$BT/aapt" package -f -m -J "$OUT/gen" -M "$P/AndroidManifest.xml" -S "$P/res" -I "$AJ"

echo "== 3/6 javac =="
SHIZUKU_JARS=""
for AAR in "$P/libs/shizuku-api.aar" "$P/libs/shizuku-provider.aar" "$P/libs/shizuku-aidl.aar"; do
  TMP="$OUT/$(basename "$AAR" .aar)"
  mkdir -p "$TMP"
  ( cd "$TMP" && "$JAVA/jar" xf "$AAR" classes.jar )
  ( cd "$OUT/shizuku-cls" && "$JAVA/jar" xf "$TMP/classes.jar" )
  SHIZUKU_JARS="$SHIZUKU_JARS${SHIZUKU_JARS:+:}$TMP/classes.jar"
done
# 新增 Java 代码不要用 lambda / 方法引用（沿用上游约定，bootclasspath 下编不过）
"$JAVA/javac" -nowarn -encoding UTF-8 -source 1.8 -target 1.8 -bootclasspath "$AJ" \
  -classpath "$OUT/gen:$SHIZUKU_JARS" -d "$OUT/classes" \
  "$P"/src/com/deepseek/harness/*.java "$P"/src/com/deepseek/harness/vscreen/*.java \
  "$OUT/gen/com/deepseek/harness/R.java" 2>&1 | grep -v -E "^warning:|^Note:|bootstrap class path|^[0-9]+ warnings?$" || true
[ -f "$OUT/classes/com/deepseek/harness/MainActivity.class" ] || { echo "!! javac 失败"; exit 1; }
echo "  class 数：$(find "$OUT/classes" -name '*.class' | wc -l | tr -d ' ')"

echo "== 4/6 d8 =="
{ find "$OUT/classes" -name '*.class'; find "$OUT/shizuku-cls" -name '*.class'; } > "$OUT/classes.rsp"
"$BT/d8" --release --lib "$AJ" --min-api 24 --output "$OUT/dex" @"$OUT/classes.rsp"

# ASH_DEBUG=1（默认）：调试包，可 adb shell run-as 读引擎日志与私有目录
DEBUG_FLAG=""
[ "${ASH_DEBUG:-1}" = "1" ] && DEBUG_FLAG="--debug-mode"
echo "== 5/6 打包（应用 ID → ${APP_ID}）=="
# -0 zip：payload.zip 原样存储不再压缩
"$BT/aapt" package -f -M "$P/AndroidManifest.xml" -S "$P/res" -I "$AJ" -A "$ASSETS" -0 zip $DEBUG_FLAG \
  --rename-manifest-package "$APP_ID" -F "$OUT/unsigned.apk"
( cd "$OUT/dex" && "$BT/aapt" add "$OUT/unsigned.apk" classes.dex >/dev/null )
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "== 6/6 签名 =="
if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  "$JAVA/keytool" -genkeypair -keystore "$KS" -storepass android -keypass android -alias ash \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=ash debug" >/dev/null
  echo "  已生成调试密钥 $KS"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:"${ASH_KS_PASS:-android}" --ks-key-alias "${ASH_KS_ALIAS:-ash}" \
  --out "$P/Ash.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$P/Ash.apk"
"$BT/aapt" dump badging "$P/Ash.apk" | head -3
ls -la "$P/Ash.apk"
echo "BUILD OK -> $P/Ash.apk"
