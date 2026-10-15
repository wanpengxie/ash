package ai.ash.ui.design

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The Kotlin constants follow design/app/tokens.json, the single source of every number the screens use. */
class AshTokensTest {
    private val tokens = JSONObject(listOf("../../design/app/tokens.json", "design/app/tokens.json").map(::File).first { it.exists() }.readText())
    private val colors = tokens.getJSONObject("color")

    private fun camel(k: String) = k.replace(Regex("-(\\w)")) { it.groupValues[1].uppercase() }
    private fun argb(css: String): Int {
        Regex("^#([0-9a-fA-F]{6})$").find(css.trim())?.let { return (0xFF000000L or it.groupValues[1].toLong(16)).toInt() }
        val m = Regex("^rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*(?:,\\s*([\\d.]+))?\\s*\\)$").find(css.trim()) ?: error("colour $css")
        val a = Math.round((m.groupValues[4].ifEmpty { "1" }).toDouble() * 255).toInt()
        return (a shl 24) or (m.groupValues[1].toInt() shl 16) or (m.groupValues[2].toInt() shl 8) or m.groupValues[3].toInt()
    }
    private fun colour(p: AshPalette, key: String): Int {
        val name = camel(key)
        return AshPalette::class.java.getMethod("get" + name.replaceFirstChar { it.uppercase() }).invoke(p) as Int
    }

    @Test fun bothThemesCarryEveryColourOfTheTokens() {
        val fields = AshPalette::class.java.declaredFields.filter { !it.isSynthetic && !java.lang.reflect.Modifier.isStatic(it.modifiers) }.map { it.name }.toSet()
        assertEquals(colors.keys().asSequence().map(::camel).toSet(), fields)
        for (key in colors.keys()) {
            val v = colors.getJSONObject(key)
            assertEquals("$key light", argb(v.getString("light")), colour(AshTokens.light, key))
            assertEquals("$key dark", argb(v.getString("dark")), colour(AshTokens.dark, key))
        }
    }

    @Test fun lightPrimaryIsTheTerracottaThatCarriesWhiteText() {
        assertEquals(0xFFCC4B2E.toInt(), AshTokens.light.you)
        assertEquals(0xFFB8432A.toInt(), AshTokens.light.youPress)
        assertEquals(0xFFFF8A66.toInt(), AshTokens.dark.you)
        // the brighter coral stays for marks with no text on them
        assertEquals(0xFFF2704E.toInt(), AshTokens.light.youMark)
        assertEquals(AshTokens.dark.you, AshTokens.dark.youMark)
    }

    @Test fun nightPicksTheDarkPalette() {
        assertTrue(AshTokens.palette(true) === AshTokens.dark)
        assertTrue(AshTokens.palette(false) === AshTokens.light)
        assertNotEquals(AshTokens.light.bg, AshTokens.dark.bg)
        assertNotEquals(AshTokens.light.ink, AshTokens.dark.ink)
        assertNotEquals(AshTokens.light.surface, AshTokens.dark.surface)
    }

    @Test fun spacingRadiusAndSizeAreTheTokens() {
        val space = tokens.getJSONObject("space"); val radius = tokens.getJSONObject("radius"); val size = tokens.getJSONObject("size")
        assertEquals(space.getInt("pageX"), AshTokens.Space.pageX)
        assertEquals(space.getInt("rowX"), AshTokens.Space.rowX)
        assertEquals(space.getInt("cardGap"), AshTokens.Space.cardGap)
        assertEquals(radius.getInt("card"), AshTokens.Radius.card)
        assertEquals(radius.getInt("sheet"), AshTokens.Radius.sheet)
        assertEquals(radius.getInt("bubble"), AshTokens.Radius.bubble)
        assertEquals(radius.getInt("bubbleTail"), AshTokens.Radius.bubbleTail)
        assertEquals(size.getInt("touch"), AshTokens.Size.touch)
        assertEquals(size.getInt("button"), AshTokens.Size.button)
        assertEquals(size.getInt("listRow"), AshTokens.Size.listRow)
        assertEquals(size.getInt("switchW"), AshTokens.Size.switchW)
        assertEquals(420, AshTokens.Size.glowW)
        assertEquals(320, AshTokens.Size.glowH)
        assertEquals(size.getDouble("stroke").toFloat(), AshTokens.Size.stroke)
        assertTrue("controls are at least 48dp", AshTokens.Size.touch >= 48 && AshTokens.Size.iconButton >= 48)
    }

    @Test fun typeScaleIsTheTokens() {
        val type = tokens.getJSONObject("type")
        for ((name, t) in mapOf("display" to AshTokens.Type.display, "title" to AshTokens.Type.title, "body" to AshTokens.Type.body, "chat" to AshTokens.Type.chat,
            "caption" to AshTokens.Type.caption, "listTitle" to AshTokens.Type.listTitle, "listSub" to AshTokens.Type.listSub, "button" to AshTokens.Type.button)) {
            val v = type.getJSONObject(name)
            assertEquals("$name size", v.getDouble("size").toFloat(), t.sizeSp)
            assertEquals("$name line", v.getDouble("line").toFloat(), t.lineSp)
            assertEquals("$name weight", v.getInt("weight"), t.weight)
        }
    }

    @Test fun motionDurationsAreTheTokens() {
        val m = tokens.getJSONObject("motion")
        assertEquals(m.getLong("message"), AshTokens.Motion.message)
        assertEquals(m.getLong("sheet"), AshTokens.Motion.sheet)
        assertEquals(m.getLong("cardResolve"), AshTokens.Motion.cardResolve)
        assertEquals(m.getLong("spinner"), AshTokens.Motion.spinner)
    }

    @Test fun everyDesignedIconHasAVectorDrawable() {
        val names = File("../../design/app/icons").listFiles { f -> f.extension == "svg" && f.name != "app-icon.svg" }!!.map { it.nameWithoutExtension }
        assertTrue(names.size >= 50)
        for (n in names) assertTrue("ash_ic_$n.xml", File("src/main/res/drawable/ash_ic_$n.xml").isFile)
    }

    @Test fun colourResourcesAndKotlinAgree() {
        for ((dir, p) in listOf("values" to AshTokens.light, "values-night" to AshTokens.dark)) {
            val xml = File("src/main/res/$dir/ash_colors.xml").readText()
            for (key in colors.keys()) {
                val hex = Regex("<color name=\"ash_${key.replace('-', '_')}\">#([0-9A-F]{8})</color>").find(xml)!!.groupValues[1]
                assertEquals("$dir $key", hex.toLong(16).toInt(), colour(p, key))
            }
        }
    }
}
