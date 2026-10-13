package ai.ash.ui

import android.util.Base64
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

/** One image, delivered through material transfer before the native input operation. */
internal class CoworkerImage(
    private val env: HomeEnv, private val work: JSONObject, private val scope: String,
    private val binding: String, private val alive: () -> Boolean, private val notice: (String) -> Unit,
    private val accepted: () -> Unit,
    private val selected: (String?, String?) -> Unit,
) {
    private val prefs = env.activity.getSharedPreferences("ash.coworker", 0)
    private val key = "image:$binding"
    private var selection: JSONObject? = null
    private var busy = false
    val pending get() = selection != null || prefs.contains(key)
    private fun id() = UUID.randomUUID().toString()
    private fun call(word: String, body: JSONObject = JSONObject(), done: (JSONObject) -> Unit) {
        env.port.ask("service:collaboration", "collaboration.material.$word", body) { r ->
            if (!alive()) return@ask
            if (!r.ok || r.data.optString("auth_scope") != scope) { busy = false; notice(r.failure?.message ?: "图片授权已改变，请重新选择") }
            else done(r.data)
        }
    }
    init {
        prefs.getString(key, null)?.let { saved ->
            val op = runCatching { JSONObject(saved) }.getOrNull()
            op?.optString("draft_id")?.let { draft -> call("draft.load", JSONObject().put("draft_id", draft)) { data ->
                val name = data.optJSONObject("result")?.list("selections")?.singleOrNull()?.optString("name")
                selected(name, null)
            } }
        }
    }
    fun remove() {
        if (busy) return
        val saved = prefs.getString(key, null)
        if (saved != null) {
            val operation = runCatching { JSONObject(saved).optString("operation_id") }.getOrDefault(binding)
            if (!prefs.edit().putString("image-dismissed:$operation", saved).remove(key).commit()) { notice("暂时无法移除图片"); return }
        }
        selection = null; selected(null, null)
    }
    private fun sameWork(value: JSONObject?) = value != null && listOf("kind", "node_id", "endpoint_id", "native_id").all { value.optString(it) == work.optString(it) }
    private fun result(data: JSONObject) = data.getJSONObject("result")
    fun pick() {
        if (busy || prefs.contains(key)) { notice("请先查询已有图片的发送结果"); return }
        env.files?.pick { files ->
            if (!alive()) return@pick
            if (files.length() == 0) return@pick
            if (files.length() != 1) { notice("请选择一张 PNG 或 JPEG 图片"); return@pick }
            val file = files.getJSONObject(0); val mime = file.optString("mime_type")
            if (mime !in setOf("image/png", "image/jpeg")) { notice("请选择 PNG 或 JPEG 图片"); return@pick }
            val encoded = file.getString("data")
            busy = true; notice("正在准备图片…")
            if (encoded.length < 3900000) {
                call("import", JSONObject().put("name", file.getString("name")).put("media_type", mime).put("data_base64", encoded)) { d -> selection = result(d); busy = false; selected(selection!!.getString("name"), encoded) }
            } else {
                val bytes = Base64.decode(encoded, Base64.DEFAULT)
                val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
                val importId = id()
                call("import.begin", JSONObject().put("import_id", importId).put("name", file.getString("name")).put("media_type", mime).put("byte_length", bytes.size).put("sha256", hash)) {
                    fun chunk(offset: Int) {
                        if (offset >= bytes.size) { call("import.commit", JSONObject().put("import_id", importId)) { d -> selection = result(d); busy = false; selected(selection!!.getString("name"), encoded) }; return }
                        val part = Base64.encodeToString(bytes.copyOfRange(offset, minOf(bytes.size, offset + 40960)), Base64.NO_WRAP)
                        call("import.chunk", JSONObject().put("import_id", importId).put("chunk_index", offset / 40960).put("data_base64", part)) { chunk(offset + 40960) }
                    }
                    chunk(0)
                }
            }
        }
    }
    fun send(text: String) {
        if (busy) return
        val saved = prefs.getString(key, null)
        if (saved != null) { busy = true; resume(JSONObject(saved)); return }
        val picked = selection ?: return
        if (text.toByteArray(Charsets.UTF_8).size > 16384) { notice("消息过长，请缩短"); return }
        busy = true
        call("draft.save", JSONObject().put("draft_id", "image-${id()}").put("target", work).put("text", text).put("selection_ids", org.json.JSONArray().put(picked.getString("selection_id")))) { data ->
            val draft = result(data)
            if (draft.optString("saved") != "durable" || !sameWork(draft.optJSONObject("target"))) { busy = false; notice("图片草稿尚未保存，请重试"); return@call }
            val op = JSONObject().put("draft_id", draft.getString("draft_id")).put("request_id", id()).put("client_id", id()).put("operation_id", id()).put("client_message_id", id()).put("target", work)
            if (!prefs.edit().putString(key, op.toString()).commit()) { busy = false; notice("暂时无法保存图片发送记录"); return@call }
            submit(op)
        }
    }
    private fun query(op: JSONObject) = JSONObject().put("request_id", op.getString("request_id")).put("operation_id", op.getString("operation_id")).put("client_message_id", op.getString("client_message_id")).put("target", work)
    private fun resume(op: JSONObject) = call("input.query", query(op)) { data ->
        if (data.isNull("result")) submit(op) else fact(result(data))
    }
    private fun submit(op: JSONObject) {
        notice("图片上传中…")
        call("input.submit", JSONObject().put("draft_id", op.getString("draft_id")).put("request_id", op.getString("request_id")).put("client_id", op.getString("client_id")).put("target", work)) { data -> transfer(op, result(data)) }
    }
    private fun transfer(op: JSONObject, request: JSONObject, retried: Boolean = false) {
        val asset = request.list("assets").singleOrNull()
        val transfer = asset?.optJSONObject("transfer")
        val complete = asset?.optBoolean("readable") == true && transfer?.optString("state") in setOf("committed", "acknowledged") && sameWork(transfer?.optJSONObject("receipt")?.optJSONObject("destination")?.optJSONObject("work"))
        if (complete) { call("input.send", query(op)) { fact(result(it)) }; return }
        if (asset == null || retried) { busy = false; notice("图片尚未上传，请再次点击发送核实"); return }
        val ref = asset.getJSONObject("ref")
        call("input.retry", JSONObject().put("request_id", op.getString("request_id")).put("asset_id", ref.getString("asset_id")).put("asset_version", ref.getLong("version"))) { data ->
            val updated = result(data)
            val a = updated.list("assets").singleOrNull()
            if (a?.optBoolean("readable") == true && a.optJSONObject("transfer")?.optString("state") in setOf("committed", "acknowledged")) transfer(op, updated, true)
            else { busy = false; notice("图片尚未上传完成，请再次点击发送核实") }
        }
    }
    private fun fact(value: JSONObject) {
        busy = false
        val original = runCatching { JSONObject(prefs.getString(key, null) ?: return) }.getOrNull() ?: return
        if (value.optString("request_id") != original.optString("request_id") || value.optString("operation_id") != original.optString("operation_id") || !sameWork(value.optJSONObject("work"))) { notice("图片结果不匹配，请重新核实"); return }
        if (value.optString("delivery_status") == "accepted" && value.optJSONObject("receipt")?.optString("accepted_by") == "native") {
            prefs.edit().remove(key).commit(); selection = null; selected(null, null); notice("图片已发送"); accepted()
        } else notice(if (value.optString("delivery_status") == "rejected") "图片未发送，请核实结果" else "图片发送结果待确认，请再次点击发送查询")
    }
}
