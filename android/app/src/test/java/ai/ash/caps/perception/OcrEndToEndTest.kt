package ai.ash.caps.perception

import ai.onnxruntime.OrtEnvironment
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * The reader run for real on the desktop ONNX Runtime, when the three models are at hand: set ASH_OCR_MODELS to a folder with
 * det/, rec/ and ori/ each holding the model's inference.onnx (the files OcrModels names). Skipped otherwise; the models are
 * not in the repository. Production small detector/recognizer plus the shared orientation model are about 32 MB.
 */
class OcrEndToEndTest {
    private val models = System.getenv("ASH_OCR_MODELS")?.let { File(it) }

    /** The sample picture through the desktop's ImageIO (reached by reflection: the unit-test compile classpath is Android's, which has no javax.imageio). */
    private fun sample(): RgbImage {
        val imageIo = Class.forName("javax.imageio.ImageIO")
        val png = imageIo.getMethod("read", java.io.InputStream::class.java).invoke(null, javaClass.getResourceAsStream("/ai/ash/caps/perception/ocr-sample.png"))!!
        val cls = png.javaClass
        val w = cls.getMethod("getWidth").invoke(png) as Int
        val h = cls.getMethod("getHeight").invoke(png) as Int
        val px = IntArray(w * h)
        cls.getMethod("getRGB", Int::class.java, Int::class.java, Int::class.java, Int::class.java, IntArray::class.java, Int::class.java, Int::class.java).invoke(png, 0, 0, w, h, px, 0, w)
        return RgbImage(w, h, px)
    }

    @Test fun aScreenshotIsReadInChineseAndEnglish() {
        assumeTrue("ASH_OCR_MODELS is not set", models != null && File(models, "det/inference.onnx").isFile)
        val env = OrtEnvironment.getEnvironment()
        val nets = listOf("det", "ori", "rec").map { OrtNet(env, File(models, "$it/inference.onnx"), 4) }
        try {
            val dictionary = File("src/main/assets/${OcrModels.DICTIONARY_ASSET}").readText(Charsets.UTF_8)
            val image = sample()
            val pipeline = OcrPipeline(nets[0], nets[1], nets[2], OcrModels.parseDictionary(dictionary))
            val first = pipeline.read(image)
            val second = pipeline.read(image)
            println("ocr: detect ${second.detectMs} ms, recognize ${second.recognizeMs} ms (first run ${first.detectMs + first.recognizeMs} ms)\n${second.text}")
            val text = second.text.replace(" ", "")
            for (want in listOf("设置", "WLAN已连接", "Home-5G", "Battery87%", "剩余约14小时20分钟", "Thequickbrownfox", "lazydog", "发票金额", "1,284.50"))
                assertTrue("missing '$want' in:\n${second.text}", text.contains(want))
            assertTrue(second.blocks.size == 5)
        } finally {
            nets.forEach { it.close() }
        }
    }

    @Test fun actualOnnxPreservesTwoRowsAndUpsideDownText() {
        assumeTrue("ASH_OCR_MODELS is not set", models != null && File(models, "rec/inference.onnx").isFile)
        val env = OrtEnvironment.getEnvironment()
        val ori = OrtNet(env, File(models, "ori/inference.onnx"), 2)
        val rec = OrtNet(env, File(models, "rec/inference.onnx"), 2)
        var largestBatch = 0L
        val observed = object : Net {
            override fun run(input: Tensor): Tensor {
                largestBatch = maxOf(largestBatch, input.shape[0])
                return rec.run(input).also { assertEquals(input.shape[0], it.shape[0]) }
            }
        }
        val noDetector = object : Net { override fun run(input: Tensor): Tensor = error("recognition-only test") }
        try {
            val chars = OcrModels.parseDictionary(File("src/main/assets/${OcrModels.DICTIONARY_ASSET}").readText())
            val line = sample().crop(20, 210, 700, 285)
            val upsideDown = line.rotated(2)
            val pixels = line.pixels + upsideDown.pixels
            val image = RgbImage(line.width, line.height * 2, pixels)
            val boxes = listOf(OcrPipeline.Found(intArrayOf(0, 0, line.width, line.height), 1f), OcrPipeline.Found(intArrayOf(0, line.height, line.width, line.height * 2), 1f))
            val result = OcrPipeline(noDetector, ori, observed, chars).recognizeAll(image, boxes)
            assertEquals(2L, largestBatch)
            assertEquals(result[0].first, result[1].first)
            assertTrue(result[0].first.contains("Battery"))
            assertTrue(result[0].first.contains("87%"))
        } finally { ori.close(); rec.close() }
    }

    @Test fun unavailableXnnpackUsesCpuWithoutLosingBatchSupport() {
        assumeTrue("ASH_OCR_MODELS is not set", models != null && File(models, "ori/inference.onnx").isFile)
        assumeTrue("this check exercises an unavailable provider", OrtEnvironment.getAvailableProviders().none { it.toString().contains("XNN", ignoreCase = true) })
        val net = OrtNet(OrtEnvironment.getEnvironment(), File(models, "ori/inference.onnx"), 2, xnnpack = true)
        try {
            val output = net.run(Tensor(FloatArray(2 * 3 * 80 * 160), longArrayOf(2, 3, 80, 160)))
            assertTrue(output.shape.contentEquals(longArrayOf(2, 2)))
        } finally { net.close() }
    }

    @Test fun realOnnxTimeStepsMatchNonAlignedValidWidths() {
        assumeTrue("ASH_OCR_MODELS is not set", models != null && File(models, "rec/inference.onnx").isFile)
        val net = OrtNet(OrtEnvironment.getEnvironment(), File(models, "rec/inference.onnx"), 2)
        try {
            for (width in listOf(17, 20, 21, 28, 29)) {
                val output = net.run(Tensor(FloatArray(2 * 3 * 48 * width), longArrayOf(2, 3, 48, width.toLong())))
                assertEquals(2L, output.shape[0])
                assertEquals(OcrPipeline.recognitionSteps(width).toLong(), output.shape[1])
            }
        } finally { net.close() }
    }
}
