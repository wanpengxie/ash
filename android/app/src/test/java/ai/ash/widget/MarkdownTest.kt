package ai.ash.widget

import org.junit.Assert.*
import org.junit.Test

class MarkdownTest {
    private fun md(s: String) = Markdown.parse(s)

    @Test fun inlineMarksBecomeFormattingNotText() {
        val t = md("**重要**：明天 *9 点* 开会，带 `PPT`，~~取消~~ 见[日程](https://x.y/z)")
        assertEquals("重要：明天 9 点 开会，带 PPT，取消 见日程", t.text)
        assertTrue(t.spans.contains(Span(0, 2, Mark.BOLD)))
        assertTrue(t.spans.contains(Span(6, 9, Mark.ITALIC)))
        assertTrue(t.spans.contains(Span(15, 18, Mark.CODE)))
        assertTrue(t.spans.contains(Span(19, 21, Mark.STRIKE)))
        assertTrue(t.spans.contains(Span(23, 25, Mark.LINK)))
    }

    @Test fun nestedAndUnderscoreForms() {
        assertEquals("a b c", md("*a **b** c*").text)
        assertTrue(md("*a **b** c*").spans.containsAll(listOf(Span(0, 5, Mark.ITALIC), Span(2, 3, Mark.BOLD))))
        assertEquals("bold", md("__bold__").text)
        assertEquals("snake_case_name", md("snake_case_name").text)
        assertEquals("下_划_线", md("下_划_线").text)
    }

    @Test fun linesHeadingsListsQuotesAndTasks() {
        val t = md("# 标题\n- 一\n* 二\n> 引用\n- [x] 完成\n- [ ] 待办\n1. 第一\n---\n普通")
        assertEquals("标题\n• 一\n• 二\n引用\n☑ 完成\n☐ 待办\n1. 第一\n──────\n普通", t.text)
        assertTrue(t.spans.contains(Span(0, 2, Mark.HEADING, 1)))
        assertTrue(t.spans.any { it.mark == Mark.QUOTE })
    }

    @Test fun strayMarksAreDroppedButArithmeticStays() {
        assertEquals("重要的事", md("**重要的事").text)
        assertEquals("5 * 3 = 15", md("5 * 3 = 15").text)
        assertEquals("a*b", md("a\\*b").text)
        assertEquals("代码", md("```\n代码\n```").text)
        assertEquals("emoji 🎉 ✅", md("emoji 🎉 ✅").text)
    }
}
