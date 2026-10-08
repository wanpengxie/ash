package ai.ash.widget

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class WidgetPlanTest {
    /** The card cases the core checks too (packages/core/test/fixtures/widget-cards.json, from `npm run gen:widget-cards`). */
    private val fixture: JSONObject by lazy {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "packages/core/test/fixtures/widget-cards.json") }.first { it.isFile }
        JSONObject(file.readText())
    }
    private fun cases() = fixture.getJSONArray("cases").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
    private fun case(prefix: String) = cases().firstOrNull { it.getString("name") == prefix } ?: cases().first { it.getString("name").startsWith(prefix) }
    private fun render(prefix: String) = CardSpec.parse(case(prefix).getJSONObject("rendered"))

    private fun VNode.find(id: String): VNode = walk().first { it.id == id }
    private fun c(id: String, kind: String, vararg pairs: Pair<String, Any>) = JSONObject().put("id", id).put("component", kind).apply { pairs.forEach { put(it.first, it.second) } }
    private fun a2ui(vararg components: JSONObject) = JSONObject().put("root", "root").put("components", JSONArray(components.toList()))

    @Test fun theCoreAndThePhoneAgreeOnEveryCase() {
        for (case in cases()) {
            val name = case.getString("name")
            val rendered = case.optJSONObject("rendered") ?: continue
            val levels = if (case.has("levels")) case.getInt("levels") else null
            if (case.getString("expect") == "ok") {
                val render = CardSpec.parse(rendered)
                for (root in listOf(render.root) + render.sizes.map { it.root }) {
                    val plan = CardPlan.plan(render, root)
                    // What the phone builds nests exactly as deep as both sides count.
                    assertEquals(name, CardSpec.levels(root), plan.depth)
                    for (list in plan.walk().filter { it.items != null }) for (item in list.items!!) assertTrue(name, item.depth <= CardSpec.ITEM_LEVELS)
                    CardPlan.plan(render, root, api31 = false)
                }
                if (levels != null) assertEquals(name, levels, (listOf(render.root) + render.sizes.map { it.root }).maxOf { CardSpec.levels(it) })
            } else if (levels != null) {
                // Refused by the core for depth: the phone refuses it too, counting the same levels.
                val e = assertThrows(name, CardProblem::class.java) { CardSpec.parse(rendered) }
                assertTrue("$name: ${e.message}", e.message!!.contains("嵌套了 $levels 层"))
            }
        }
    }

    @Test fun theSameIconsAndColoursOnBothSides() {
        val icons = fixture.getJSONArray("icons").let { a -> (0 until a.length()).map { a.getString(it) } }
        assertEquals(icons.toSet(), CardSpec.icons.keys)
        val colors = fixture.getJSONArray("colors").let { a -> (0 until a.length()).map { a.getString(it) } }
        assertEquals(colors.toSet(), CardSpec.colors.keys)
        val avatars = fixture.getJSONArray("avatars").let { a -> (0 until a.length()).map { a.getString(it) } }
        assertEquals(avatars, CardSpec.avatars)
        val limits = fixture.getJSONObject("limits")
        assertEquals(limits.getInt("levels"), CardSpec.LEVELS)
        assertEquals(limits.getInt("levelsWithSizes"), CardSpec.LEVELS_WITH_SIZES)
        assertEquals(limits.getInt("itemLevels"), CardSpec.ITEM_LEVELS)
        assertEquals(limits.getInt("lists"), CardSpec.LISTS)
    }

    @Test fun aColumnInsideARowWrapsItsContentInsteadOfFillingTheRow() {
        // Column > Row > Column > Text was accepted and then drew blank on the phone. The old renderer gave each inner
        // Column the whole Row's width (match_parent), so a Row of Columns was several widgets wide and its content
        // overflowed out of view. Columns in a Row now wrap their content; CardCheck catches anything else blank.
        val plan = CardPlan.plan(render("Column > Row > Column > Text"))
        val row = plan.find("r")
        assertEquals(Lay.ROW, row.lay)
        assertEquals(Dim.Fill, row.width)
        for (id in listOf("left", "right")) {
            assertEquals(Lay.COL, plan.find(id).lay)
            assertEquals("$id wraps", Dim.Wrap, plan.find(id).width)
        }
        assertEquals(listOf(Lay.COL, Lay.GAP_H, Lay.COL), row.children.map { it.lay })
        assertEquals("23℃", plan.find("t1").text!!.text)
        assertEquals("空气良\n湿度 60%", plan.find("t3").text!!.text)
        assertEquals(CardPlan.END or CardPlan.TOP, plan.find("right").gravity)
        // The root fills the widget.
        assertEquals(Dim.Fill, plan.width); assertEquals(Dim.Fill, plan.height)
    }

    @Test fun stylesBackgroundsAndInheritedTextColour() {
        val render = render("translucent dark card")
        val plan = CardPlan.plan(render)
        assertEquals(Tint(0xB3000000.toInt(), 0xB3000000.toInt()), plan.bg)
        assertEquals(24f, plan.radius)
        assertArrayEquals(floatArrayOf(12f, 16f, 12f, 16f), plan.padding, 0f)
        val a = plan.find("a")
        assertEquals(Lay.TEXT_MIDDLE, a.lay)
        assertEquals("体重 61.8 kg", a.text!!.text)
        assertTrue(a.text!!.spans.contains(Span(0, 2, Mark.BOLD)))
        assertTrue(a.text!!.spans.contains(Span(0, 10, Mark.ITALIC)))
        assertEquals(28f, a.textSize)
        assertEquals(1, a.maxLines)
        assertEquals(CardPlan.CENTER_H or CardPlan.CENTER_V, a.gravity)
        assertEquals(CardSpec.colors["white"], a.textColor) // inherited from the root's style.color
        val b = plan.find("b")
        assertEquals(Tint(0xFF2E7D32.toInt(), 0xFF81C784.toInt()), b.textColor)
        assertEquals(0.8f, b.alpha)
        assertArrayEquals(floatArrayOf(4f, 0f, 0f, 0f), b.margin, 0f)
        // A root with a background draws the widget itself: no frame title, its own corners.
        assertEquals(Frame(title = false, ownBackground = true, titleColor = CardSpec.colors["white"]), CardPlan.frame(render.root, "体重", false))
        val plainCard = render("Column > Row > Column > Text")
        assertEquals(Frame(title = false, ownBackground = false, titleColor = null), CardPlan.frame(plainCard.root, "今日", WidgetPlan.opensWithTitle(plainCard.root, "今日")))
        assertTrue(CardPlan.frame(plainCard.root, "天气", WidgetPlan.opensWithTitle(plainCard.root, "天气")).title)
    }

    @Test fun listsScrollWithAnItemPerEntryCheckboxesAndButtons() {
        val render = render("a to-do list")
        val plan = CardPlan.plan(render)
        val list = plan.find("list")
        assertEquals(Lay.LIST, list.lay)
        assertEquals(2, list.items!!.size)
        val item = list.items!![1]
        assertEquals(Lay.ROW, item.lay)
        assertEquals(Dim.Fill, item.width)
        assertEquals(Tap.Send("item@1"), item.tap)
        val slot = item.children[0]
        assertEquals(Lay.SLOT_H, slot.lay); assertEquals(12, slot.weight)
        val check = slot.children.single()
        assertEquals(Lay.CHECK, check.lay)
        assertEquals("回邮件", check.text!!.text)
        assertEquals(true, check.checked)
        assertEquals(Tap.Toggle("check@1", true), check.tap)
        assertEquals(Tap.Send("del@1"), item.find("del@1").tap)
        assertEquals(Lay.BUTTON_BORDERLESS, item.find("del@1").lay)
        assertEquals("🗑", item.find("del_icon@1").text!!.text)
        assertEquals("待办 2 项", plan.find("title").text!!.text)
        // The owner's toggle shows at once, before the core draws the card again.
        val toggled = CardPlan.plan(render, local = Local(checked = mapOf("check@0" to true))).find("list").items!![0].walk().first { it.lay == Lay.CHECK }
        assertEquals(true, toggled.checked)
        // Before Android 12 a widget cannot hold a CheckBox: a text box with ☐/☑ toggles instead.
        val old = CardPlan.plan(render, api31 = false).find("list").items!![0].walk().first { it.id == "check@0" }
        assertEquals(Lay.TEXT, old.lay); assertEquals("☐ 买牛奶", old.text!!.text); assertEquals(Tap.Toggle("check@0", false), old.tap)
    }

    @Test fun imagesIconsAndOpenActions() {
        val plan = CardPlan.plan(render("images, icons and actions"))
        val pic = plan.find("pic")
        assertEquals(Lay.IMAGE_COVER, pic.lay)
        assertEquals(Img.Url("https://example.com/a.jpg"), pic.image)
        assertEquals(Dim.Fill, pic.width); assertEquals(Dim.Dp(100f), pic.height)
        assertEquals(Tap.Open("pic", CAction.OpenApp("health", "trends")), pic.tap)
        assertEquals(Dim.Dp(24f), plan.find("data").width)
        val face = plan.find("face")
        assertEquals(Img.Avatar("thinking"), face.image); assertEquals(999f, face.radius)
        val icon = plan.find("ic")
        assertEquals(Lay.ICON, icon.lay); assertEquals("♥", icon.text!!.text); assertEquals(CardSpec.colors["red"], icon.textColor); assertEquals(20f, icon.textSize)
        assertEquals(Img.Path("M2 2 L22 2 L12 22 Z", CardSpec.colors.getValue("text")), plan.find("svg").image)
        assertEquals(Tap.Open("l1", CAction.OpenApp("todo", "home")), plan.find("l1").tap)
        assertEquals(Tap.Open("l2", CAction.OpenAsh), plan.find("l2").tap)
    }

    @Test fun tabsGridsStacksChoicesAndLiveText() {
        val render = render("every other component")
        val plan = CardPlan.plan(render)
        val tabs = plan.find("tabs")
        assertEquals("雨", tabs.children[1].text!!.text)
        assertEquals(Tap.Tab("tabs", 0), tabs.children[0].children[0].tap)
        assertEquals("晴", CardPlan.plan(render, local = Local(tabs = mapOf("tabs" to 0))).find("tabs").children[1].text!!.text)
        val grid = plan.find("grid")
        assertEquals(2, grid.children.size)
        assertEquals(listOf(1, 1), grid.children[1].children.map { it.weight })
        assertTrue(grid.children[1].children[1].children.isEmpty())
        val dot = plan.find("dot~place")
        assertEquals(Lay.PLACE, dot.lay); assertEquals(CardPlan.TOP or CardPlan.END, dot.gravity)
        val pick = plan.find("pick")
        assertEquals(Lay.ROW, pick.lay)
        assertEquals(listOf("心情  ", "好", "一般"), pick.children.map { it.text!!.text })
        assertEquals(CardSpec.colors["accent"], pick.children[1].bg)
        assertEquals(Tap.Choose("pick", "ok"), pick.children[2].tap)
        assertEquals(Lay.SWITCH, plan.find("sw").lay)
        assertEquals(Lay.GAP_V, plan.find("sp").lay)
        assertEquals("HH:mm", plan.find("clock").clockFormat); assertEquals("Asia/Shanghai", plan.find("clock").timeZone)
        assertEquals(1791306000000L, plan.find("timer").chronoSince)
        assertEquals(375 to 1000, plan.find("pb").progress)
        // spaceBetween spreads the Column's children with gaps between them.
        assertEquals(Lay.GAP_V, plan.children[1].lay)
    }

    @Test fun spreadRowsKeepAnIconWithWhatFollowsIt() {
        val plan = CardPlan.plan(render("the first card format"))
        assertEquals(listOf(Lay.ICON, Lay.TEXT, Lay.GAP_H, Lay.BADGE), plan.find("head").children.map { it.lay })
        assertEquals("23", plan.find("temp").text!!.text)
        assertEquals(30f, plan.find("temp").textSize)
        assertEquals(Lay.BUTTON, plan.find("refresh").lay)
        assertEquals(Tap.Send("refresh"), plan.find("refresh").tap)
        assertEquals(400 to 1000, plan.find("bar").progress)
    }

    @Test fun weightsBecomeSlotsAndStretchSlotsEveryChild() {
        val render = CardSpec.parse(a2ui(c("root", "Row", "children" to JSONArray(listOf("a", "b", "c"))),
            c("a", "Text", "text" to "a", "weight" to 1), c("b", "Text", "text" to "b", "weight" to 3), c("c", "Text", "text" to "c")))
        val row = CardPlan.plan(render)
        assertEquals(listOf(Lay.SLOT_H, Lay.SLOT_H, Lay.TEXT), row.children.map { it.lay })
        assertEquals(listOf(4, 12, 0), row.children.map { it.weight })
        assertEquals(Dim.Fill, row.children[0].children[0].width)
        val stretch = CardSpec.parse(a2ui(c("root", "Row", "justify" to "stretch", "children" to JSONArray(listOf("a", "b"))), c("a", "Text", "text" to "a"), c("b", "Text", "text" to "b")))
        assertEquals(listOf(12, 12), CardPlan.plan(stretch).children.map { it.weight })
        assertEquals(3, CardSpec.levels(stretch.root))
    }

    @Test fun perSizeLayoutsPickTheLargestThatFits() {
        val render = render("per-size layouts")
        assertEquals("small#0", WidgetPlan.pick(render, 120f, 120f).id)
        assertEquals("root", WidgetPlan.pick(render, 300f, 150f).id)
        assertEquals("small#0", WidgetPlan.pick(render, 80f, 80f).id)
    }

    @Test fun aCardThePhoneCannotReadSaysWhy() {
        val state = WidgetPlan.parseState(JSONObject().put("revision", 3).put("cards", JSONArray()
            .put(JSONObject().put("id", "ok").put("title", "今天天气").put("size", "4x2").put("owner", "agent:main").put("updated_at", 1)
                .put("expires_at", 5000).put("a2ui", case("the first card format").getJSONObject("rendered")))
            .put(JSONObject().put("id", "bad").put("title", "坏").put("size", "4x2").put("owner", "agent:main").put("updated_at", 1)
                .put("a2ui", a2ui(c("root", "Hologram")))))
            .put("bindings", JSONObject().put("7", "ok").put("9", "bad")))
        assertTrue(WidgetPlan.view(state, 7, null, 1000) is CardView.Show)
        assertTrue(WidgetPlan.view(state, 7, null, 5000) is CardView.Expired)
        assertTrue(WidgetPlan.view(state, 8, null, 1000) is CardView.Unbound)
        assertTrue(WidgetPlan.view(state, 8, "ok", 1000) is CardView.Show)
        assertTrue(WidgetPlan.view(state, 8, "gone", 1000) is CardView.Unbound)
        val broken = WidgetPlan.view(state, 9, null, 1000) as CardView.Broken
        assertEquals("手机画不了「Hologram」组件（root）", broken.problem)
        assertNotNull(WidgetPlan.find(state.cards.getValue("ok").render!!, "refresh_label"))
    }

    @Test fun aCardNestedDeeperThanAndroidAllowsIsRefusedWithTheBranch() {
        val deep = (0 until 11).map { c(if (it == 0) "root" else "c$it", "Column", "children" to JSONArray(listOf(if (it == 10) "leaf" else "c${it + 1}"))) } + c("leaf", "Text", "text" to "x")
        val e = assertThrows(CardProblem::class.java) { CardSpec.parse(a2ui(*deep.toTypedArray())) }
        assertTrue(e.message!!, e.message!!.startsWith("这张卡片嵌套了 12 层，安卓小组件最多 10 层（root > c1 > c2"))
    }

    @Test fun thePhonesToDoCardDrawsItsRowsAsPlainChildrenWhileTheyFit() {
        // On ColorOS the list area of this card came out empty: the list's adapter was set from a nested RemoteViews,
        // which Android drops when the launcher applies the widget asynchronously. Lists are now drawn as plain rows
        // while they fit (and otherwise get their adapter from the widget's top level, checked by CardCheck).
        val render = render("the phone's to-do card")
        val plan = CardPlan.plan(render)
        val list = plan.find("list")
        assertEquals(8, list.items!!.size)
        assertTrue(plan.plainDepth <= CardSpec.LEVELS)
        val rows = CardPlan.plain(list)
        assertEquals(Lay.COL, rows.lay)
        assertNull(rows.items)
        assertEquals(8, rows.children.size)
        val first = rows.children[0]
        assertEquals(Lay.CHECK, first.lay)
        assertEquals("门磁 / 摄像头比价", first.text!!.text)
        assertEquals(false, first.checked)
        assertEquals(Tap.Toggle("item@0", false), first.tap)
        assertEquals(true, rows.children[4].checked)
        assertEquals(CardSpec.colors["white"], first.textColor)
        assertEquals("待办", plan.find("title").text!!.text)
        // The List sits in a weighted slot of the root Column, so it gets the space between the title and the footer.
        assertEquals(Lay.SLOT_V, plan.children[1].lay)
        // A grid list as plain rows: rows of equal cells.
        val grid = CardPlan.plain(list.copy(lay = Lay.GRID, columns = 3))
        assertEquals(listOf(3, 3, 3), grid.children.map { it.children.size })
        assertEquals(CardSpec.LISTS, 16)
    }
}
