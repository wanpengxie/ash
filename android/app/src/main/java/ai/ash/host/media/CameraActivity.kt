package ai.ash.host.media

import ai.ash.host.Notifications
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.provider.MediaStore
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** One photo Ash asked the owner for: the capability waits on it while [CameraActivity] runs the system camera. */
class CameraRequest(val id: String, val file: File) {
    sealed class Outcome {
        object Taken : Outcome()
        object Cancelled : Outcome()
        class Failed(val message: String) : Outcome()
    }

    private val opened = CountDownLatch(1)
    private val finished = CountDownLatch(1)
    @Volatile var outcome: Outcome? = null
        private set

    fun open() = opened.countDown()
    fun awaitOpen(ms: Long) = opened.await(ms, TimeUnit.MILLISECONDS)
    fun finish(o: Outcome) { if (outcome == null) { outcome = o; finished.countDown() } }
    fun awaitFinish(ms: Long) = finished.await(ms, TimeUnit.MILLISECONDS)
}

object CameraRequests {
    private val pending = ConcurrentHashMap<String, CameraRequest>()

    fun create(file: File): CameraRequest = CameraRequest(UUID.randomUUID().toString(), file).also { pending[it.id] = it }
    fun get(id: String?): CameraRequest? = id?.let { pending[it] }
    fun drop(r: CameraRequest) { pending.remove(r.id); r.finish(CameraRequest.Outcome.Cancelled) }
}

/**
 * The system camera for camera.capture. Android forbids taking pictures from the background, so the owner takes the
 * photo with the phone's own camera app; this see-through screen only opens it and hands the result back.
 */
class CameraActivity : Activity() {
    private var request: CameraRequest? = null
    private var launched = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        Notifications.hideCameraHandoff(this)
        val r = CameraRequests.get(intent.getStringExtra(EXTRA_ID))
        if (r == null || r.outcome != null) { finish(); return }
        request = r
        r.open()
        if (state?.getBoolean(KEY_LAUNCHED) == true) { launched = true; return } // recreated while the camera was up: its result still comes here
        val uri = CaptureProvider.uriFor(this, r.file)
        val capture = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        capture.clipData = ClipData.newRawUri("photo", uri)
        try {
            @Suppress("DEPRECATION") startActivityForResult(capture, REQ_CAPTURE)
            launched = true
        } catch (e: ActivityNotFoundException) {
            r.finish(CameraRequest.Outcome.Failed("the phone has no camera app that can take a photo for another app"))
            finish()
        } catch (e: SecurityException) {
            r.finish(CameraRequest.Outcome.Failed("the camera app refused: ${e.message}"))
            finish()
        }
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        out.putBoolean(KEY_LAUNCHED, launched)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQ_CAPTURE) return super.onActivityResult(requestCode, resultCode, data)
        val r = request ?: return finish()
        if (resultCode == RESULT_OK && r.file.length() == 0L) {
            // A camera app that ignored the output file may still hand back a small preview.
            @Suppress("DEPRECATION") val thumb = data?.extras?.get("data") as? Bitmap
            if (thumb != null) runCatching { r.file.outputStream().use { thumb.compress(Bitmap.CompressFormat.JPEG, 92, it) } }
        }
        r.finish(if (resultCode == RESULT_OK && r.file.length() > 0) CameraRequest.Outcome.Taken else CameraRequest.Outcome.Cancelled)
        finish()
    }

    override fun onDestroy() {
        // Gone for good without a result (the owner backed out): nobody should keep waiting.
        if (isFinishing) request?.finish(CameraRequest.Outcome.Cancelled)
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ID = "ai.ash.camera.id"
        private const val KEY_LAUNCHED = "launched"
        private const val REQ_CAPTURE = 7201
    }
}
