package ai.ash.apps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SandboxTest {
    @Test fun defaultCspIsTheSpecsRestrictiveOne() {
        val h = Csp(emptyList(), emptyList()).header()
        assertTrue(h.startsWith("default-src 'none'; "))
        assertTrue(h.contains("script-src 'self' 'unsafe-inline';"))
        assertTrue(h.contains("connect-src 'none';"))
        assertTrue(h.contains("img-src 'self' data:;"))
        assertTrue(h.contains("frame-src 'none'"))
        assertTrue(h.contains("object-src 'none'"))
        assertFalse(h.contains("unsafe-eval"))
    }

    @Test fun declaredDomainsOpenOnlyTheirDirectives() {
        val h = Csp(listOf("https://api.example.com"), listOf("https://cdn.example.com/")).header()
        assertTrue(h.contains("connect-src https://api.example.com;"))
        assertTrue(h.contains("script-src 'self' 'unsafe-inline' https://cdn.example.com;"))
        assertTrue(h.contains("img-src 'self' data: https://cdn.example.com;"))
        assertFalse(h.contains("connect-src https://cdn"))
    }

    @Test fun injectedSourcesAreDropped() {
        val c = Csp(listOf("*", "'unsafe-eval'", "https://a.com; script-src *", "http://plain.com", "https://ok.com", "data:", "https://x.com/path", "https://*.good.org:8443"),
            listOf("https://a.com\" onload=\"x", "wss://live.example.com"))
        assertEquals(listOf("https://ok.com", "https://*.good.org:8443"), c.connect)
        assertEquals(listOf("wss://live.example.com"), c.resource)
        assertFalse(c.meta().contains("onload"))
    }

    @Test fun requestsOnlyToDeclaredOrigins() {
        val c = Csp(listOf("https://api.example.com", "https://*.good.org"), emptyList())
        assertTrue(c.allows("https://api.example.com/v1?q=1"))
        assertTrue(c.allows("wss://api.example.com/live"))
        assertTrue(c.allows("https://a.b.good.org/x"))
        assertFalse(c.allows("https://good.org/x"))
        assertFalse(c.allows("https://api.example.com.evil.com/"))
        assertFalse(c.allows("http://api.example.com/"))
        assertFalse(c.allows("https://api.example.com:8443/"))
        assertFalse(c.allows("https://user@api.example.com/"))
        assertFalse(Csp(emptyList(), emptyList()).allows("https://api.example.com/"))
    }

    @Test fun pageGetsCspAndShimBeforeItsOwnMarkup() {
        val page = HostPage.build("<!DOCTYPE html><html><head><script>app()</script></head><body></body></html>", Csp(emptyList(), emptyList()), "tok_12345678")
        assertTrue(page.startsWith("<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\""))
        assertTrue(page.indexOf("tok_12345678") < page.indexOf("app()"))
        assertTrue(page.indexOf("Content-Security-Policy") < page.indexOf("<script>"))
        val bare = HostPage.build("﻿<p>hi</p>", Csp(emptyList(), emptyList()), "tok_12345678")
        assertTrue(bare.startsWith("<meta http-equiv"))
        assertTrue(bare.endsWith("<p>hi</p>"))
    }

    @Test fun appIdsLinksAndOrigins() {
        assertTrue(AppIds.valid("health"))
        assertTrue(AppIds.valid("com.example.notes"))
        assertFalse(AppIds.valid("Health"))
        assertFalse(AppIds.valid("a..b"))
        assertFalse(AppIds.valid("-a"))
        assertFalse(AppIds.valid("a/b"))
        assertFalse(AppIds.valid(""))
        assertEquals("https://com.example.notes.ash-app.invalid", AppIds.origin("com.example.notes"))
        assertEquals("ash-app://open?app=health", AppIds.link("health"))
        assertEquals("health", AppIds.fromLink("ash-app://open?app=health"))
        assertEquals("health", AppIds.fromLink("ash-app://open/?app=health&x=1"))
        assertNull(AppIds.fromLink("ash-app://other?app=health"))
        assertNull(AppIds.fromLink("https://open?app=health"))
        assertNull(AppIds.fromLink("ash-app://open?app=health&app=bank"))
        assertNull(AppIds.fromLink("ash-app://open?app=..%2Fx"))
        assertNull(AppIds.fromLink("ash-app://open"))
        assertNull(AppIds.fromLink(null))
    }

    @Test fun appListSkipsWhatItCannotOpen() {
        val apps = AppInfo.list("""[{"id":"health","name":"健康","summary":"s","surfaces":[{"id":"home","title":"今日"},{"id":"../x"}],"enabled":true,"granted":true},
            {"id":"Bad/Id","name":"x"},{"id":"notes","enabled":true,"granted":false}]""")
        assertEquals(listOf("health", "notes"), apps.map { it.id })
        assertEquals(listOf("home" to "今日"), apps[0].surfaces)
        assertTrue(apps[0].usable)
        assertFalse(apps[1].usable)
        assertEquals("notes", apps[1].name)
    }
}
