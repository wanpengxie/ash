package ai.ash.caps.perception

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import java.io.File
import java.nio.FloatBuffer

/** Lazy session shared by Android and the desktop benchmark. XNNPACK is opt-in for measurement, not enabled in the app. */
class OrtNet(private val env: OrtEnvironment, private val file: File, private val threads: Int, private val xnnpack: Boolean = false) : Net, AutoCloseable {
    private var session: OrtSession? = null

    private fun open(useXnnpack: Boolean): OrtSession = OrtSession.SessionOptions().use { o ->
        o.setIntraOpNumThreads(if (useXnnpack) 1 else threads)
        o.setMemoryPatternOptimization(false)
        if (useXnnpack) {
            o.addConfigEntry("session.intra_op.allow_spinning", "0")
            o.addXnnpack(mapOf("intra_op_num_threads" to threads.toString()))
        }
        env.createSession(file.path, o)
    }

    @Synchronized override fun run(input: Tensor): Tensor {
        val s = session ?: (if (xnnpack) try { open(true) } catch (_: OrtException) { open(false) } else open(false)).also { session = it }
        OnnxTensor.createTensor(env, FloatBuffer.wrap(input.data), input.shape).use { tensor ->
            s.run(mapOf(s.inputNames.first() to tensor)).use { result ->
                val out = result.get(0) as OnnxTensor
                val buffer = out.floatBuffer
                val data = FloatArray(buffer.remaining())
                buffer.get(data)
                return Tensor(data, out.info.shape)
            }
        }
    }

    @Synchronized override fun close() {
        session?.close()
        session = null
    }
}
