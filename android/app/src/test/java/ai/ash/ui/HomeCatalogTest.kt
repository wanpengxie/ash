package ai.ash.ui

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeCatalogTest {
    private val catalog = JSONObject("""{"providers":[
      {"id":"deepseek","name":"DeepSeek","ready":true,"auth":{"kind":"key","ref":"DEEPSEEK_API_KEY","configured":true},"models":[
        {"id":"deepseek/deepseek-flash","name":"DeepSeek Flash","context_window":1000000,"images":true,"reasoning":true,"efforts":["off","low","high","max"]},
        {"id":"deepseek/plain","name":"Plain","context_window":128000,"images":false,"reasoning":false,"efforts":[]}]},
      {"id":"openai-codex","name":"OpenAI Codex","ready":false,"auth":{"kind":"login","method":"browser","state":"none"},"models":[]},
      {"id":"pending","name":"P","ready":false,"auth":{"kind":"login","method":"browser","state":"pending"},"models":[]},
      {"id":"openrouter","name":"OpenRouter","ready":false,"auth":{"kind":"key","ref":"OPENROUTER_API_KEY","configured":false},"models":[],"models_hidden":"393 models: ask with provider"}]}""")

    @Test fun providersShowWhetherTheyCanBeUsedAndWhatToDoOtherwise() {
        val p = HomeCatalog.providers(catalog)
        assertEquals(listOf("可用", "还没登录", "正在登录，等你在浏览器里输码", "还没配密钥"), p.map { it.status })
        assertEquals(listOf(null, HomeCatalog.Action.LOGIN, null, HomeCatalog.Action.KEY), p.map { it.action })
        assertEquals(listOf("ok", "warn", "warn", "warn"), p.map { it.tone })
        assertEquals("393 models: ask with provider", p[3].hidden)
    }

    @Test fun aModelShowsWhatItCanDo() {
        val m = HomeCatalog.providers(catalog)[0].models
        assertEquals("上下文 1 M · 能看图 · 会思考", m[0].info)
        assertEquals(listOf("off", "low", "high", "max"), m[0].efforts)
        assertEquals("上下文 128 K", m[1].info)
        assertTrue(m[1].efforts.isEmpty())
        assertEquals("不思考", HomeCatalog.effortLabel("off"))
        assertEquals("最高", HomeCatalog.effortLabel("max"))
        assertEquals("custom", HomeCatalog.effortLabel("custom"))
    }

    @Test fun theSavedEffortIsTheModelsOwnEntryElseTheDeclarations() {
        val saved = JSONObject("""{"kind":"pi","model":"a/b","effort":"low","models":{"c/d":{"effort":"high"}}}""")
        assertEquals("high", HomeCatalog.savedEffort(saved, "c/d"))
        assertEquals("low", HomeCatalog.savedEffort(saved, "a/b"))
        assertNull(HomeCatalog.savedEffort(saved, "x/y"))
        assertNull(HomeCatalog.savedEffort(null, "x/y"))
    }

    private fun same(expected: String, actual: JSONObject) = assertTrue("$actual", JSONObject(expected).similar(actual))

    @Test fun savingSendsTheSameUpdateAnAgentWould() {
        same("""{"agent":"agent:main","runtime":{"model":"deepseek/deepseek-flash","models":{"deepseek/deepseek-flash":{"effort":"high"}}}}""", HomeCatalog.updateBody("agent:main", "deepseek/deepseek-flash", "high"))
        same("""{"agent":"agent:main","runtime":{"model":"a/b"}}""", HomeCatalog.updateBody("agent:main", "a/b", null))
        same("""{"agent":"agent:main","runtime":{"kind":"pi"}}""", HomeCatalog.switchBody("agent:main", "pi"))
    }

    @Test fun theLoginCardTellsTheOwnerToTurnOnTheVpnAndSignIn() {
        val text = HomeCatalog.LOGIN_TEXT
        assertTrue(text.contains("VPN"))
        assertTrue(text.contains("ChatGPT"))
    }
}
