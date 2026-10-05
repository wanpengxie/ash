package ai.ash.host

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import ai.ash.R
import ai.ash.ui.HomeActivity
import ai.ash.ui.TaskCapsule
import org.json.JSONObject
import java.util.UUID

/** Authenticated host projection, independent of virtual displays and Shizuku. */
object TaskStatus {
    private val main = Handler(Looper.getMainLooper())
    private val model = TaskStatusModel()
    private var app: Context? = null
    private var stopping: String? = null
    private var notice: String? = null
    private var lastNotification: String? = null
    private const val CHANNEL = "ash.task"
    private const val ID = 7
    fun start(ctx: Context) { main.post { app = ctx.applicationContext; main.removeCallbacks(tick); tick.run() } }
    fun close() { main.post { main.removeCallbacks(tick); model.clear(); TaskCapsule.hide(); app?.getSystemService(NotificationManager::class.java)?.cancel(ID); app = null; lastNotification = null } }
    fun accept(ctx: Context, body: JSONObject): Boolean {
        val frame = try { TaskFrame.parse(body) } catch (_: Exception) { return false }
        main.post {
            if (app == null) return@post
            if (model.accept(frame, System.currentTimeMillis())) {
                if (stopping != frame.turn || !frame.canStop) stopping = null
                notice = null; render()
            }
        }
        return true
    }
    private val tick = object : Runnable {
        override fun run() { if (app != null) { render(); main.postDelayed(this, 1000) } }
    }
    private fun render() {
        val ctx = app ?: return
        val now = System.currentTimeMillis()
        val frame = model.frame
        if (!model.visible(now) || frame == null) {
            TaskCapsule.hide(); ctx.getSystemService(NotificationManager::class.java).cancel(ID); lastNotification = null; return
        }
        val title = if (model.stale(now)) "连接中断，状态待确认" else notice ?: frame.text.ifBlank { "在忙" }
        val text = "Ash · $title · ${(model.elapsed(now) / 5) * 5} 秒"
        val canStop = model.canStop(frame.turn!!, now) && stopping != frame.turn
        TaskCapsule.update(ctx, text, frame.steps, canStop, frame.turn, true)
        // Update at phase/turn changes, not every elapsed second. Notification works without overlay.
        val key = "${frame.turn}:$title:$canStop"
        if (!ctx.getSystemService(NotificationManager::class.java).areNotificationsEnabled()) lastNotification = null
        else if (key != lastNotification) {
            runCatching { notify(ctx, frame, title, canStop) }.onSuccess { lastNotification = key }
        }
    }
    private fun notify(ctx: Context, f: TaskFrame, title: String, canStop: Boolean) {
        val manager = ctx.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, "Ash 任务进度", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        val open = PendingIntent.getActivity(ctx, ID, Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        @Suppress("DEPRECATION") val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL) else Notification.Builder(ctx)
        b.setSmallIcon(R.drawable.ic_launcher).setContentTitle("Ash · $title").setContentText("点此回到 Ash 查看任务")
            .setContentIntent(open).setOnlyAlertOnce(true).setOngoing(f.canStop).setVisibility(Notification.VISIBILITY_PRIVATE)
        if (canStop) {
            val i = Intent(ctx, TaskStopReceiver::class.java).setData(Uri.Builder().scheme("ash").authority("task-stop").appendPath(f.turn).build())
            val stop = PendingIntent.getBroadcast(ctx, ID, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            b.addAction(Notification.Action.Builder(null, "停止本次任务", stop).build())
        }
        manager.notify(ID, b.build())
    }
    fun stop(turn: String, done: () -> Unit = {}) { main.post {
        val ctx = app
        if (ctx == null || !model.canStop(turn, System.currentTimeMillis()) || stopping == turn) { done(); return@post }
        stopping = turn; notice = "正在停止…"; render()
        Thread({
            val accepted = runCatching {
                val out = CoreClient(ctx).sendPresentAction(JSONObject().put("to", "service:reflex").put("kind", "request")
                    .put("word", "task.stop").put("body", JSONObject().put("turn", turn)).put("wait", true)
                    .put("client_id", UUID.randomUUID().toString()))
                val id = out.optString("id"); val reply = out.optJSONObject("reply")
                id.isNotBlank() && reply?.optString("reply_to") == id && reply.optString("from") == "service:reflex" &&
                    reply.optJSONObject("body")?.optBoolean("ok") == true && reply.optJSONObject("body")?.optJSONObject("result")?.optBoolean("cancelled") == true
            }.getOrDefault(false)
            main.post {
                if (model.frame?.turn == turn && model.frame?.canStop == true) {
                    stopping = null; notice = if (accepted) "停止请求已确认" else "未确认停止，请回 Ash 检查"; render()
                }
                done()
            }
        }, "ash-task-stop").start()
    } }
}

class TaskStopReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val uri = intent.data ?: return
        if (uri.scheme != "ash" || uri.host != "task-stop" || uri.pathSegments.size != 1) return
        val pending = goAsync()
        TaskStatus.stop(uri.pathSegments.single()) { pending.finish() }
    }
}
