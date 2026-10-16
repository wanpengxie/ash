#!/usr/bin/env bash
set -euo pipefail
# Compile only the actual pure-Kotlin production path, without Gradle/Android tasks.
cd "$(dirname "$0")/.."
cache=${GRADLE_USER_HOME:-$HOME/.gradle}/caches/modules-2/files-2.1
out=${ASH_OCR_BENCH_OUT:-/tmp/ash-ocr-fast-benchmark}
mkdir -p "$out"
jar() { find "$cache/$1/$2" -name '*.jar' -print -quit; }
stdlib=$(jar org.jetbrains.kotlin/kotlin-stdlib 2.0.21)
compiler=$(jar org.jetbrains.kotlin/kotlin-compiler-embeddable 2.0.21)
reflect=$(find "$cache/org.jetbrains.kotlin/kotlin-reflect" -name '*.jar' -print -quit)
script=$(jar org.jetbrains.kotlin/kotlin-script-runtime 2.0.21)
trove=$(find "$cache/org.jetbrains.intellij.deps/trove4j" -name '*.jar' -print -quit)
coroutines=$(find "$cache/org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm" -name '*.jar' -print -quit)
annotations=$(find "$cache/org.jetbrains/annotations" -name '*.jar' -print -quit)
ort=$(jar com.microsoft.onnxruntime/onnxruntime 1.31.0)
json=$(jar org.json/json 20240303)
classpath="$stdlib:$annotations:$ort:$json"
java -cp "$compiler:$stdlib:$reflect:$script:$trove:$coroutines:$annotations" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -no-stdlib -no-reflect -jvm-target 17 -classpath "$classpath" -d "$out/classes" \
  android/app/src/main/java/ai/ash/caps/perception/{OcrPipeline,OcrImage,OrtNet,OcrCpu}.kt tools/OcrBenchmark.kt
java -Xmx2g -Djava.awt.headless=true -cp "$out/classes:$classpath" ai.ash.caps.perception.OcrBenchmarkKt "$@"
