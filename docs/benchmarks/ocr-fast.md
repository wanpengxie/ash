# PP-OCRv6 small / CPU / real batching

2026-10-16. Baseline: `74af87fdbfa50028a8276dbabb60dce3e47e9780` (0.4.60). Work is isolated in `feat/ocr-fast`; no APK installation, release, push, or phone modification is part of this benchmark.

The target is 20–30 screen lines in less than one second **on the phone**, with no substantial accuracy loss. Desktop timings do not establish that target. The prior phone report was 24 lines taking about 7.5–9 seconds in recognition and about 0.4 seconds in detection. The new implementation still needs the owner's same-image `ocr.read` comparison.

Final desktop warm 24-line p50/p95 is **484.15 / 501.46 ms**, versus **1660.29 / 1852.14 ms** for the old medium path (3.43× p50 speedup). At 30 lines the new path is **572.39 / 594.38 ms**. Accuracy is not unchanged: the independent difficult 115-character sample has 2 errors with medium, 3 with small, and 9 with tiny. Phone acceptance remains outstanding.

## Models and compatibility

Sources are the official [PaddlePaddle small recognition model](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx), [small detector](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx), and [tiny recognition model](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx). Download revisions, byte counts, and full SHA-256 values are checked in `tools/ocr-fetch-models.sh`; the app's sole default is small and retains its existing two-host, resumable, size-and-SHA-verified download path.

| Default | Fixed revision | Bytes | SHA-256 |
|---|---|---:|---|
| small det | `28fe5895c24fd108c19eb3e8479f4ab385fbfc62` | 9,880,512 | `d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e` |
| small rec | `b8f84f0b80c529de40b4fbb3544b84fa7233a513` | 21,159,378 | `5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634` |
| orientation | `aea1f18d97338aaf84b463f90192f2820524a00a` | 1,019,454 | `94a6a0a0425f2b5f08b5df72086f2d72abe40f1d22f6d12d2cd83674f11f2ff3` |

The small recognizer's fixed `inference.yml` has exactly the same 18,708 dictionary entries, in the same order, as the app's asset and medium. Actual model output has 18,710 classes, including CTC blank and the appended space. Small and medium detector thresholds are both 0.2 / 0.45 / 1.4. Tiny instead has 6,904 dictionary entries, 6,906 output classes, and detector box threshold 0.4; its benchmark uses its own generated dictionary and threshold. Tiny is not a renamed medium model and is not the app default.

Real dynamic-batch checks cover recognizer inputs `[2,3,48,160]` -> `[2,20,18710]` for small, and orientation `[3,3,80,160]` -> `[3,2]`. Time dimension at non-aligned widths is `floor((width+3)/8)`: widths 17/20 yield two steps; 21/28 yield three; 29 yields four. Effective-width masking uses this verified formula, rather than `ceil(width/8)`.

The fixed det/rec YAML specifies BGR. Official PaddleX [text detection](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/inference/models/text_detection/predictor.py) and [recognition](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/inference/models/text_recognition/predictor.py) readers honor `DecodeImage.img_mode`; [classification](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/inference/models/image_classification/predictor.py) defaults to RGB for orientation. This fixes the prior app's RGB det/rec inputs. The baseline explicitly retains that original RGB behavior. Recognition still uses height 48, aspect-preserving width 16–3200, normalization `(pixel/255-0.5)/0.5`, and zero padding after normalization, consistent with the official [recognition processors](https://github.com/PaddlePaddle/PaddleX/blob/develop/paddlex/inference/models/text_recognition/processors.py).

Published recognition accuracy is not equal across tiers:

| Official metric | medium | small | tiny |
|---|---:|---:|---:|
| Overall | 83.2% | 81.3% | see official card |
| Screen | 82.5% | 79.7% | 71.2% |
| Printed Chinese | 91.5% | 90.5% | 86.7% |

Small is the speed/coverage compromise. Tiny's screen accuracy and dictionary coverage regress too far to choose it merely for speed. A few deterministic pictures cannot replace the official evaluation or establish unchanged real-world accuracy.

## Production changes

The detector and its rectangle postprocessor are retained. Recognition sorts indices by effective width and groups widths within a 1.25 ratio, at most eight rows per batch, with `paddedWidth * batch <= 2048` except an unavoidable single row up to width 3200. Only the current group of full-resolution crops is retained. Recognition output is therefore at most about 19.2 MB per ordinary group or 29.9 MB for one maximum-width row; ORT output and the copied JVM array coexist, and this is **not** a bound on the entire native working set.

Orientation also runs a true batch. The existing 90° turn for tall crops and >0.9 confidence 180° correction remain. Each CTC row has independent repeat state; padded steps are masked; answers are placed back at their detector indices before normal reading-order layout. The final partial batch is not duplicated.

Thread count estimates performance cores from readable `cpu_capacity`, otherwise `cpuinfo_max_freq`, taking cores at least 75% of the maximum and capping at four / available processors. Incomplete or inaccessible topology uses at most two threads. No phone model names or forced affinity are used.

The Android 1.31.0 AAR contains XNNPACK implementation symbols and the Java API includes `SessionOptions.addXnnpack(Map)`. The desktop 1.31.0 binary reports only `[CPU]`. Therefore **no XNNPACK speedup was measured and it is not enabled by default**. The internal benchmark option tries ORT intra=1, disables intra-op spinning, gives XNNPACK its own configured pool, and falls back to CPU if provider registration/session creation fails. This follows [ORT's official XNNPACK guidance](https://onnxruntime.ai/docs/execution-providers/Xnnpack-ExecutionProvider.html). NNAPI was not enabled or represented as tested.

## Method and limitations

Host: Intel Core i7-6800K, six physical cores / twelve logical CPUs, x86_64 Linux; Java ORT 1.31.0 and cached Kotlin compiler 2.0.21. This is a shared host with no affinity or frequency lock. Configurations run sequentially, never as concurrent OCR jobs. Quantiles are descriptive nearest-rank p95; nine warm samples are not a precise tail-latency estimate.

`tools/ocr-benchmark.sh` compiles the **actual** production `OcrPipeline.kt`, `OcrImage.kt`, `OrtNet.kt`, and `OcrCpu.kt`. There is no Python replacement for the measured OCR path. Baseline mode keeps medium weights, the old one-row orientation and recognition calls, exact unpadded widths, and original RGB inputs. Timing instrumentation and the surrounding result collection add small overhead to both paths. `OrtNet` includes session execution and output tensor copying in inference time.

Pictures are deterministic 1080×2400 screens with 0/1/5/10/20/24/30 lines, plus a 24-line screen with every third line inverted, a 24-line dark screen, and an eight-line accuracy screen. They use Noto Sans CJK Regular 36px; the source strings are hand-authored independent ground truth, not either recognizer's output. The existing five-line serif sample is an extra check. This set does not represent photos, blur, arbitrary skew, all fonts, or real phone screenshots.

The font file is `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`, SHA-256 `b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a`; compare that fingerprint when reproducing generated pictures on another host.

CER is character Levenshtein distance after removing whitespace only. Fullwidth `￥` versus `¥`, and `℃` versus `°C`, remain errors; there is no normalization chosen to erase them. Missing lines count expected row centers having no returned box within 34px. Rows are 72px apart. A correct box with wrong text therefore affects CER rather than being called a missed detection. Raw JSON retains text, expected text, counts, timings, and iteration indices.

Warm measurement creates fresh sessions per fixture, records the first call separately (`iteration=-2`), runs an additional warmup (`-1`), then records nine samples (`0..8`). Repeated cold measurement creates five fresh sets of sessions per fixture. "Cold" means **fresh ORT sessions with cached model files and an existing process/environment**, not cold filesystem cache, app startup, download, Android bitmap decode, or full process startup. Blank images correctly avoid loading the two unused line sessions.

## Desktop results

All values below are milliseconds, each cell p50 / p95 of nine warm calls. Both the primary baseline and default comparison use four ORT CPU threads. Blank images measure detection only.

| Screen lines | old medium, one row per call | small, width batches | tiny, width batches |
|---:|---:|---:|---:|
| 0 | 419.40 / 434.91 | 102.68 / 104.88 | 60.32 / 68.08 |
| 1 | 461.60 / 471.46 | 119.15 / 141.13 | 75.09 / 83.73 |
| 5 | 656.48 / 734.04 | 195.23 / 208.58 | 95.97 / 108.55 |
| 10 | 955.68 / 982.96 | 271.11 / 281.72 | 126.25 / 132.69 |
| 20 | 1434.56 / 1514.92 | 418.88 / 450.32 | 175.91 / 189.48 |
| 24 | 1660.29 / 1852.14 | 484.15 / 501.46 | 221.97 / 238.04 |
| 30 | 1964.35 / 2593.66 | 572.39 / 594.38 | 246.35 / 266.43 |

24-line phase medians (individual medians need not sum to the median total):

| Path | Detection | Crop/rotate/normalize | Orientation inference | Recognition inference + output copy | CTC decode |
|---|---:|---:|---:|---:|---:|
| old medium, one row | 418.00 | 42.25 | 24.56 | 1162.77 | 7.08 |
| small, width batches | 103.00 | 45.10 | 15.66 | 314.77 | 7.88 |
| tiny, width batches | 69.00 | 52.48 | 14.63 | 82.16 | 3.83 |

Thread / call-strategy comparison on the same 24-line fixture:

| Model / call strategy | CPU threads | Total p50 / p95 |
|---|---:|---:|
| medium, one row, original RGB | 4 | 1660.29 / 1852.14 |
| medium, batches, corrected BGR | 4 | 1715.07 / 1857.45 |
| small, one row | 4 | 567.33 / 612.02 |
| small, batches | 1 | 1077.12 / 1121.91 |
| small, batches | 2 | 663.94 / 669.48 |
| small, batches | 3 | 530.29 / 626.07 |
| small, batches | 4 | 484.15 / 501.46 |

Changing weights is the main improvement. Batching alone does not fix medium's compute cost. For small at four threads, batching improves p50 by about 15% over one-row calls. The medium batch comparison also corrects the old RGB input order; it is an exploratory control, not a claim that batching alone changed its accuracy.

Least-squares fits to p50 total time of the seven ordinary 0–30-line screens:

| Path | Fixed overhead + cost per nominal line | R² |
|---|---|---:|
| old medium | 414.37 ms + 51.69 ms/line | 0.9995 |
| small batches | 108.85 ms + 15.57 ms/line | 0.9990 |
| tiny batches | 64.41 ms + 6.12 ms/line | 0.9914 |

The 24-line inverted and dark fixtures are also retained: small is 486.24 / 511.88 ms and 507.58 / 578.52 ms respectively. The old-medium inverted/dark measurements have substantially more shared-host variation (2771.99 / 3487.76 and 2606.53 / 2908.02 ms); do not extrapolate those larger ratios to phones.

Fresh-session cold calls, five independent session sets per fixture (p50 / p95):

| Lines | old medium | small batches | tiny batches |
|---:|---:|---:|---:|
| 0 | 557.59 / 669.43 | 146.69 / 160.76 | 115.35 / 116.19 |
| 24 | 2608.76 / 2984.77 | 943.90 / 1518.24 | 346.71 / 413.39 |
| 30 | 3224.21 / 5320.26 | 942.19 / 1002.07 | 410.03 / 542.46 |

Cold 24-line phase medians, in the same detection / prepare / orientation / recognition-copy / decode order: medium **691.00 / 52.21 / 56.48 / 1813.37 / 9.58 ms**; small **191.00 / 56.81 / 41.75 / 563.47 / 12.01 ms**; tiny **114.00 / 54.73 / 38.25 / 138.84 / 4.31 ms**. All other cold line counts and phases are in the raw JSON. Cold small p95 still exceeds one second on this desktop; there is no basis for promising cold phone calls under a second.

Independent accuracy, whitespace removed only:

| Fixture | Ground-truth characters | medium errors / CER | small errors / CER | tiny errors / CER | Missed rows |
|---|---:|---:|---:|---:|---:|
| 24 ordinary rows | 306 | 3 / 0.98% | 3 / 0.98% | 4 / 1.31% | 0 for all |
| 24 inverted rows | 306 | 3 / 0.98% | 3 / 0.98% | 4 / 1.31% | 0 for all |
| 24 dark rows | 306 | 2 / 0.65% | 3 / 0.98% | 4 / 1.31% | 0 for all |
| 8 difficult rows | 115 | 2 / 1.74% | 3 / 2.61% | 9 / 7.83% | 0 for all |

The difficult sample includes traditional Chinese, rare names, Japanese, currency/decimal values, six-digit numbers and `ASH-O0I1l-5086`. Small mistakes the final lowercase `l` for uppercase `I`; both medium and small struggle with the very rare characters `龘靐`. Tiny additionally corrupts Japanese and more of the mixed serial number. The ordinary CER includes visually related `¥`/`￥` and `°C`/`℃` substitutions. Small one-row and batched outputs are identical after whitespace removal on every deterministic fixture, but that is only an incremental batching check; the CER table above uses independent expected text.

Committed artifacts: [880 warm-matrix records including first call and warmup](ocr-fast-data/warm.json), [150 fresh-session records](ocr-fast-data/cold.json), [model hashes / configuration / actual batch shapes](ocr-fast-data/model-evidence.json), [observed production recognition batches](ocr-fast-data/actual-batches.txt), [difficult sample](ocr-fast-data/accuracy.png), and [inverted sample](ocr-fast-data/inverted.png). The warm matrix has 720 measured warm calls, 80 first calls, and 80 extra warmups; repeated cold has three configurations × ten fixtures × five first calls. No model binaries are committed.

## Reproduction

The standalone Kotlin runner uses dependencies already in the Gradle cache (normally populated by the project's Android/JVM build). Model binaries stay under `/tmp`, never in git.

```sh
bash tools/ocr-fetch-models.sh /tmp/ash-ocr-fast-models
python3 -m venv /tmp/ash-ocr-fast-venv
/tmp/ash-ocr-fast-venv/bin/pip install onnxruntime==1.23.2 numpy pillow pyyaml
/tmp/ash-ocr-fast-venv/bin/python tools/ocr-model-evidence.py /tmp/ash-ocr-fast-models
bash tools/ocr-benchmark.sh /tmp/ash-ocr-fast-models /tmp/ash-ocr-fast-benchmark/warm.json 9
ASH_OCR_BENCH_COLD_REPEATS=5 bash tools/ocr-benchmark.sh /tmp/ash-ocr-fast-models /tmp/ash-ocr-fast-benchmark/cold.json 0 'medium-b1-t4,small-b8-t4,tiny-b8-t4'
python3 tools/ocr-benchmark-summary.py /tmp/ash-ocr-fast-benchmark/warm.json
python3 tools/ocr-benchmark-summary.py /tmp/ash-ocr-fast-benchmark/cold.json
```

The Python ORT 1.23.2 check only inspects models / validates shapes / exports benchmark dictionaries. Main performance numbers use Java ORT 1.31.0. `ASH_OCR_BENCH_PROVIDER=xnnpack` is an internal measurement option and must be interpreted alongside the reported available providers; a CPU fallback is not an XNNPACK result.

Related JVM / Android compilation command (single Gradle invocation and one worker; run in the controller's allocated build slot):

```sh
cd android
JAVA_HOME=/tmp/ash604-jdk-hchPUl/jdk ANDROID_HOME=/home/xiewanpeng/android-sdk ASH_OCR_MODELS=/tmp/ash-ocr-fast-models/small ./gradlew :app:compileDebugKotlin :app:testDebugUnitTest --tests 'ai.ash.caps.perception.Ocr*Test' --tests 'ai.ash.caps.perception.ModelStoreTest' --max-workers=1 --console=plain
```

The 35 related tests cover width grouping, padding/channels, empty detections, independent batch CTC state, effective-width masking, original-index restoration, final partial batches, inverted/tall crops, maximum-width isolation, topology/fallback, model downloads, and real ONNX batch>1 / stride boundaries / unavailable-XNNPACK fallback. Android build/test execution is awaiting the controller's build slot at the time of this report; do not infer a pass from the standalone Kotlin compilation.

## Phone acceptance still required

Use the same owner-selected 20/24/30-line screenshots and independently transcribed text on old 0.4.60 and the next app build. After model downloads finish, measure one fresh-model call and at least ten warm calls through Ash `ocr.read`; preserve every response and compare p50/p95, boxes, CER, missing lines, and critical Chinese/English/numeric tokens. Include a dark screen and upside-down rows. New responses expose `prepare_ms`, `orientation_ms`, `inference_ms`, and `decode_ms` inside the existing recognition total, so the phone bottleneck can be located without a settings UI. Check peak memory and 90-second session release separately.

ORT sessions remain lazy. On the first call, graph/session construction is included in that network's detect/orientation/inference phase; the existing `load_ms` mostly covers model-store/download and reader setup, and must not be treated as a separate complete weight-load measurement.

Only that comparison can establish the phone's <1s target. No desktop result in this document is a phone claim.
