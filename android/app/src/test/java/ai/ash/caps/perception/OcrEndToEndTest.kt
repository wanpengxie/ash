package ai.ash.caps.perception

import ai.onnxruntime.OrtEnvironment
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * The reader run for real on the desktop ONNX Runtime, when the three models are at hand: set ASH_OCR_MODELS to a folder with
 * det/, rec/ and ori/ each holding the model's inference.onnx (the files OcrModels names). Skipped otherwise; the models are
 * 140 MB and not in the repository.
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
}
