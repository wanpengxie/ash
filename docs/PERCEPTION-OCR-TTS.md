# 手机上的文字识别（ocr.read）和语音合成（tts.speak）

> 状态：已实现。旧 medium 在手机上收到 24 行识别约 7.5–9 秒、检测约 0.4 秒的反馈；本轮 small / batch 改动**尚未真机验证**。桌面速度不能作为手机达标证据。
> 范围：OCR（PP-OCRv6 small，本机推理）和 TTS（系统引擎）。ASR 不在本次范围。

本轮小模型、真实 batch、准确率与可重跑桌面基准见 [OCR 性能报告](benchmarks/ocr-fast.md)。

## 1. 要什么

底层感知层要两样便宜、高频、离线的能力，做成手机 hand 上的标准词，经中枢路由，`risk: none`，主人和 agent 调同一套词，没有审批、没有只给人用的入口：

- `ocr.read`：读出图片里的字。
- `tts.speak`：把文字念出来，或做成音频文件。

词在 `packages/sdk/src/namespaces.ts`（`ocr`、`tts` 两个标准命名空间），Kotlin 实现在 `android/app/src/main/java/ai/ash/caps/perception/`，技能是 `packages/ash-skills/skills/perception`。

## 2. 后端选型：ONNX Runtime（Android）

**核实过的事实**（2026-10-15 查 Hugging Face 的 PaddlePaddle 组织）：

- PP-OCRv6 于 2026-06 发布（PaddleOCR 3.7.0），分 tiny / small / medium 三档，Apache-2.0。
- medium 的检测和识别模型各有三种发布形式：Paddle 推理模型（`inference.json` + `inference.pdiparams`）、safetensors、**官方 ONNX 导出**（`PP-OCRv6_medium_det_onnx`、`PP-OCRv6_medium_rec_onnx`）。**没有**官方的 Paddle Lite（`.nb`）、NCNN、MNN 版本。
- 文字行方向（0° / 180°）模型 `PP-LCNet_x0_25_textline_ori_onnx` 也有官方 ONNX，1 MB。
- 官方 ONNX 文件在桌面 ONNX Runtime 1.31 上直接能跑：检测输入 `x [N,3,H,W]` 动态尺寸，输出概率图；识别输入 `x [N,3,48,W]`，输出 `[N,T,18710]`（18708 个字典字符 + 空白 + 空格）；方向模型输入 `[N,3,80,160]`，输出 2 类概率。

**选 ONNX Runtime（`onnxruntime-android` 1.31.0，MIT）的理由：**

1. 官方给的就是 ONNX，不用转换。Paddle Lite / NCNN / MNN 都得自己转换；v6 用了新结构（LCNetV4 重参数化骨干、RepLKFPN、EncoderWithLightSVTR），转换后算子是否齐全、结果是否一致，要逐个验证，而手机上我没法验证。
2. 同一份计算图、同一套 API 在桌面 JVM 上能跑（`com.microsoft.onnxruntime:onnxruntime`），所以整条识别流程有端到端的单元测试（第 7 节），不依赖手机。
3. 动态输入尺寸（检测按图大小、识别按行宽）在 ORT 里是原生支持的。

**代价（量过）**：AAR 55 MB（四种 ABI），本应用的 `abiFilters` 只留 arm64，实际进安装包的是 `libonnxruntime.so`（34.2 MB，未压缩存放）和 `libonnxruntime4j_jni.so`（92 KB）。手机应用的调试包从 6.7 MB 变成 41 MB。`.so` 的 LOAD 段按 16 KB 对齐，可以在 16 KB 页的系统上运行。**[推测]** 用 ORT 的「按算子裁剪」自编译版本可以明显缩小，但要自己维护构建，先不做。**[推测]** 速度上 Paddle Lite 的手机端优化可能更好，但没有 v6 的现成模型，不值得为此承担转换风险；以后可以只换 `Net` 的实现（第 4 节），流程不动。

默认用 CPU（ORT 的 arm64 内核）。优先读取 CPU capacity，缺失时读取最大频率，估计性能核数量并取 1–4 线程；权限不允许读取时回退到至多 2 线程，不按手机型号写死。XNNPACK 的 Java API 已确认，桌面预编译 ORT 1.31 只有 CPU provider，无法比较手机收益，因此未默认开启。内部基准入口支持 XNNPACK 探索，配置独立线程池、ORT intra=1 和关闭 spinning，provider 不支持时回 CPU。NNAPI 未开启。

## 3. 模型：来源、大小、下载、校验

| 文件 | 来源（Hugging Face，固定到提交） | 大小 | sha-256 |
|---|---|---|---|
| 检测 | `PaddlePaddle/PP-OCRv6_small_det_onnx` @ `28fe5895…` | 9,880,512 | `d73e0058…e9c9410e` |
| 识别 | `PaddlePaddle/PP-OCRv6_small_rec_onnx` @ `b8f84f0b…` | 21,159,378 | `5435fd74…fa24634` |
| 方向 | `PaddlePaddle/PP-LCNet_x0_25_textline_ori_onnx` @ `aea1f18d…` | 1,019,454 | `94a6a0a0…f11f2ff3` |

合计 32,059,344 字节，约 30.6 MiB。完整提交号和校验值在 `OcrModels.kt`；大小和 sha-256 与下载实物和 Hugging Face LFS 元数据均相符。small 与旧 medium 的 18,708 项识别字典逐项一致，检测阈值也是 0.2 / 0.45 / 1.4。tiny 的字典只有 6,904 项、检测 box 阈值为 0.4，不能复用 small/medium 的字典与全部阈值；它只参与独立对照。

- **不进安装包**。首次调用 `ocr.read` 时下载到应用私有目录 `files/perception/ocr/`，不需要任何存储权限。只有 73 KB 的字典（识别模型 `inference.yml` 里的 `character_dict`，一行一个字符）随包放在 `assets/perception/ppocrv6_dict.txt`，因为它和模型版本绑定又很小。
- **地址**：先 `huggingface.co`，再 `hf-mirror.com`（同仓库同提交的公共镜像）。主人在国内网络，Hugging Face 不一定连得上，所以带镜像；**校验值使镜像不比原站更可信**：下载完大小和 sha-256 任何一项不符就丢掉，换下一个地址。
- **断点续传**：下载到 `<名字>-<sha前12位>.onnx.part`，用 `Range` 接着下；服务器不支持就重新下。校验通过才改名，所以带最终名字的文件一定是完整且校验过的。文件名里有校验值，换模型版本就是换文件，旧的下完新的后删掉。
- **空间**：下载前检查剩余空间（缺的字节数 + 64 MB），不够就报 `unavailable` 并说差多少。
- **一次一个下载**；整个等待上限 15 分钟，超时说「下得太久，下次调用会接着下」。
- **内存**：模型在第一次调用时才载入，90 秒没有调用就关掉会话放回内存。small 的三个模型共约 32 MB 权重；真机 ORT 工作内存与总峰值尚未测量。批次上限约束的是输入/输出张量，不能当作总内存上限。

## 4. 流程（`OcrPipeline.kt`）

三个网络藏在 `Net` 接口后面，流程里的其余部分是纯 Kotlin（不依赖 Android），所以能用桩网络做单元测试，也能用桌面 ORT 做端到端测试。

1. **解码**（Android 层）：`BitmapFactory`，长边超过 3200 就按 2 的幂降采样；按 EXIF 摆正；透明处垫白。文件上限 30 MB，`data` 上限约 10 MB。
2. **检测**：长边缩到 `max_side`（默认 960，范围 320–2048），两边取 32 的倍数，按固定 `inference.yml` 的 BGR 通道顺序和均值方差归一化，跑检测网络得概率图。旧实现错误地把 RGB 直接送给 det/rec；本轮同时校正。方向分类仍按官方 image-classification reader 的 RGB 顺序。
3. **后处理**（不用 OpenCV）：概率 > 0.2 的 4 邻域连通区域，区域内平均概率 ≥ 0.45 才保留，外接矩形按 Paddle 的 unclip 规则（距离 = 面积 × 1.4 / 周长）外扩，映射回原图像素。这些阈值取自检测模型 `inference.yml`。
4. **方向**：框高 ≥ 1.5 倍宽的先转 90°（Paddle 同样做法）；方向网络使用真实动态 batch，逐行判断是否倒置，倒置概率 > 0.9 才转 180°。
5. **识别**：按行宽分组，每组至多 8 行，批宽总和通常不超过 2048（单条超长行可到 3200）。一次只保留一组裁切图。行高缩到 48，宽按比例（16–3200），BGR 像素归一化到 [-1, 1]，右侧填归一化后的 0，补齐到 8 的倍数；CTC 逐行去重、去空白，只读有效宽对应的 `floor((width+3)/8)` 步，恢复原框顺序。该步数公式用非整齐宽度 17/20/21/28/29 的真实 ONNX 验证，不能用 `ceil(width/8)` 代替。18710 类包括 blank、18708 个字典字符和空格；行分数 = 保留字符的平均概率。
6. **整理**：分数低于 `min_score`（默认 0.5）的行丢掉；按高度重叠一半以上归为同一屏幕行，行内左到右、行间上到下；`text` 用换行分行。

**和 Paddle 自己的流程不同的地方（有意的）**：
- 框是正矩形，不是旋转多边形。截图和端正的文档照片够用；倾斜很大的照片，框会带进邻行的一部分。
- 识别按宽度分组，并限制批次内的最大/最小宽比，避免把短行都补到最长行。
- 方向只判行级的 0° / 180°，加「竖排转 90°」；不判整页方向。

**核实过的结果**：用同一算法的 Python 参考实现（`onnxruntime` + `scipy`）和 Kotlin 在桌面 ORT 上的端到端测试，都能把合成的中英混排截图读对（含 `¥ 1,284.50`、`Home-5G`、`87%`），倒置的行方向网络判为 180°。

**已知问题**：设置页那种分隔线，检测会给出一些低分（约 0.7）的宽框，识别返回空，被丢掉，但白白花了识别时间，约占总耗时的三分之一（43 个框里 13 个是空的）。没有为此加规则，见第 9 节。

## 5. 词的契约

### `ocr.read`（effect read，risk none，label「在识别图片里的字」）

输入（和任务书里 `{image, lang?}` 不同处见下）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `path` | string | 共享存储里的图片（`/sdcard/...`），和 `data` 二选一 |
| `data` | string | 图片 base64，约 10 MB 以内 |
| `max_side` | integer 320–2048 | 找字时图的长边，默认 960；小字多的大图调大 |
| `min_score` | number 0–1 | 行分数下限，默认 0.5 |

结果（`data` 部分；文字内容里先放识别出的纯文本）：

```
{ text, blocks: [{ text, box: [左, 上, 右, 下], score }], width, height, ms, detect_ms, recognize_ms, load_ms,
  prepare_ms, orientation_ms, inference_ms, decode_ms }
```

`box` 是原图像素。`ms` 是整个调用耗时（含载入模型，第一次含下载）。

`recognize_ms` 内部另给出行裁切/旋转/归一化、方向推理、识别推理/张量拷贝、CTC 解码四项，供相同图片的真机旧新对照。字段为各项累计毫秒，单独取整后不保证精确相加；不含 Android 图片解码和最终文字布局。

ORT 会话按第一次推理懒创建，因此初次图优化/载入也计入对应 detect / orientation / inference 项；`load_ms` 不能单独代表所有 ORT 权重已经载入的耗时。

**和任务书建议的不同，以及原因**：
- `image` 拆成 `path` / `data` 两个字段，和 `media.save` 一致；没有「附件」这一通道：链路上有 `resource` 内容类型，但手机端还没接，现有 media 词也是走共享存储路径，这里照做。
- 没有 `lang`：一个多语言模型（中、英、日和 46 种拉丁字母语言）一遍读完，选语言没有意义。
- 增加 `max_side`、`min_score` 两个调速度和精度的参数。

错误：`bad_request`（参数不对、不是图片）、`not_found`、`forbidden`（还没有存储权限，说明怎么向主人要）、`too_large`、`unavailable`（路径不在共享存储；模型下载不了；ORT 在这台手机上载不进来）、`timeout`。

### `tts.speak`（effect act，risk none，label「在念出文字」）

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string，必填 | 最多 4000 字 |
| `lang` | string | BCP 47，默认按文字判断：含假名 → ja-JP，含汉字 → zh-CN，否则 en-US |
| `voice` | string | 引擎的语音名；不认识时错误里列出该语言的语音名 |
| `rate` | number 0.25–4 | 默认 1 |
| `pitch` | number 0.5–2 | 默认 1 |
| `play` | boolean | 默认 true：手机上播出来，**念完才返回**；false：做成 WAV 文件 |

结果：`{ played, ms, duration_ms, lang, voice?, engine? }`；`play: false` 时另有 `path`（`/storage/emulated/0/Ash/tts/tts-<时间>.wav`，agent 可以在 `/sdcard/Ash/tts/` 看到）、`mime_type: audio/wav`、`bytes`。音频文件走共享存储，和 `camera.capture` 存照片同一做法；一天以前的旧文件在下次生成时顺手清掉。

错误：`unavailable`（没装朗读引擎、引擎起不来、没有这种语言的语音）、`forbidden`（`play: false` 但没有存储写入权限）、`too_large`（超过 4000 字）、`timeout`（引擎 20 秒 + 每字 0.3 秒内没念完）、`bad_request`（未知语音名）。

该词只在手机装有朗读引擎时才出现在手机的能力清单里（清单只列「此刻能用」的）。

## 6. TTS：系统引擎优先，兜底方案没做

**做了**：Android `TextToSpeech`，用手机默认引擎（ColorOS 自带的或主人装的）。零额外体积、不联网（离线与否取决于已装的语音包）。播放用 `USAGE_ASSISTANT` / `CONTENT_TYPE_SPEECH`。引擎绑定第一次用时建立，60 秒无调用释放。

**没做：离线开源兜底（sherpa-onnx 的中文语音）**。任务书说系统引擎不可用或中文质量不行时兜底；这需要在真机上才能判断「质量不行」，而这里没有 ColorOS 手机可以听，不该凭空决定要不要加 100 MB 以上的东西。取舍分析（**[推测]**）：

- sherpa-onnx 自带一份 `libonnxruntime.so`，和已有的 `onnxruntime-android` 同名冲突，要么 `pickFirst`（版本不一致有风险），要么改用同一版本的 sherpa 构建；
- 中文 VITS 模型（如 `vits-melo-tts-zh_en`）文本前端要词典和分词，模型加词典 100–200 MB，也得首次下载并校验，同 OCR 一样；
- 所以它是一个独立的后续工作，不是顺手能加的。代码上 `SystemTts` 与 `PerceptionCapabilities` 之间只通过 `play` / `render` 两个方法相连，兜底引擎可以作为第二个实现插进去。

真机验过之后：系统引擎有中文语音且听着可以 → 不需要兜底；否则按上面的路线做。

## 7. 测试

- 纯 Kotlin 单元测试（`android/app/src/test/java/ai/ash/caps/perception/`）：参数校验、图像缩放与旋转、检测后处理、CTC 解码、读取顺序、用桩网络跑整条流程（坐标映射、过滤、竖排转向、倒置转向）、模型下载（校验、换地址、续传、忽略 Range、旧版删除、超时）、WAV 时长、字典里的特殊字符（全角空格、增补平面字符）。
- 端到端（`OcrEndToEndTest`）：设 `ASH_OCR_MODELS` 指向含 `det/`、`rec/`、`ori/` 的文件夹（各含 `inference.onnx`）就在桌面 ORT 上用真模型跑一张合成截图并核对文字；没设就跳过。
- 现有的 `CapabilityConformanceTest` 把手机端声明和 SDK 标准词逐项对照，新词通过。

## 8. 失败时说什么

| 情况 | 错误码 | 对 agent 说的话（要点） |
|---|---|---|
| 路径不在共享存储 | `unavailable` | 只能打开 `/sdcard/...` 下的文件；放过去或用 `data` |
| 没有存储读写权限 | `forbidden` | 请主人允许，弹权限卡 `photos` |
| 模型没下好 | `unavailable` | 哪个文件、各地址的失败原因；检查手机在线、有约 100 MB 空间；下载会接着下 |
| 模型校验不符 | （同上，换地址后全失败） | 写「不符合校验值」 |
| ORT 在此手机载不进 | `unavailable` | 说明运行库问题 |
| 图解不出来 | `bad_request` | 说明不是 Android 能解的图片 |
| 图里没字 | 成功 | 文本是「No text found in the image」，`blocks` 为空 |
| 朗读引擎没有该语言 | `unavailable` | 引擎名 + 语言；到系统「文字转语音」装语音数据 |

## 9. 没验证的、没做的

**本轮 small 和 batch 尚未真机验证**（按任务书不动主人的手机）。桌面上的结果不能直接当手机上的结果：

- 以下是旧 medium 的历史桌面数据（新旧同图、生产 Kotlin 路径的重复基准见本轮 OCR 性能报告）：
  - 960×520 的简单截图：检测 0.67 s，识别 5 行 0.53 s；
  - 1080×2400 的密集设置页（43 个框，其中约 30 行真字），`max_side` 960：检测 0.45–0.65 s，识别 1.6 s，合计约 2.2 s；`max_side` 1280：检测约 1 s，识别 1.4 s。
  - **[推测]** 手机 arm64 核心比这台服务器每核慢 2–3 倍，所以一张密集截图大约 **3–6 秒**，简单画面 1–2.5 秒，第一次另加载入模型约 1 秒。这和「廉价高频」的预期有差距，真机量过再决定要不要优化。
- 本轮已实施 small 和真实宽度分组 batch，没有增加模型切换设置。官方整体识别准确率 medium 83.2%、small 81.3%，Screen 子集 82.5% / 79.7%；这不是零损失替换，不能用少量合成图推断全面准确率不变。tiny 的 Screen 为 71.2%，未作为默认。量化和跳过疑似分隔线未实施。
- 内存占用、ColorOS 上 ORT 是否正常载入：未测（安装包体积和 `.so` 的 16 KB 对齐已查，见第 2 节）。
- 网络：从主人手机所在网络下载 small 的约 32 MB 是否顺利（Hugging Face / 镜像），未测。
- TTS 全部未测：引擎是否存在、中文语音是否可用、`synthesizeToFile` 在 ColorOS 的引擎上是否写出 WAV、播放时是否被打断，都需要真机。
- 带 EXIF 旋转的照片、透明 PNG：写了处理，没有在手机上过。
- 已有的两个测试在本分支之前就失败（与本改动无关）：`CapabilityConformanceTest.anExtensionNamesItsOwnRisk`、`BrowserCapabilitiesTest.everyBrowserWordIsNamedByTheStandardAndTakesASpace`（期望的扩展词清单落后于 `clear_logins`、`health.scale.*`）；技能检查里 `phone-operation` 超 9000 字节、`devices` 介绍不止一段，以及系统提示词超长（本改动在 `media.md` 里加了一句，涨了 63 个字符）。

## 10. 真机上怎么验

1. 装包后让 Ash 或用命令行调 `device:<手机>` 的 `ocr.read`，参数 `{"path": "/sdcard/Pictures/Screenshots/<某张截图>.png"}`：
   - 第一次会下载模型，看 `load_ms` 和下载时间；
   - 之后同一张图再调，看 `ms`、`detect_ms`、`recognize_ms`。
2. 断网或用错误地址：确认错误信息可读，重新联网后接着下。
3. 对一张倒置的文档照片、一张竖排文字图各调一次，看方向处理。
4. `tts.speak {"text": "你好，我是 Ash。"}`：手机应当出声；`{"text": "...", "play": false}`：返回的 `path` 能在文件里看到，播放正常。再试 `{"text": "Hello", "lang": "en-US"}` 和一个引擎没有的语言，看错误。
5. 看 `adb shell dumpsys meminfo ai.ash.agent` 在识别时和 90 秒之后的占用。
