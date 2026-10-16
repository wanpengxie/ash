package ai.ash.kernel.host

import ai.ash.kernel.host.ctx.ContextContent
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ContextContentTest {
    private class Node(
        override val isPassword: Boolean = false,
        override val id: String? = "app:id/input",
        private val value: String? = null,
        private val desc: String? = null,
        private val children: List<Node> = emptyList(),
    ) : ContextContent.Node {
        var contentReads = 0
        var childReads = 0
        override val text: CharSequence? get() { contentReads++; return value }
        override val description: CharSequence? get() { contentReads++; return desc }
        override val childCount get(): Int { childReads++; return children.size }
        override fun child(index: Int): Node { childReads++; return children[index] }
    }

    private fun record(ev: String = "text", id: String? = null) = JSONObject()
        .put("ev", ev).put("pkg", "app.example").put("t", 42L).apply { id?.let { put("id", it) } }

    private fun assertProtected(out: JSONObject, vararg secrets: String) {
        assertTrue(out.optBoolean("password"))
        for (key in listOf("text", "desc", "inner", "title", "body")) assertFalse(key, out.has(key))
        for (secret in secrets) assertFalse(secret, out.toString().contains(secret))
    }

    @Test fun eitherPasswordFlagPreventsAllEventContentReads() {
        for (ev in listOf("text", "focus", "click", "long_click", "context_click", "select", "scroll", "window", "notif")) {
            for (eventPassword in listOf(false, true)) {
                val secret = "unique_${ev}_${eventPassword}_password_7b84"
                val source = Node(isPassword = !eventPassword, value = secret, desc = "${secret}_desc")
                val out = record(ev)
                var eventReads = 0
                var notificationReads = 0
                ContextContent.event(out, eventPassword, source, {
                    eventReads++; secret
                }, {
                    notificationReads++; out.put("title", "${secret}_title"); true
                })
                assertProtected(out, secret)
                assertEquals("app:id/input", out.getString("id"))
                assertEquals("app.example", out.getString("pkg"))
                assertEquals(42L, out.getLong("t"))
                assertEquals(0, source.contentReads)
                assertEquals(0, source.childReads)
                assertEquals(0, eventReads)
                assertEquals(0, notificationReads)
            }
        }
    }

    @Test fun passwordEventWithoutSourceStillSkipsTextAndTitle() {
        for (ev in listOf("text", "window", "notif")) {
            val out = record(ev)
            ContextContent.event(out, true, null, { error("unique_no_source_password_813f") },
                { error("unique_no_source_notification_4f8c") })
            assertProtected(out, "unique_no_source_password_813f", "unique_no_source_notification_4f8c")
        }
    }

    @Test fun childLabelsSkipPasswordSubtreesAndKeepOrdinaryLabels() {
        val descendant = Node(value = "unique_password_descendant_661d")
        val password = Node(isPassword = true, value = "unique_child_password_1bf5",
            desc = "unique_child_description_759a", children = listOf(descendant))
        val normal = Node(value = "Open settings")
        val source = Node(children = listOf(password, normal))
        val out = record("click")
        ContextContent.event(out, false, source, { "" })
        assertEquals("Open settings", out.getString("inner"))
        assertFalse(out.toString().contains("unique_"))
        assertEquals(0, password.contentReads)
        assertEquals(0, password.childReads)
        assertEquals(0, descendant.contentReads)
        assertFalse(out.has("password"))
    }

    @Test fun screenTextNeverReadsPasswordTextOrDescription() {
        val password = Node(isPassword = true, value = "unique_screen_password_d80b", desc = "unique_screen_description_d693")
        assertEquals(null, ContextContent.screenText(password))
        assertEquals(0, password.contentReads)
        assertEquals("Ordinary screen text", ContextContent.screenText(Node(value = " Ordinary screen text ")))
        assertEquals("Ordinary description", ContextContent.screenText(Node(desc = " Ordinary description ")))
    }

    @Test fun passwordTransitionErasesEarlierPendingContentAndStaysProtected() {
        val pending = record().put("id", "app:id/input").put("first", 1L).put("edits", 3)
            .put("inner", "unique_earlier_inner_42c7").put("title", "unique_earlier_title_10cf")
            .put("body", "unique_earlier_body_f589")
        ContextContent.event(pending, false, Node(desc = "unique_earlier_desc_3c04"), { "unique_earlier_text_829a" })
        val event = record()
        ContextContent.event(event, false, Node(isPassword = true), { error("password text read") })
        ContextContent.protectPending(pending, event)
        ContextContent.mergeContent(pending, event)
        assertProtected(pending, "unique_earlier_")
        assertEquals(1L, pending.getLong("first"))
        assertEquals(3, pending.getInt("edits"))
        val later = record()
        ContextContent.event(later, false, Node(desc = "unique_later_plain_description_e347"), { "unique_later_plain_update_17fe" })
        ContextContent.mergeContent(pending, later)
        assertProtected(pending, "unique_later_plain_")
    }

    @Test fun passwordFocusOrClickProtectsPendingTypingAndScrollBeforeFlush() {
        for (ev in listOf("focus", "click")) {
            for (pendingEv in listOf("text", "scroll")) {
                val secret = "unique_pending_${ev}_${pendingEv}_aa21"
                val pending = record(pendingEv, "app:id/input").put("text", secret).put("desc", "${secret}_desc")
                val event = record(ev)
                ContextContent.event(event, true, Node(), { error("password event read") })
                ContextContent.protectPending(pending, event)
                assertProtected(pending, secret)
                val unrelated = record(pendingEv, "app:id/other").put("text", "Ordinary other field")
                ContextContent.protectPending(unrelated, event)
                assertEquals("Ordinary other field", unrelated.getString("text"))
                assertFalse(unrelated.has("password"))
            }
        }
    }

    @Test fun mergeAlsoProtectsWhenPasswordUpdateArrivesWithoutPriorRedaction() {
        val pending = record().put("text", "unique_merge_old_779e").put("desc", "unique_merge_desc_38ad")
        ContextContent.mergeContent(pending, record().put("password", true))
        assertProtected(pending, "unique_merge_")
    }

    @Test fun missingSourceIdentityStillProtectsPendingContentFromTheSameApp() {
        val secret = "unique_source_disappeared_f1af"
        val pending = record(id = "app:id/input").put("text", secret).put("desc", "${secret}_desc")
        val password = record("focus")
        ContextContent.event(password, true, null, { error("password event read") })
        ContextContent.protectPending(pending, password)
        assertProtected(pending, secret)

        val unknownPending = record().put("text", "unique_old_identity_unknown_1c9e")
        ContextContent.protectPending(unknownPending, record(id = "app:id/input").put("password", true))
        assertProtected(unknownPending, "unique_old_identity_unknown_1c9e")

        val otherApp = record(id = "app:id/input").put("pkg", "another.app").put("text", "Ordinary other app")
        ContextContent.protectPending(otherApp, password)
        assertEquals("Ordinary other app", otherApp.getString("text"))
    }

    @Test fun ordinaryEventTextDescriptionsTitlesAndTypingUpdatesRemainUseful() {
        val typing = record()
        ContextContent.event(typing, false, Node(desc = "Search input"), { "hello" })
        assertEquals("hello", typing.getString("text"))
        assertEquals("Search input", typing.getString("desc"))
        ContextContent.mergeContent(typing, record().put("text", "hello world"))
        assertEquals("hello world", typing.getString("text"))
        assertFalse(typing.has("password"))
        for (ev in listOf("click", "focus")) {
            val out = record(ev)
            ContextContent.event(out, false, Node(value = "Selected label"), { "" })
            assertEquals("Selected label", out.getString("text"))
        }
        val window = record("window")
        ContextContent.event(window, false, null, { "Settings" })
        assertEquals("Settings", window.getString("title"))
        val notification = record("notif")
        ContextContent.event(notification, false, null, { error("notification already supplied") }, {
            notification.put("title", "Download complete").put("body", "File saved"); true
        })
        assertEquals("Download complete", notification.getString("title"))
        assertEquals("File saved", notification.getString("body"))
    }
}
