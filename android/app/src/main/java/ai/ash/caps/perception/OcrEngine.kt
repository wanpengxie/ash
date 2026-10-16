package ai.ash.caps.perception

import ai.onnxruntime.OrtEnvironment
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * The reader on the phone: the three models loaded when a call needs them (downloaded first if they are not on the phone yet),
 * one image at a time, and let go of again after [IDLE_MS] without a call to release their native working memory.
 */
class OcrEngine(private val filesDir: File, private val dictionary: () -> String, private val store: ModelStore = ModelStore(OcrModels.dir(filesDir))) {
    private var nets: List<OrtNet> = emptyList()
    private var pipeline: OcrPipeline? = null
    private var release: ScheduledFuture<*>? = null

    /** Reads [image]; returns the result and how long loading the models took, in ms (0 when they were loaded). */
    @Synchronized fun read(image: RgbImage, maxSide: Int, minScore: Float, deadlineMs: Long = 15 * 60_000L): Pair<OcrResult, Long> {
        release?.cancel(false)
        val t0 = System.nanoTime()
        val p = pipeline ?: load(deadlineMs).also { pipeline = it }
        val loadMs = (System.nanoTime() - t0) / 1_000_000
        try {
            return p.read(image, maxSide, minScore) to loadMs
        } finally {
            release = idle.schedule({ release() }, IDLE_MS, TimeUnit.MILLISECONDS)
        }
    }

    fun ready(): Boolean = store.has(OcrModels.ALL)

    @Synchronized fun release() {
        nets.forEach { runCatching { it.close() } }
        nets = emptyList()
        pipeline = null
    }

    private fun load(deadlineMs: Long): OcrPipeline {
        val files = store.ensure(OcrModels.ALL, deadlineMs)
        val env = OrtEnvironment.getEnvironment()
        val threads = OcrCpu.threads()
        val det = OrtNet(env, files.getValue(OcrModels.DET.name), threads)
        val ori = OrtNet(env, files.getValue(OcrModels.ORI.name), threads)
        val rec = OrtNet(env, files.getValue(OcrModels.REC.name), threads)
        nets = listOf(det, ori, rec)
        return OcrPipeline(det, ori, rec, OcrModels.parseDictionary(dictionary()))
    }

    companion object {
        const val IDLE_MS = 90_000L
        private val idle = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "ocr-idle").apply { isDaemon = true } }
    }
}
