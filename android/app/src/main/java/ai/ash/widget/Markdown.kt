package ai.ash.widget

/** One formatting run over [start, end) of a [Styled] text. */
data class Span(val start: Int, val end: Int, val mark: Mark, val level: Int = 0)

enum class Mark { BOLD, ITALIC, CODE, STRIKE, UNDERLINE, LINK, HEADING, QUOTE, MEDIUM, LIGHT }

/** Text with its formatting, before it becomes an Android Spannable. */
data class Styled(val text: String, val spans: List<Span> = emptyList()) {
    fun whole(mark: Mark): Styled = if (text.isEmpty()) this else Styled(text, listOf(Span(0, text.length, mark)) + spans)
}

/**
 * Simple Markdown (what A2UI allows in Text, and what replies are written in) to formatted text: **bold**, *italic*,
 * `code`, ~~strike~~, [links](url), # headings, > quotes, - lists and [ ] tasks. Formatting is drawn, never shown as
 * marks; a stray ** or ` that closes nothing is dropped instead of printed.
 */
object Markdown {
    private const val PUNCT = "\\`*_{}[]()#+-.!~>|"

    fun parse(src: String): Styled {
        val out = StringBuilder()
        val spans = ArrayList<Span>()
        var fence = false
        val lines = src.replace("\r\n", "\n").split('\n')
        for ((n, raw) in lines.withIndex()) {
            if (raw.trimStart().startsWith("```")) { fence = !fence; continue }
            if (out.isNotEmpty() || n > 0 && out.isNotEmpty()) out.append('\n')
            if (fence) {
                val start = out.length
                out.append(raw)
                if (out.length > start) spans.add(Span(start, out.length, Mark.CODE))
                continue
            }
            var line = raw
            val start = out.length
            val heading = Regex("^(#{1,6})\\s+(.*?)\\s*#*\\s*$").find(line)
            val quote = Regex("^\\s*>\\s?(.*)$").find(line)
            when {
                heading != null -> {
                    inline(heading.groupValues[2], out, spans)
                    if (out.length > start) spans.add(Span(start, out.length, Mark.HEADING, heading.groupValues[1].length))
                    continue
                }
                Regex("^\\s*([-*_])(\\s*\\1){2,}\\s*$").matches(line) -> { out.append("──────"); continue }
                quote != null -> {
                    inline(quote.groupValues[1], out, spans)
                    if (out.length > start) spans.add(Span(start, out.length, Mark.QUOTE))
                    continue
                }
            }
            Regex("^(\\s*)[-*+]\\s+\\[([ xX])]\\s+").find(line)?.let { m ->
                out.append(m.groupValues[1]).append(if (m.groupValues[2] == " ") "☐ " else "☑ ")
                line = line.substring(m.range.last + 1)
            } ?: Regex("^(\\s*)[-*+]\\s+").find(line)?.let { m ->
                out.append(m.groupValues[1]).append("• ")
                line = line.substring(m.range.last + 1)
            }
            inline(line, out, spans)
        }
        return Styled(out.toString(), spans.sortedWith(compareBy({ it.start }, { -it.end })))
    }

    private fun inline(s: String, out: StringBuilder, spans: MutableList<Span>) {
        var i = 0
        while (i < s.length) {
            val ch = s[i]
            if (ch == '\\' && i + 1 < s.length && s[i + 1] in PUNCT) { out.append(s[i + 1]); i += 2; continue }
            if (ch == '`') {
                val ticks = s.substring(i).takeWhile { it == '`' }.length
                val end = s.indexOf("`".repeat(ticks), i + ticks)
                if (end > i + ticks - 1 && end >= 0) {
                    val start = out.length
                    out.append(s.substring(i + ticks, end).trim())
                    if (out.length > start) spans.add(Span(start, out.length, Mark.CODE))
                    i = end + ticks
                } else i += ticks // a stray backtick is dropped
                continue
            }
            if (ch == '!' && s.startsWith("![", i)) {
                val link = link(s, i + 1)
                if (link != null) { out.append(link.first); i = link.second; continue }
            }
            if (ch == '[') {
                val link = link(s, i)
                if (link != null) {
                    val start = out.length
                    inline(link.first, out, spans)
                    if (out.length > start) spans.add(Span(start, out.length, Mark.LINK))
                    i = link.second
                    continue
                }
            }
            if (ch == '<') {
                val end = s.indexOf('>', i)
                if (end > i && Regex("^(https?://|mailto:)[^\\s<>]+$").matches(s.substring(i + 1, end))) {
                    val start = out.length
                    out.append(s, i + 1, end)
                    spans.add(Span(start, out.length, Mark.LINK))
                    i = end + 1
                    continue
                }
            }
            val pair = when {
                s.startsWith("**", i) -> "**" to Mark.BOLD
                s.startsWith("__", i) && boundary(s, i) -> "__" to Mark.BOLD
                s.startsWith("~~", i) -> "~~" to Mark.STRIKE
                ch == '*' -> "*" to Mark.ITALIC
                ch == '_' && boundary(s, i) -> "_" to Mark.ITALIC
                else -> null
            }
            if (pair != null) {
                val (marker, mark) = pair
                val close = closer(s, i + marker.length, marker)
                if (close != null) {
                    val start = out.length
                    inline(s.substring(i + marker.length, close), out, spans)
                    if (out.length > start) spans.add(Span(start, out.length, mark))
                    i = close + marker.length
                    continue
                }
                // A double mark that closes nothing is a leftover, not text; a lone * stays (5 * 3).
                if (marker.length == 2) { i += 2; continue }
            }
            out.append(ch)
            i++
        }
    }

    private fun boundary(s: String, i: Int) = i == 0 || !s[i - 1].isLetterOrDigit()

    /** Where [marker] opened at [from] closes, or null; the content may not start or end with a space. */
    private fun closer(s: String, from: Int, marker: String): Int? {
        if (from >= s.length || s[from].isWhitespace()) return null
        var j = from
        while (j < s.length) {
            if (s[j] == '\\') { j += 2; continue }
            if (s[j] == '`') { val end = s.indexOf('`', j + 1); if (end > 0) { j = end + 1; continue } }
            // Inside *...*, a **...** pair is skipped as a whole.
            if (marker.length == 1 && s.startsWith(marker + marker, j)) {
                val inner = s.indexOf(marker + marker, j + 2)
                j = if (inner > 0) inner + 2 else j + 2
                continue
            }
            if (s.startsWith(marker, j) && j > from && !s[j - 1].isWhitespace()) {
                if (marker == "_" && j + 1 < s.length && s[j + 1].isLetterOrDigit()) { j++; continue }
                return j
            }
            j++
        }
        return null
    }

    /** [text](url) starting at [i] ('['): the text and the index after ')'. */
    private fun link(s: String, i: Int): Pair<String, Int>? {
        if (i >= s.length || s[i] != '[') return null
        var depth = 0
        var j = i
        while (j < s.length) {
            if (s[j] == '[') depth++
            if (s[j] == ']' && --depth == 0) break
            j++
        }
        if (j >= s.length - 1 || s[j + 1] != '(') return null
        val end = s.indexOf(')', j + 2)
        if (end < 0) return null
        return s.substring(i + 1, j) to end + 1
    }
}
