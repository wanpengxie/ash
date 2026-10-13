package ai.ash.ui

import org.json.JSONObject

/** A state lease belongs to the action it was requested for. A state transition requires another explicit observation. */
internal fun coworkerAction(data: JSONObject, work: JSONObject, requested: String): String? {
    val snapshot = data.optJSONObject("snapshot") ?: return null
    val observedWork = snapshot.optJSONObject("work") ?: return null
    if (listOf("kind", "node_id", "endpoint_id", "native_id").any { observedWork.optString(it) != work.optString(it) }) return null
    val epoch = data.optString("connector_epoch")
    if (epoch.isEmpty() || snapshot.optString("connector_epoch") != epoch || snapshot.optString("source") != "codex.live" || snapshot.isNull("observed_at")) return null
    val action = when (snapshot.optString("state")) {
        "idle" -> "send_input"
        "active" -> if (snapshot.optString("turn_id").isNotEmpty() && snapshot.optString("identity_provenance") in setOf("observed_turn_started", "history_candidate")) "steer" else null
        else -> null
    }
    if (action != requested) return null
    val allowed = data.optJSONArray("allowed_actions") ?: return null
    return action.takeIf { (0 until allowed.length()).any { i -> allowed.optString(i) == action } }
}
internal enum class CoworkerLink { WEB, FILE, REJECTED }
internal fun coworkerLink(href: String): CoworkerLink {
    val scheme = Regex("^([A-Za-z][A-Za-z0-9+.-]*):").find(href)?.groupValues?.get(1)?.lowercase()
    return when (scheme) { "http", "https" -> CoworkerLink.WEB; "file", null -> CoworkerLink.FILE; else -> CoworkerLink.REJECTED }
}

/** Copy the fenced source exactly, including leading blank lines and indentation. */
internal fun coworkerCodeBlocks(source: String): List<String> {
    val lines = source.replace("\r\n", "\n").split("\n")
    val blocks = ArrayList<String>()
    var i = 0
    while (i < lines.size) {
        if (!lines[i].trimStart().startsWith("```")) { i++; continue }
        val start = ++i
        while (i < lines.size && !lines[i].trimStart().startsWith("```")) i++
        blocks.add(lines.subList(start, i).joinToString("\n"))
        i++
    }
    return blocks
}
