package ai.ash.ui

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import ai.ash.host.shizuku.VScreenClient
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * A small floating window that shows the virtual screen live while it exists, so the owner can
 * watch what Ash does there. Frames are polled from the privileged server's "see" op (downscaled
 * JPEG, ~4 fps) on a worker thread; the window itself is only touched on the main thread.
 *
 * Draggable, pinch to resize, ✕ hides it (the virtual screen keeps running). Polling stops while
 * the window is hidden or the screen is off. If the server dies or the virtual screen goes away,
 * the window disappears. Nothing here may crash the app: every failure just hides the window.
 */
object VScreenPreview {
    private const val TAG = "ash.preview"
    private const val FRAME_MS = 250L
    private const val QUALITY = 60

    enum class Shown { OK, NO_SCREEN, NO_PERMISSION }

    private val main = Handler(Looper.getMainLooper())
    private val worker: Handler by lazy { Handler(HandlerThread("ash-vscreen-preview").apply { start() }.looper) }

    // Main-thread state.
    private var app: Context? = null
    private var root: FrameLayout? = null
    private var image: ImageView? = null
    private var lp: WindowManager.LayoutParams? = null
    private var screenReceiver: BroadcastReceiver? = null
    /** Window width in px (kept across hide/show); height follows the virtual screen's aspect. */
    private var widthPx = 0
    private var aspect = 16f / 9f

    /** Bumped to stop the current polling loop (hide, screen off). Read on the worker. */
    private val loop = AtomicInteger()
    @Volatile private var maxSide = 480

    /**
     * Shows the window if a virtual screen exists and ash may draw overlays. Safe from any thread;
     * the result is computed from state readable off the main thread.
     */
    fun show(ctx: Context): Shown {
        val c = ctx.applicationContext
        if (!VScreenClient.running()) return Shown.NO_SCREEN
        if (!canDraw(c)) return Shown.NO_PERMISSION
        main.post { safely { attach(c) } }
        return Shown.OK
    }

    /** Removes the window and stops polling (the virtual screen itself is untouched). Safe from any thread. */
    fun hide() {
        loop.incrementAndGet()
        main.post { safely { detach() } }
    }

    private fun canDraw(c: Context) = Build.VERSION.SDK_INT < 23 || try { Settings.canDrawOverlays(c) } catch (e: Throwable) { false }

    private inline fun safely(block: () -> Unit) {
        try { block() } catch (e: Throwable) {
            Log.w(TAG, "preview window failed", e)
            try { detach() } catch (_: Throwable) {}
        }
    }

    // ───────────────────────────── window (main thread) ─────────────────────────────

    @SuppressLint("ClickableViewAccessibility")
    private fun attach(c: Context) {
        if (root != null) return startLoop()
        if (!canDraw(c) || !VScreenClient.running()) return
        app = c
        val dm = c.resources.displayMetrics
        val density = dm.density
        fun dp(v: Int) = (v * density).toInt()
        if (widthPx == 0) widthPx = (minOf(dm.widthPixels, dm.heightPixels) * 0.3f).toInt()
        widthPx = clampWidth(c, widthPx)

        val img = ImageView(c).apply { scaleType = ImageView.ScaleType.FIT_XY; setBackgroundColor(Color.BLACK) }
        val label = TextView(c).apply {
            text = "Ash 虚拟屏"; textSize = 10f; setTextColor(Color.WHITE)
            setPadding(dp(6), dp(2), dp(6), dp(2))
            background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(0x80000000.toInt()) }
        }
        val close = TextView(c).apply {
            text = "✕"; textSize = 13f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x99000000.toInt()) }
            contentDescription = "隐藏虚拟屏预览"
            setOnClickListener { hide() }
        }
        val frame = FrameLayout(c).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat(); setColor(Color.BLACK); setStroke(dp(1), 0x66FFFFFF)
            }
            outlineProvider = ViewOutlineProvider.BACKGROUND
            clipToOutline = true
            elevation = dp(6).toFloat()
            addView(img, FrameLayout.LayoutParams(-1, -1))
            addView(label, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START).apply { setMargins(dp(4), dp(4), 0, 0) })
            addView(close, FrameLayout.LayoutParams(dp(24), dp(24), Gravity.TOP or Gravity.END).apply { setMargins(0, dp(4), dp(4), 0) })
        }

        @Suppress("DEPRECATION")
        val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
        val params = WindowManager.LayoutParams(
            widthPx, heightFor(widthPx), type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = dm.widthPixels - widthPx - dp(12)
            y = dp(72)
        }
        wm(c).addView(frame, params)
        root = frame; image = img; lp = params
        maxSide = maxOf(params.width, params.height).coerceIn(160, 720)
        frame.setOnTouchListener(DragResize(c))
        registerScreen(c)
        startLoop()
    }

    private fun detach() {
        loop.incrementAndGet()
        val c = app
        val r = root
        root = null; image = null; lp = null
        if (c != null) {
            screenReceiver?.let { try { c.unregisterReceiver(it) } catch (_: Throwable) {} }
            screenReceiver = null
            if (r != null) try { wm(c).removeViewImmediate(r) } catch (_: Throwable) {}
        }
    }

    private fun wm(c: Context) = c.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private fun heightFor(w: Int) = (w * aspect).toInt()

    private fun clampWidth(c: Context, w: Int): Int {
        val dm = c.resources.displayMetrics
        val min = (80 * dm.density).toInt()
        // Tall enough to fit on screen, never wider than most of the short side.
        val max = minOf((minOf(dm.widthPixels, dm.heightPixels) * 0.8f).toInt(), (dm.heightPixels * 0.8f / aspect).toInt())
        return w.coerceIn(min, maxOf(min, max))
    }

    /** Applies size/position changes, keeping the window on screen. */
    private fun relayout() {
        val c = app ?: return
        val r = root ?: return
        val p = lp ?: return
        val dm = c.resources.displayMetrics
        widthPx = clampWidth(c, widthPx)
        p.width = widthPx
        p.height = heightFor(widthPx)
        p.x = p.x.coerceIn(0, maxOf(0, dm.widthPixels - p.width))
        p.y = p.y.coerceIn(0, maxOf(0, dm.heightPixels - p.height))
        maxSide = (maxOf(p.width, p.height)).coerceIn(160, 720)
        try { wm(c).updateViewLayout(r, p) } catch (e: Throwable) { Log.w(TAG, "relayout", e) }
    }

    private fun onFrame(bmp: Bitmap) {
        val img = image ?: return
        val a = bmp.height.toFloat() / bmp.width
        img.setImageBitmap(bmp)
        if (kotlin.math.abs(a - aspect) > 0.01f) {
            aspect = a
            relayout()
        }
    }

    /** One finger drags, two fingers pinch to resize. */
    private class DragResize(c: Context) : View.OnTouchListener {
        private var downX = 0f
        private var downY = 0f
        private var startX = 0
        private var startY = 0
        private var dragging = false
        private var scaling = false
        private val scale = ScaleGestureDetector(c, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(d: ScaleGestureDetector): Boolean { scaling = true; return true }
            override fun onScale(d: ScaleGestureDetector): Boolean {
                widthPx = (widthPx * d.scaleFactor).toInt()
                relayout()
                return true
            }
        })

        override fun onTouch(v: View, e: MotionEvent): Boolean {
            val p = lp ?: return false
            scale.onTouchEvent(e)
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = p.x; startY = p.y
                    dragging = false; scaling = false
                }
                MotionEvent.ACTION_MOVE -> if (!scaling && e.pointerCount == 1) {
                    val dx = e.rawX - downX
                    val dy = e.rawY - downY
                    if (dragging || dx * dx + dy * dy > 64f) {
                        dragging = true
                        p.x = startX + dx.toInt(); p.y = startY + dy.toInt()
                        relayout()
                    }
                }
                MotionEvent.ACTION_POINTER_UP -> {
                    // Re-anchor the drag after a pinch so the window does not jump.
                    val rest = if (e.actionIndex == 0) 1 else 0
                    downX = e.getRawXCompat(rest); downY = e.getRawYCompat(rest); startX = p.x; startY = p.y
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { dragging = false; scaling = false }
            }
            return true
        }

        private fun MotionEvent.getRawXCompat(i: Int) = if (Build.VERSION.SDK_INT >= 29) getRawX(i) else rawX - getX(0) + getX(i)
        private fun MotionEvent.getRawYCompat(i: Int) = if (Build.VERSION.SDK_INT >= 29) getRawY(i) else rawY - getY(0) + getY(i)
    }

    /** Screen off → stop polling; screen on → resume (while the window is shown). */
    private fun registerScreen(c: Context) {
        if (screenReceiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                if (intent.action == Intent.ACTION_SCREEN_OFF) loop.incrementAndGet() else if (root != null) startLoop()
            }
        }
        c.registerReceiver(r, IntentFilter().apply { addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_SCREEN_ON) })
        screenReceiver = r
    }

    // ───────────────────────────── frames (worker thread) ─────────────────────────────

    private fun startLoop() {
        val c = app ?: return
        val gen = loop.incrementAndGet()
        worker.post { poll(c, gen, 0) }
    }

    private fun poll(c: Context, gen: Int, failures: Int) {
        if (gen != loop.get()) return
        val interactive = try { (c.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive } catch (e: Throwable) { true }
        if (!interactive) return // the SCREEN_ON receiver starts a new loop
        val t0 = SystemClock.uptimeMillis()
        var fails = failures
        try {
            val r = VScreenClient.call(c, "see", JSONObject().put("maxSide", maxSide).put("quality", QUALITY), 5000, start = false)
            if (gen != loop.get()) return
            if (r.optBoolean("ok")) {
                val bytes = Base64.decode(r.optString("jpeg"), Base64.DEFAULT)
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (bmp != null) main.post { if (gen == loop.get()) safely { onFrame(bmp) } }
                fails = 0
            } else {
                val err = r.optString("error")
                // Server gone or virtual screen closed: the preview has nothing left to show.
                if (!VScreenClient.running() || err.startsWith("no virtual screen")) {
                    Log.i(TAG, "virtual screen gone, hiding preview: $err")
                    if (gen == loop.get()) hide()
                    return
                }
                fails++ // e.g. no frame rendered yet, or a slow answer: keep trying, slower
            }
        } catch (e: Throwable) {
            Log.w(TAG, "frame", e)
            fails++
        }
        val delay = if (fails == 0) maxOf(0L, FRAME_MS - (SystemClock.uptimeMillis() - t0)) else minOf(2000L, FRAME_MS * (fails + 1))
        worker.postDelayed({ poll(c, gen, fails) }, delay)
    }
}
