package com.deepseek.harness;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;

/**
 * 原生层到本机 DSH 引擎的主 Agent 通道。
 *
 * - 认证：DSH 0.1.5 起 /api 要求会话 cookie。引擎启动时打印一行
 *   "dsh web: http://127.0.0.1:<port>/?token=…"（每个引擎进程一个 token），
 *   带 token 访问首页返回 303 + Set-Cookie。这里从 dsh-web.log 捞出 token，
 *   换成 cookie 后缓存；token 变了（引擎重启）或 401 时重新换。
 * - 主会话：ash 只有一个常驻主 Agent 会话，id 存在 prefs；后台任务、定时任务
 *   都投递到它，不再每次新建会话。会话失效时重建一次。
 * - 协议（DSH 0.1.7 Remote 网关）：POST /api/<namespace>/<method>，信封
 *   {"type":"client-request","rpcId","method":"<namespace>/<method>","payload":{"args":{<wire>:…}}}，
 *   返回 {"type":"server-response","rpcId","result":{"ok":true,"value":…}}。
 *   上游沿用的 /api/session.create 在 0.1.7 已是 404。
 */
final class AshAgent {
    private static final String TAG = "AshAgent";
    private static final String PREFS = "dsh_prefs";
    /** v2：主会话从 cwd=/ 改为家目录 ash-home，旧的 v1 会话不再复用。 */
    private static final String KEY_MAIN_SESSION = "ash_main_session_v2";
    private static final String DEFAULT_AGENTS_MD =
            "# Ash\n\n"
            + "你是 Ash，常驻在用户这台安卓手机上的个人助理 Agent，运行在 DeepSeek Harness（DSH）之上。\n\n"
            + "- 你只服务这台手机的主人。回答简洁，默认用中文。\n"
            + "- 当前工作目录是你的家目录，重启后仍在；需要长期记住的事写进这里的 MEMORY.md，下次先读它。\n"
            + "- 能用手机相关工具（通知、剪贴板、定时任务、读屏等）直接完成的事就直接做；"
            + "涉及发消息、删除、安装、付款等不可逆操作，先向主人确认。\n";

    private static String cookie;
    private static String cookieToken;

    private AshAgent() {}

    static int port(Context ctx) {
        return Ash.is(ctx.getPackageName()) ? Ash.ENGINE_PORT : 3080;
    }

    /** 从引擎日志尾部取最近一次打印的 token URL（找不到返回 null）。 */
    static String tokenUrl(Context ctx) {
        File f = new File(ctx.getFilesDir(), "dsh-web.log");
        if (!f.exists()) return null;
        RandomAccessFile raf = null;
        try {
            raf = new RandomAccessFile(f, "r");
            long len = raf.length();
            long from = Math.max(0, len - 256 * 1024);
            byte[] buf = new byte[(int) (len - from)];
            raf.seek(from);
            raf.readFully(buf);
            String tail = new String(buf, "UTF-8");
            String prefix = "http://127.0.0.1:" + port(ctx) + "/?token=";
            int at = tail.lastIndexOf(prefix);
            if (at < 0) return null;
            int end = at + prefix.length();
            while (end < tail.length() && " \r\n\t)".indexOf(tail.charAt(end)) < 0) end++;
            return tail.substring(at, end);
        } catch (Throwable t) {
            return null;
        } finally {
            try { if (raf != null) raf.close(); } catch (Throwable ignored) {}
        }
    }

    /**
     * 当前引擎进程的会话 cookie（带缓存）。
     *
     * token 是一次性的：原生层先换到 cookie，就写进 WebView 的 cookie 罐，WebView 不带 token
     * 直接加载即可（见 {@link #webHomeReady}）；WebView 先用掉了 token，原生层就从同一个罐里读。
     */
    static synchronized String authCookie(Context ctx, boolean force) {
        String url = tokenUrl(ctx);
        if (url == null) return null;
        if (!force && cookie != null && url.equals(cookieToken)) return cookie;
        String base = "http://127.0.0.1:" + port(ctx);
        List<String> setCookies = exchange(url);
        if (setCookies != null && !setCookies.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            for (String v : setCookies) {
                int semi = v.indexOf(';');
                if (sb.length() > 0) sb.append("; ");
                sb.append(semi >= 0 ? v.substring(0, semi) : v);
                try { android.webkit.CookieManager.getInstance().setCookie(base, v); } catch (Throwable ignored) {}
            }
            try { android.webkit.CookieManager.getInstance().flush(); } catch (Throwable ignored) {}
            cookie = sb.toString();
        } else {
            String jar = null;
            try { jar = android.webkit.CookieManager.getInstance().getCookie(base); } catch (Throwable ignored) {}
            if (jar == null || jar.isEmpty() || (force && jar.equals(cookie))) return null;
            cookie = jar;
        }
        cookieToken = url;
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("ash_cookie_token", url).apply();
        return cookie;
    }

    /** 带 token 访问首页，返回 Set-Cookie 列表（token 已被用掉等失败情况返回 null）。 */
    private static List<String> exchange(String tokenUrl) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(tokenUrl).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setConnectTimeout(3000);
            c.setReadTimeout(5000);
            int code = c.getResponseCode();
            if (code != 302 && code != 303) return null;
            for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                if (e.getKey() != null && "set-cookie".equalsIgnoreCase(e.getKey())) return e.getValue();
            }
            return null;
        } catch (Throwable t) {
            Log.w(TAG, "token exchange failed", t);
            return null;
        } finally {
            try { if (c != null) c.disconnect(); } catch (Throwable ignored) {}
        }
    }

    /** WebView 能否不带 token 直接进首页：cookie 罐里已有当前引擎进程的会话 cookie。 */
    static boolean webHomeReady(Context ctx) {
        String url = tokenUrl(ctx);
        if (url == null) return false;
        String marked = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("ash_cookie_token", null);
        if (!url.equals(marked)) return false;
        try {
            String jar = android.webkit.CookieManager.getInstance().getCookie("http://127.0.0.1:" + port(ctx));
            return jar != null && !jar.isEmpty();
        } catch (Throwable t) {
            return false;
        }
    }

    /** DSH Remote 调用：endpoint 形如 "session/create"，argsJson 是按 wire 名组织的参数对象。失败返回 null。 */
    static String rpc(Context ctx, String endpoint, String argsJson) {
        for (int attempt = 0; attempt < 2; attempt++) {
            String ck = authCookie(ctx, attempt > 0);
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL("http://127.0.0.1:" + port(ctx) + "/api/" + endpoint).openConnection();
                c.setRequestMethod("POST");
                c.setRequestProperty("Content-Type", "application/json");
                if (ck != null) c.setRequestProperty("Cookie", ck);
                c.setDoOutput(true);
                c.setConnectTimeout(3000);
                c.setReadTimeout(60000);   // 冷启动后第一次建会话可能要几十秒
                String body = "{\"type\":\"client-request\",\"rpcId\":\"ash-" + System.currentTimeMillis()
                        + "\",\"method\":\"" + endpoint + "\",\"payload\":{\"args\":"
                        + (argsJson == null || argsJson.isEmpty() ? "{}" : argsJson) + "}}";
                c.getOutputStream().write(body.getBytes("UTF-8"));
                int code = c.getResponseCode();
                String resp = readAll(code < 400 ? c.getInputStream() : c.getErrorStream());
                if (code == 401 || code == 403) {
                    Log.w(TAG, "rpc " + endpoint + " -> " + code + ", re-auth");
                    continue;
                }
                if (code >= 200 && code < 300) return resp;
                Log.w(TAG, "rpc " + endpoint + " -> " + code + ": " + clip(resp));
                return null;
            } catch (Throwable t) {
                Log.w(TAG, "rpc " + endpoint + " error", t);
                return null;
            } finally {
                try { if (c != null) c.disconnect(); } catch (Throwable ignored) {}
            }
        }
        return null;
    }

    /** 主会话 id：有就复用，没有就建一个。 */
    static synchronized String mainSession(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String sid = p.getString(KEY_MAIN_SESSION, null);
        if (sid != null) return sid;
        String json = rpc(ctx, "session/create", "{\"request\":{\"cwd\":\"" + escapeJson(home(ctx).getAbsolutePath()) + "\"}}");
        sid = ok(json) ? field(json, "sessionId") : null;
        if (sid != null) {
            p.edit().putString(KEY_MAIN_SESSION, sid).apply();
            Log.i(TAG, "main session created: " + sid);
            rpc(ctx, "session/rename", "{\"request\":{\"sessionId\":\"" + sid + "\",\"title\":\"Ash 主 Agent\"}}");
        } else {
            Log.w(TAG, "session/create failed: " + clip(json));
        }
        return sid;
    }

    /** 主 Agent 的家目录（files/ash-home）：会话工作目录，放 AGENTS.md 与它自己的笔记。 */
    static File home(Context ctx) {
        File home = new File(ctx.getFilesDir(), "ash-home");
        if (!home.exists()) home.mkdirs();
        File agents = new File(home, "AGENTS.md");
        if (!agents.exists()) {
            try {
                java.io.FileOutputStream out = new java.io.FileOutputStream(agents);
                out.write(DEFAULT_AGENTS_MD.getBytes("UTF-8"));
                out.close();
            } catch (Throwable t) {
                Log.w(TAG, "write AGENTS.md failed", t);
            }
        }
        return home;
    }

    /** 往主会话投递一条用户消息（排队模式）。会话失效时重建一次。 */
    static boolean prompt(Context ctx, String text) {
        for (int attempt = 0; attempt < 2; attempt++) {
            String sid = mainSession(ctx);
            if (sid == null) return false;
            String args = "{\"request\":{\"requestId\":\"ash-" + System.currentTimeMillis() + "\",\"sessionId\":\"" + sid
                    + "\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"" + escapeJson(text) + "\"}]}}";
            String json = rpc(ctx, "session/prompt", args);
            if (ok(json)) return true;
            if (json == null) return false;   // 传输失败：别把好好的主会话丢掉
            Log.w(TAG, "session/prompt rejected, recreating main session: " + clip(json));
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_MAIN_SESSION).apply();
        }
        return false;
    }

    private static boolean ok(String json) {
        return json != null && json.replace(" ", "").contains("\"ok\":true");
    }

    private static String field(String json, String name) {
        if (json == null) return null;
        String key = "\"" + name + "\":\"";
        int i = json.indexOf(key);
        if (i < 0) return null;
        int q1 = i + key.length();
        int q2 = json.indexOf('"', q1);
        return q2 > q1 ? json.substring(q1, q2) : null;
    }

    private static String readAll(InputStream in) {
        if (in == null) return "";
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
            in.close();
            return new String(out.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            return "";
        }
    }

    static String escapeJson(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    private static String clip(String s) {
        if (s == null) return "null";
        s = s.replace("\n", " ");
        return s.length() > 300 ? s.substring(0, 300) : s;
    }
}
