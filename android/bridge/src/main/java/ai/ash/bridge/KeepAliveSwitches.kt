package ai.ash.bridge

import org.json.JSONArray
import org.json.JSONObject

/**
 * The phone maker's switches that keep Ash's own three apps alive, and what the screen helper reports after turning them
 * on (ColorOS only). Shared by both ends of the bridge: the helper writes a [Report], Ash reads it back. It is a tool of
 * Ash's own for the owner's tap: the helper never lists it in its manifest, so no agent can call it.
 */
object KeepAliveSwitches {
    /** Run through the bridge's generic call, but never listed. */
    const val CAPABILITY = "ash.keepalive_switches"
    /**
     * The first helper whose flow Ash offers; an older one gets the written guidance. 9: the one-switch-per-app list of
     * ColorOS 15 (version 8 misread it).
     */
    const val MIN_HELPER_VERSION = 9L
    const val ASH_PACKAGE = "ai.ash.agent"
    /** Opened by the helper when the flow is done: Ash's task comes back as it was left (see Ash's ReturnActivity). */
    const val RETURN_ACTIVITY = "ai.ash.host.screen.ReturnActivity"

    /** An app as the maker's settings list it. */
    data class Target(val pkg: String, val label: String)
    /** The only apps the flow ever touches. */
    val targets: List<Target> = listOf(
        Target(ASH_PACKAGE, "Ash"),
        Target(Bridge.SENSES_PACKAGE, "Ash 感知"),
        Target(Bridge.SCREEN_PACKAGE, "Ash 屏幕助手"),
    )
    fun target(pkg: String): Target? = targets.firstOrNull { it.pkg == pkg }

    /** One switch, by the text next to it. */
    enum class Kind(val label: String, val key: String) {
        /**
         * In the 自启动 list: on ColorOS 15 one switch per app, whose subtitle names what it covers (「开机自启动、后台自启动」,
         * or only 「后台自启动」); on older versions two switches on the app's own page.
         */
        BOOT("开机自启动", "boot"),
        BACKGROUND("后台自启动", "background"),
        /** In the app info page → 耗电管理. */
        BEHAVIOR("允许应用后台行为", "behavior");
        companion object { fun of(key: String): Kind? = entries.firstOrNull { it.key == key } }
    }

    enum class State(val key: String) {
        WAS_ON("was_on"), TURNED_ON("turned_on"), NOT_FOUND("not_found"), FAILED("failed"),
        /** The phone has no such switch for this app: its one 自启动 switch says it covers only the other kind. */
        NOT_OFFERED("not_offered");
        val on get() = this == WAS_ON || this == TURNED_ON
        companion object { fun of(key: String): State? = entries.firstOrNull { it.key == key } }
    }

    data class Item(val pkg: String, val kind: Kind, val state: State)

    enum class Outcome(val key: String) {
        /** Every step ran to the end (individual switches may still be not_found / failed). */
        DONE("done"),
        /** An unexpected screen: the flow stopped where [Report.stoppedAt] says. */
        ABORTED("aborted"),
        UNSUPPORTED("unsupported");
        companion object { fun of(key: String): Outcome? = entries.firstOrNull { it.key == key } }
    }

    class Report(val outcome: Outcome, val stoppedAt: String, val items: List<Item>) {
        fun state(pkg: String, kind: Kind): State? = items.lastOrNull { it.pkg == pkg && it.kind == kind }?.state

        /**
         * The app's switches were all seen on. The 开机自启动 switch is not there for every app (some list only
         * 「后台自启动」), so its absence counts when 「后台自启动」 is on; a phone that offers only 开机自启动 counts when
         * that one is on.
         */
        fun verified(pkg: String): Boolean {
            val boot = state(pkg, Kind.BOOT)
            val background = state(pkg, Kind.BACKGROUND)
            val autostart = (boot?.on == true || background?.on == true) &&
                (boot?.on == true || boot == State.NOT_FOUND || boot == State.NOT_OFFERED) &&
                (background?.on == true || background == State.NOT_OFFERED)
            return autostart && state(pkg, Kind.BEHAVIOR)?.on == true
        }

        fun toJson(): JSONObject = JSONObject().put("outcome", outcome.key).put("stopped_at", stoppedAt).put("items", JSONArray().apply {
            for (i in items) put(JSONObject().put("package", i.pkg).put("switch", i.kind.key).put("state", i.state.key))
        })

        /** Owner-facing lines, one per app asked about. */
        fun summary(asked: List<Target>): String = buildString {
            when (outcome) {
                Outcome.UNSUPPORTED -> append("这台手机的系统暂不支持代为打开，请按提示自己打开。")
                Outcome.ABORTED -> append("中途停下了：").append(stoppedAt.ifEmpty { "出现了意料之外的界面" }).append("\n")
                Outcome.DONE -> {}
            }
            if (outcome != Outcome.UNSUPPORTED) for (t in asked) {
                if (isNotEmpty() && last() != '\n') append('\n')
                append(t.label).append("：")
                val parts = Kind.entries.map { k ->
                    val s = state(t.pkg, k)
                    "${k.label}" + when (s) {
                        State.WAS_ON -> "（本来就开着）"
                        State.TURNED_ON -> "（已打开）"
                        State.NOT_FOUND -> "（没找到）"
                        State.FAILED -> "（没打开成功）"
                        State.NOT_OFFERED -> "（此手机不提供）"
                        null -> "（没做到）"
                    }
                }
                append(parts.joinToString("、"))
            }
        }

        companion object {
            fun fromJson(o: JSONObject): Report {
                val list = o.optJSONArray("items") ?: JSONArray()
                val items = (0 until list.length()).mapNotNull { list.optJSONObject(it) }.mapNotNull {
                    Item(it.optString("package"), Kind.of(it.optString("switch")) ?: return@mapNotNull null, State.of(it.optString("state")) ?: return@mapNotNull null)
                }
                return Report(Outcome.of(o.optString("outcome")) ?: Outcome.ABORTED, o.optString("stopped_at"), items)
            }
        }
    }
}
