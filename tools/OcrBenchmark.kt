package ai.ash.caps.perception

import ai.onnxruntime.OrtEnvironment
import org.json.JSONArray
import org.json.JSONObject
import java.awt.Color
import java.awt.Font
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO

// These are independent authored ground truths, never obtained from either OCR result.
private val groundTruth = listOf(
    "设置 Settings", "WLAN 已连接 Home-5G", "电量 Battery 87%", "剩余约14小时20分钟", "发票金额 ¥ 1,284.50",
    "订单 Order A20261016", "日期 2026-10-16 09:41", "验证码 037918", "网络速度 128.5 Mbps", "存储空间 256 GB",
    "通知 Notifications", "蓝牙 Bluetooth 已开启", "亮度 Brightness 65%", "声音 Sound 50%", "字体大小 Standard",
    "联系人 Alice 张三", "会议 Meeting 10:30", "待办任务 24 / 30", "温度 26.5°C", "支付成功 Payment OK",
    "账号 user@example.com", "设备 Pixel Test 123", "英文 The quick brown fox", "数字 0123456789", "安全与隐私 Privacy",
    "下载完成 Download 100%", "系统版本 Android 15", "中文测试 你好世界", "网址 example.com/ocr", "结束 End 2026",
)

private data class Fixture(val name: String, val image: RgbImage, val expected: List<String>, val centers: List<Int>)
private fun rgb(b: BufferedImage) = RgbImage(b.width, b.height, b.getRGB(0, 0, b.width, b.height, null, 0, b.width))
private fun fixture(n: Int, inverted: Boolean = false, dark: Boolean = false, texts: List<String> = groundTruth.take(n), suffix: String = ""): Fixture {
    val b = BufferedImage(1080, 2400, BufferedImage.TYPE_INT_RGB)
    val g = b.createGraphics()
    g.color = if (dark) Color(28, 31, 36) else Color.WHITE; g.fillRect(0, 0, b.width, b.height)
    g.font = Font.createFont(Font.TRUETYPE_FONT, File("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")).deriveFont(36f)
    g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
    g.color = if (dark) Color(230, 235, 245) else Color(26, 30, 34)
    for (i in 0 until n) {
        if (inverted && i % 3 == 1) {
            g.rotate(Math.PI, 540.0, (84 + i * 72).toDouble())
            g.drawString(texts[i], 48, 96 + i * 72)
            g.rotate(-Math.PI, 540.0, (84 + i * 72).toDouble())
        } else g.drawString(texts[i], 48, 96 + i * 72)
    }
    g.dispose()
    return Fixture("${n}${if (inverted) "-inverted" else ""}${if (dark) "-dark" else ""}$suffix", rgb(b), texts, (0 until n).map { 82 + it * 72 })
}

private fun normalized(s: String) = s.filterNot { it.isWhitespace() }
private fun distance(a: String, b: String): Int {
    var prev = IntArray(b.length + 1) { it }
    for (i in a.indices) {
        val cur = IntArray(b.length + 1); cur[0] = i + 1
        for (j in b.indices) cur[j + 1] = minOf(cur[j] + 1, prev[j + 1] + 1, prev[j] + if (a[i] == b[j]) 0 else 1)
        prev = cur
    }
    return prev.last()
}

private class Observed(private val net: OrtNet) : Net {
    val shapes = mutableSetOf<List<Long>>()
    override fun run(input: Tensor): Tensor { shapes += input.shape.toList(); return net.run(input) }
}

fun main(args: Array<String>) {
    val cache = File(args.getOrElse(0) { "/tmp/ash-ocr-fast-models" })
    val output = File(args.getOrElse(1) { "/tmp/ash-ocr-fast-benchmark/results.json" })
    val repeats = args.getOrElse(2) { "9" }.toInt()
    val filter = args.getOrNull(3)
    val fixtureFilter = args.getOrNull(4)
    val coldRepeats = System.getenv("ASH_OCR_BENCH_COLD_REPEATS")?.toInt() ?: 1
    val xnnpack = System.getenv("ASH_OCR_BENCH_PROVIDER") == "xnnpack"
    val env = OrtEnvironment.getEnvironment()
    println("ORT ${env.version}, providers ${OrtEnvironment.getAvailableProviders()}")
    val fixtures = (listOf(0, 1, 5, 10, 20, 24, 30).map { fixture(it) } + fixture(24, inverted = true) + fixture(24, dark = true) + fixture(8, texts = listOf(
        "繁體中文 臺灣 香港 龍門", "姓名 生僻字 甄嬛 龘靐", "单号 S/N ASH-O0I1l-5086", "金额 CNY 0.01 USD 999.90", "发货地址 上海市浦东新区", "日本語 テスト 東京 2026", "Symbols @#& + = / 50%", "编号 000001 123456 987654",
    ), suffix = "-accuracy")).filter { fixtureFilter == null || it.name == fixtureFilter }
    output.parentFile.mkdirs()
    for (f in fixtures) {
        val b = BufferedImage(f.image.width, f.image.height, BufferedImage.TYPE_INT_RGB)
        b.setRGB(0, 0, b.width, b.height, f.image.pixels, 0, b.width)
        ImageIO.write(b, "png", File(output.parentFile, "fixture-${f.name}.png"))
    }
    data class Config(val tier: String, val batch: Int, val threads: Int) { val name get() = "$tier-b$batch-t$threads" }
    val configs = listOf(Config("medium", 1, 4), Config("medium", 8, 4), Config("small", 1, 4), Config("small", 8, 1), Config("small", 8, 2), Config("small", 8, 3), Config("small", 8, 4), Config("tiny", 8, 4)).filter { filter == null || filter.split(',').any { part -> it.name.contains(part) } }
    val records = JSONArray()
    val all = JSONObject().put("runtime", env.version).put("providers", OrtEnvironment.getAvailableProviders().map { it.toString() }).put("arch", System.getProperty("os.arch")).put("cpuThreads", Runtime.getRuntime().availableProcessors()).put("estimatedThreads", OcrCpu.threads()).put("repeats", repeats).put("coldRepeats", coldRepeats).put("groundTruth", groundTruth).put("runs", records)
    all.put("requestedProvider", if (xnnpack) "XNNPACK (CPU fallback if unavailable)" else "CPU")
    for (c in configs) {
        for (f in fixtures) {
          for (coldRound in 0 until coldRepeats) {
            val nets = listOf("det", "ori", "rec").map { kind -> OrtNet(env, File(cache, if (kind == "ori") "shared/ori/inference.onnx" else "${c.tier}/$kind/inference.onnx"), c.threads, xnnpack) }
            try {
                val observed = nets.map { Observed(it) }
                val chars = File(cache, "${c.tier}/dictionary.txt").readText().removeSuffix("\n").split('\n')
                val p = OcrPipeline(observed[0], observed[1], observed[2], chars, c.batch, if (c.tier == "tiny") 0.4f else 0.45f, legacyRgb = c.tier == "medium" && c.batch == 1)
                for (iteration in -2 until (if (coldRepeats > 1) -1 else repeats)) {
                    val start = System.nanoTime()
                    val result = p.read(f.image)
                    val elapsed = (System.nanoTime() - start) / 1e6
                    // -2 is the first call with three fresh sessions; -1 is a separate warmup call.
                    val text = normalized(result.text)
                    val expected = normalized(f.expected.joinToString("\n"))
                    val missing = f.centers.count { cy -> result.blocks.none { kotlin.math.abs((it.box[1] + it.box[3]) / 2 - cy) < 34 } }
                    val row = JSONObject().put("config", c.name).put("fixture", f.name).put("lines", f.expected.size).put("iteration", iteration).put("totalMs", elapsed).put("detectMs", result.detectMs).put("recognizeMs", result.recognizeMs)
                        .put("prepareMs", result.timings.prepareNs / 1e6).put("orientationMs", result.timings.orientationNs / 1e6).put("inferenceMs", result.timings.inferenceNs / 1e6).put("decodeMs", result.timings.decodeNs / 1e6)
                        .put("editDistance", distance(expected, text)).put("expectedCharacters", expected.length).put("missingLines", missing).put("blocks", result.blocks.size).put("text", result.text)
                    row.put("expectedText", f.expected.joinToString("\n"))
                    row.put("coldRound", coldRound)
                    records.put(row)
                }
                all.put("lastRecognitionShapes", observed[2].shapes.map { it.toString() })
                output.writeText(all.toString(2))
                println("${c.name} ${f.name}: ${records.getJSONObject(records.length() - 1).getDouble("totalMs")} ms; batches ${observed[2].shapes}")
            } finally { nets.forEach { it.close() } }
          }
        }
    }
    // Existing hand-authored sample, independent of generated fixtures.
    val sample = rgb(ImageIO.read(File("android/app/src/test/resources/ai/ash/caps/perception/ocr-sample.png")))
    val sampleRows = JSONArray()
    for (tier in listOf("medium", "small", "tiny")) {
        val nets = listOf("det", "ori", "rec").map { k -> OrtNet(env, File(cache, if (k == "ori") "shared/ori/inference.onnx" else "$tier/$k/inference.onnx"), 4) }
        try {
            val chars = File(cache, "$tier/dictionary.txt").readText().removeSuffix("\n").split('\n')
            val r = OcrPipeline(nets[0], nets[1], nets[2], chars, if (tier == "medium") 1 else 8, if (tier == "tiny") 0.4f else 0.45f, legacyRgb = tier == "medium").read(sample)
            sampleRows.put(JSONObject().put("tier", tier).put("text", r.text).put("blocks", r.blocks.size))
        } finally { nets.forEach { it.close() } }
    }
    all.put("existingSample", sampleRows)
    output.writeText(all.toString(2))
}
