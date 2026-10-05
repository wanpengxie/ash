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
    fun start(ctx: Context) { main.post { app = ctx.applicationContext; TaskCapsule.prewarm(ctx); main.removeCallbacks(tick); tick.run() } }
    fun close() { main.post { main.removeCallbacks(tick); model.clear(); TaskCapsule.release(); app?.getSystemService(NotificationManager::class.java)?.cancel(ID); app = null; lastNotification = null } }
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
        if (!model.active() || frame == null) {
            TaskCapsule.hide(); ctx.getSystemService(NotificationManager::class.java).cancel(ID); lastNotification = null; return
        }
        val title = if (model.stale(now)) "连接中断，状态待确认" else notice ?: frame.text.ifBlank { "在忙" }
        val canStop = model.canStop(frame.turn!!, now) && stopping != frame.turn
        if (model.dismissed) TaskCapsule.hide()
        else TaskCapsule.update(ctx, frame, model.elapsed(now), model.stale(now), stopping == null, canStop, notice)
        // A running turn is shown once: on the island, or, when the island is closed (or may not be drawn), as this
        // notification. What the turn says or asks reaches the owner through Ash's delivery, which notifies only when
        // the island is not on screen (Ash asks the phone at that moment).
        val manager = ctx.getSystemService(NotificationManager::class.java)
        val islandOpen = !model.dismissed && android.provider.Settings.canDrawOverlays(ctx)
        if (islandOpen || frame.state in setOf("done", "waiting_you") || !manager.areNotificationsEnabled()) {
            if (lastNotification != null) { manager.cancel(ID); lastNotification = null }
            return
        }
        // Update at phase/turn changes, not every elapsed second.
        val key = "${frame.turn}:$title:$canStop:${frame.state}"
        if (key != lastNotification) runCatching { notify(ctx, frame, title, canStop) }.onSuccess { lastNotification = key }
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
    /** Closes the island for the rest of this turn; from then on Ash notifies instead. */
    fun dismiss(turn: String) { main.post {
        if (!model.dismiss(turn)) return@post
        TaskCapsule.hide(); render()
    } }
    /** Explicit end, not a UI-only dismissal: withdraw pending actions before stopping this exact turn. */
    fun end(turn: String) { main.post {
        val ctx = app ?: return@post
        val frame = model.frame ?: return@post
        if (frame.turn != turn || stopping != null || model.stale(System.currentTimeMillis()) ||
            ctx.getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked) return@post
        stopping = turn; notice = "正在结束…"; render()
        val ids = frame.cards.filter { it.state == "waiting" || it.kind == "approval" && it.state == "answered" }.map { it.pendingId }.distinct()
        Thread({
            val accepted = runCatching {
                val out = CoreClient(ctx).sendPresentAction(JSONObject().put("to", "service:reflex").put("kind", "request")
                    .put("word", "task.end").put("body", JSONObject().put("turn", turn).put("pending_ids", org.json.JSONArray(ids)))
                    .put("wait", true).put("client_id", "capsule-end:${frame.session}:$turn"))
                val reply = out.optJSONObject("reply")
                reply?.optString("reply_to") == out.optString("id") && reply?.optJSONObject("body")?.optBoolean("ok") == true &&
                    reply.optJSONObject("body")?.optJSONObject("result")?.optBoolean("ended") == true
            }.getOrDefault(false)
            main.post {
                stopping = null
                if (model.frame?.turn == turn) {
                    if (accepted) dismiss(turn) else { notice = "结束未确认，请重试或回 Ash 检查"; render() }
                }
            }
        }, "ash-capsule-end").start()
    } }
    /** Exact ask response. Persist the chosen answer before transport, so retries cannot become a different approval. */
    fun answerCard(id: String, choice: String, text: String? = null, done: (Boolean, String) -> Unit) { main.post {
        val ctx = app
        val card = model.frame?.cards?.find { it.id == id }
        if (ctx == null || card == null || model.stale(System.currentTimeMillis()) ||
            ctx.getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked) {
            done(false, "状态不可用，请回 Ash 核对"); return@post
        }
        val route = runCatching {
            if (card.kind == "question") PresentRoutes.question(card.id, card.target, card.options.map { it.first }.toSet(), choice, text,
                card.allowCustom, card.expiresAt, System.currentTimeMillis())
            else PresentRoutes.approval(card.id, card.target, card.options.map { it.first }.toSet(), choice, card.expiresAt, System.currentTimeMillis())
        }.getOrNull()
        if (route == null || card.state != "waiting") { done(false, "此请求已处理或已过期"); return@post }
        val prefs = ctx.getSharedPreferences("ash_capsule_answers", Context.MODE_PRIVATE)
        val result = JSONObject().put("choice", choice).apply { if (route.text != null) put("text", route.text) }
        val value = result.toString()
        val prior = prefs.getString(id, null)
        if (prior != null && prior != value) { done(false, "已有答复发送中，请回 Ash 核对"); return@post }
        if (!prefs.edit().putString(id, value).commit()) { done(false, "无法保存答复，请重试"); return@post }
        Thread({
            val ok = runCatching {
                CoreClient(ctx).sendPresentAction(JSONObject().put("to", route.to).put("kind", "response").put("word", "ask")
                    .put("reply_to", id).put("body", JSONObject().put("ok", true).put("result", result))
                    .put("client_id", "capsule-answer:$id")).optString("id").isNotBlank()
            }.getOrDefault(false)
            main.post { done(ok, if (ok) { if (choice == "deny") "已拒绝" else if (card.kind == "question") "已回答" else "已批准，等待继续" } else "答复未确认，可原样重试") }
        }, "ash-capsule-answer").start()
    } }
    /** Same authenticated phone-owner path as notification replies; stable client id makes retries safe. */
    fun sendInput(text: String, clientId: String, done: (Boolean, String) -> Unit) { main.post {
        val ctx = app
        if (ctx == null || text.isBlank() || text.length > 4000 || ctx.getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked) {
            done(false, "暂时不能发送，请解锁后重试"); return@post
        }
        Thread({
            val accepted = runCatching {
                val response = CoreClient(ctx).sendPresentAction(JSONObject().put("to", "agent:main").put("kind", "request")
                    .put("word", "say").put("body", JSONObject().put("text", text)).put("wait", false).put("client_id", clientId))
                response.optString("id").isNotBlank()
            }.getOrDefault(false)
            main.post { done(accepted, if (accepted) "已发送给 Ash" else "发送未确认，点发送可重试") }
        }, "ash-capsule-input").start()
    } }
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
