package ai.ash.vscreen;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Looper;
import android.os.Process;
import android.view.Surface;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Privileged virtual-screen server (runs as the shell uid via Shizuku, started by the ash app with
 * {@code CLASSPATH=<ash apk> app_process /system/bin ai.ash.vscreen.Main}).
 *
 * Why a privileged process: a virtual display created by an ordinary app can neither host other apps
 * (startActivity with a launchDisplayId is refused by SafeActivityOptions.checkPermissions) nor render
 * them; the shell identity has neither restriction. No MediaProjection is used (that only mirrors the
 * main screen and needs a consent dialog).
 *
 * Transport: one JSON request per line on stdin, one response per line on stdout prefixed with
 * {@link #REPLY_PREFIX}; responses carry the request "id" (requests may run concurrently).
 * Nothing listens on a port, so no other app can reach this server, and when the ash app dies its end
 * of the pipe closes: the server then destroys the virtual display and exits (no orphan screens, no
 * stale old-version server squatting a port).
 */
public class Main {

    private static final String TAG = "AshVscreen";

    /** Build fingerprint, returned by "ping" (the client and server ship in the same APK). */
    static final String BUILD = "ash-vs1";

    static final String REPLY_PREFIX = "@@ash-vscreen ";
    private static final String LOG_PATH = "/data/local/tmp/ash-vscreen.log";
    private static final long LOG_MAX_BYTES = 512 * 1024;

    /** Frame pump throttle: do not spin when the screen is static; up to ~30 fps when it moves. */
    private static final long PUMP_IDLE_SLEEP_MS = 30;

    private static Context sContext;
    private static PrintStream sReplyOut;

    private static final ConcurrentHashMap<Integer, Session> sSessions = new ConcurrentHashMap<>();
    private static final AtomicInteger sDisplaySeq = new AtomicInteger(0);
    private static volatile int sCurrentDisplayId = -1;

    public static void main(String[] args) {
        // stdout carries the protocol only: anything else printed by the framework goes to stderr.
        sReplyOut = new PrintStream(new FileOutputStream(java.io.FileDescriptor.out), true);
        System.setOut(System.err);

        Looper.prepareMainLooper();
        log("server starting uid=" + Process.myUid() + " sdk=" + Build.VERSION.SDK_INT
                + " brand=" + Build.BRAND + " build=" + BUILD, null);

        try {
            sContext = FakeContext.get();
            log("FakeContext ready (package=" + sContext.getPackageName() + ")", null);
        } catch (Throwable t) {
            log("FakeContext init failed, virtual screens unavailable", t);
        }

        Thread reader = new Thread(new StdinLoop(), "vscreen-stdin");
        reader.setDaemon(true);
        reader.start();

        reply(new JSONObject(), "ready");

        try {
            Looper.loop();
        } catch (Throwable t) {
            log("Looper.loop exited", t);
        }
    }

    // ==================== transport ====================

    /** Reads requests until the app's end of the pipe closes, then cleans up and exits. */
    private static final class StdinLoop implements Runnable {
        @Override
        public void run() {
            try {
                BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
                String line;
                while ((line = in.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty()) {
                        continue;
                    }
                    // Named class instead of a nested anonymous class (d8 once crashed on those here).
                    new Thread(new RequestRunner(line), "vscreen-req").start();
                }
            } catch (Throwable t) {
                log("stdin read failed", t);
            }
            log("host closed the pipe: closing the virtual screen and exiting", null);
            try {
                closeDisplay();
            } catch (Throwable t) {
                log("close on exit failed", t);
            }
            System.exit(0);
        }
    }

    private static final class RequestRunner implements Runnable {
        private final String line;

        RequestRunner(String line) {
            this.line = line;
        }

        @Override
        public void run() {
            Object id = null;
            JSONObject res;
            String op = "?";
            long started = System.currentTimeMillis();
            try {
                JSONObject req = new JSONObject(line);
                id = req.opt("id");
                op = req.optString("op");
                res = dispatch(op, req);
            } catch (Throwable t) {
                log("request failed: " + line, t);
                res = err("server error: " + t);
            }
            if (id != null) {
                try {
                    res.put("id", id);
                } catch (Throwable ignored) {
                }
            }
            long cost = System.currentTimeMillis() - started;
            if (!"see".equals(op) || cost > 1500) {
                log(op + " -> " + summarize(res) + " (" + cost + "ms)", null);
            }
            reply(res, null);
        }
    }

    private static void reply(JSONObject res, String event) {
        try {
            if (event != null) {
                res.put("event", event).put("build", BUILD);
            }
            String s = res.toString();
            synchronized (Main.class) {
                sReplyOut.print(REPLY_PREFIX);
                sReplyOut.print(s);
                sReplyOut.print('\n');
                sReplyOut.flush();
            }
        } catch (Throwable t) {
            log("reply failed", t);
        }
    }

    private static JSONObject dispatch(String op, JSONObject q) throws Exception {
        switch (op) {
            case "ping":
                return ok().put("build", BUILD).put("uid", Process.myUid());
            case "status":
                return status();
            case "create":
                return createDisplay(q.optInt("width", 0), q.optInt("height", 0), q.optInt("dpi", 0));
            case "launch":
                return launchApp(q.optString("component", ""), q.optString("pkg", ""));
            case "see":
                return see(q.optInt("maxSide", 1280), q.optInt("quality", 80));
            case "tap":
                return input("tap", fmt(q.optDouble("x", 0)), fmt(q.optDouble("y", 0)));
            case "swipe":
                return input("swipe", fmt(q.optDouble("x1", 0)), fmt(q.optDouble("y1", 0)),
                        fmt(q.optDouble("x2", 0)), fmt(q.optDouble("y2", 0)),
                        String.valueOf(q.optInt("durationMs", 300)));
            case "key":
                if (q.optBoolean("longPress")) {
                    return input("keyevent", "--longpress", String.valueOf(q.optInt("keycode", 0)));
                }
                return input("keyevent", String.valueOf(q.optInt("keycode", 0)));
            case "text":
                return input("text", q.optString("text", "").replace(" ", "%s"));
            case "close":
                return closeDisplay();
            default:
                return err("unknown op " + op);
        }
    }

    // ==================== session (one virtual display = one ImageReader + frame pump) ====================

    private static final class Session {
        final int displayId;
        final int width;
        final int height;
        final int dpi;
        final VirtualDisplay virtualDisplay;
        final ImageReader reader;

        final Object frameLock = new Object();
        Bitmap frame;             // latest frame (reused; readers copy it under the lock)
        long frameTs;
        volatile boolean pumping = true;
        volatile boolean sawFrame = false;

        Session(int displayId, int width, int height, int dpi, VirtualDisplay vd, ImageReader reader) {
            this.displayId = displayId;
            this.width = width;
            this.height = height;
            this.dpi = dpi;
            this.virtualDisplay = vd;
            this.reader = reader;
        }

        void release() {
            pumping = false;
            synchronized (frameLock) {
                if (frame != null) {
                    frame.recycle();
                    frame = null;
                }
            }
            try {
                virtualDisplay.release();
            } catch (Throwable t) {
                log("virtualDisplay.release failed: " + t.getMessage(), null);
            }
            try {
                reader.close();
            } catch (Throwable t) {
                log("reader.close failed: " + t.getMessage(), null);
            }
        }
    }

    /**
     * Frame pump: keeps calling acquireLatestImage and stores the newest frame.
     * ImageReader only delivers new frames after the previous ones were acquired, so it must be
     * drained continuously; when the screen is static the last frame is served.
     */
    private static void startFramePump(final Session s) {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                int consecutiveNull = 0;
                while (s.pumping) {
                    Image img = null;
                    try {
                        img = s.reader.acquireLatestImage();
                    } catch (Throwable t2) {
                        log("acquireLatestImage failed: " + t2.getMessage(), null);
                    }
                    if (img == null) {
                        consecutiveNull++;
                        try {
                            Thread.sleep(consecutiveNull > 20 ? 60 : PUMP_IDLE_SLEEP_MS);
                        } catch (InterruptedException e) {
                            return;
                        }
                        continue;
                    }
                    consecutiveNull = 0;
                    try {
                        copyImageToSession(s, img);
                        s.sawFrame = true;
                        s.frameTs = System.currentTimeMillis();
                    } catch (Throwable t2) {
                        log("copyImageToSession failed: " + t2.getMessage(), null);
                    } finally {
                        try {
                            img.close();
                        } catch (Throwable ignored) {
                        }
                    }
                }
            }
        }, "vscreen-pump-" + s.displayId);
        t.setDaemon(true);
        t.start();
    }

    private static void copyImageToSession(Session s, Image img) {
        int w = img.getWidth();
        int h = img.getHeight();
        Image.Plane plane = img.getPlanes()[0];
        ByteBuffer buf = plane.getBuffer();
        int pixelStride = plane.getPixelStride();
        int rowStride = plane.getRowStride();
        int rowPadding = rowStride - pixelStride * w;
        buf.rewind();

        synchronized (s.frameLock) {
            // rowStride == pixelStride * width: copy straight into the reused bitmap; otherwise the padded
            // rows would shift the whole image, so decode into a padded-width bitmap and crop.
            if (rowPadding == 0 && pixelStride == 4) {
                if (s.frame == null || s.frame.getWidth() != w || s.frame.getHeight() != h
                        || s.frame.isRecycled()) {
                    if (s.frame != null) {
                        s.frame.recycle();
                    }
                    s.frame = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                }
                s.frame.copyPixelsFromBuffer(buf);
            } else {
                Bitmap padded = Bitmap.createBitmap(w + rowPadding / Math.max(1, pixelStride), h,
                        Bitmap.Config.ARGB_8888);
                padded.copyPixelsFromBuffer(buf);
                Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, w, h);
                padded.recycle();
                if (s.frame != null) {
                    s.frame.recycle();
                }
                s.frame = cropped;
            }
        }
    }

    private static Bitmap snapshotFrame(Session s) {
        synchronized (s.frameLock) {
            if (s.frame == null || s.frame.isRecycled()) {
                return null;
            }
            return s.frame.copy(Bitmap.Config.ARGB_8888, false);
        }
    }

    // ==================== create ====================

    private static int flag(String name) {
        try {
            Field f = DisplayManager.class.getField(name);
            return f.getInt(null);
        } catch (Throwable t) {
            return 0;
        }
    }

    // Sizes are normalized to phone proportions only: 9:16 (portrait) or 16:9 (landscape).
    /** Short edge is a multiple of 144 (= 9 x 16): long edge = short x 16 / 9 is exact and 16-aligned. */
    private static int normalizeShortEdge(int requested) {
        int v = requested > 0 ? requested : 720; // default 720x1280: screenshots need no downscaling
        int units = Math.round(v / 144f);
        if (units < 2) units = 2;   // 288x512
        if (units > 10) units = 10; // 1440x2560
        return units * 144;
    }

    /** width > height means landscape (16:9), otherwise portrait (9:16). */
    private static int[] toPhoneSize(int w, int h) {
        boolean hasRequest = w > 0 || h > 0;
        boolean landscape = hasRequest && w > h;
        int shortReq = 0;
        if (hasRequest) {
            int ww = w > 0 ? w : h;
            int hh = h > 0 ? h : w;
            shortReq = Math.min(ww, hh);
        }
        int shortEdge = normalizeShortEdge(shortReq);
        int longEdge = shortEdge * 16 / 9;
        return landscape ? new int[]{longEdge, shortEdge} : new int[]{shortEdge, longEdge};
    }

    private static synchronized JSONObject createDisplay(int reqW, int reqH, int reqDpi) throws Exception {
        if (sContext == null) {
            return err("the privileged process could not build a Context (FakeContext failed)");
        }
        int[] phone = toPhoneSize(reqW, reqH);
        int w = phone[0];
        int h = phone[1];
        int d = reqDpi > 0 ? reqDpi : 320;
        Session cur = currentSession();
        if (cur != null) {
            if (w == cur.width && h == cur.height && d == cur.dpi) {
                return describe(cur).put("reused", true);
            }
            // Size/orientation changed: recreate (otherwise a rotation request is silently ignored).
            log("create " + w + "x" + h + " differs from " + cur.width + "x" + cur.height + ": recreating", null);
            sCurrentDisplayId = -1;
            Session old = sSessions.remove(cur.displayId);
            if (old != null) {
                old.release();
            }
        }

        int flags = flag("VIRTUAL_DISPLAY_FLAG_PUBLIC")
                | flag("VIRTUAL_DISPLAY_FLAG_PRESENTATION")
                | flag("VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY")
                | flag("VIRTUAL_DISPLAY_FLAG_SUPPORTS_TOUCH")
                | flag("VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT")
                | flag("VIRTUAL_DISPLAY_FLAG_DESTROY_CONTENT_ON_REMOVAL");
        if (Build.VERSION.SDK_INT >= 33) {
            flags |= flag("VIRTUAL_DISPLAY_FLAG_TRUSTED")
                    | flag("VIRTUAL_DISPLAY_FLAG_OWN_DISPLAY_GROUP")
                    | flag("VIRTUAL_DISPLAY_FLAG_ALWAYS_UNLOCKED")
                    | flag("VIRTUAL_DISPLAY_FLAG_TOUCH_FEEDBACK_DISABLED");
        }
        if (Build.VERSION.SDK_INT >= 34) {
            flags |= flag("VIRTUAL_DISPLAY_FLAG_OWN_FOCUS")
                    | flag("VIRTUAL_DISPLAY_FLAG_DEVICE_DISPLAY_GROUP");
        }

        ImageReader reader = null;
        try {
            reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
            Surface surface = reader.getSurface();

            Constructor<DisplayManager> ctor = DisplayManager.class.getDeclaredConstructor(Context.class);
            ctor.setAccessible(true);
            DisplayManager dm = ctor.newInstance(sContext);

            String name = "AshVscreen-" + sDisplaySeq.incrementAndGet();
            VirtualDisplay vd = dm.createVirtualDisplay(name, w, h, d, surface, flags);
            if (vd == null || vd.getDisplay() == null) {
                reader.close();
                return err("createVirtualDisplay returned no display");
            }
            int id = vd.getDisplay().getDisplayId();

            Session s = new Session(id, w, h, d, vd, reader);
            sSessions.put(id, s);
            sCurrentDisplayId = id;
            startFramePump(s);
            log("created displayId=" + id + " " + w + "x" + h + " dpi=" + d
                    + " flags=0x" + Integer.toHexString(flags), null);
            return describe(s);
        } catch (Throwable t) {
            if (reader != null) {
                try {
                    reader.close();
                } catch (Throwable ignored) {
                }
            }
            log("create failed", t);
            return err("could not create the virtual display: " + t);
        }
    }

    private static synchronized JSONObject closeDisplay() throws Exception {
        int id = sCurrentDisplayId;
        sCurrentDisplayId = -1;
        Session s = id >= 0 ? sSessions.remove(id) : null;
        if (s != null) {
            s.release();
            log("released displayId=" + id, null);
        }
        return ok().put("closed", id);
    }

    private static Session currentSession() {
        int id = sCurrentDisplayId;
        return id >= 0 ? sSessions.get(id) : null;
    }

    private static JSONObject describe(Session s) throws Exception {
        return ok().put("displayId", s.displayId).put("width", s.width).put("height", s.height)
                .put("dpi", s.dpi).put("hasFrame", s.sawFrame);
    }

    // ==================== launch ====================

    /** Runs a command without a shell; returns [exit code, combined output]. */
    private static Object[] execCapture(String... cmd) {
        try {
            java.lang.Process p = Runtime.getRuntime().exec(cmd);
            p.getOutputStream().close();
            StringBuilder sb = new StringBuilder();
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line).append('\n');
            }
            r = new BufferedReader(new InputStreamReader(p.getErrorStream()));
            while ((line = r.readLine()) != null) {
                sb.append(line).append('\n');
            }
            int code = p.waitFor();
            return new Object[]{code, sb.toString().trim()};
        } catch (Throwable t) {
            return new Object[]{-1, "exec failed: " + t};
        }
    }

    /** Resolves the launcher component of a package with the package manager shell command. */
    private static String resolveComponent(String pkg) {
        Object[] r = execCapture("/system/bin/cmd", "package", "resolve-activity", "--brief",
                "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", pkg);
        String component = null;
        for (String line : ((String) r[1]).split("\n")) {
            line = line.trim();
            if (line.contains("/") && line.startsWith(pkg)) {
                component = line;
            }
        }
        return component;
    }

    private static JSONObject launchApp(String component, String pkg) throws Exception {
        Session s = currentSession();
        if (s == null) {
            return err("no virtual screen: call create first");
        }
        component = component == null ? "" : component.trim();
        pkg = pkg == null ? "" : pkg.trim();
        if (component.isEmpty()) {
            if (pkg.isEmpty()) {
                return err("component or pkg is required");
            }
            // am start needs a component (-p fails to resolve on Android 15, tested).
            component = resolveComponent(pkg);
            if (component == null) {
                return err("cannot resolve a launcher activity for " + pkg);
            }
        }
        List<String> cmd = new ArrayList<>();
        cmd.add("/system/bin/am");
        cmd.add("start");
        cmd.add("--display");
        cmd.add(String.valueOf(s.displayId));
        cmd.add("-n");
        cmd.add(component);
        Object[] r = execCapture(cmd.toArray(new String[0]));
        String out = (String) r[1];
        log("launch " + component + " on " + s.displayId + " : exit=" + r[0] + " " + out, null);
        if ((Integer) r[0] != 0 || out.contains("Error:") || out.contains("Exception")) {
            return err("am start failed: " + out.replace("\n", " "));
        }
        String warning = out.contains("Warning:") ? out.replace("\n", " ") : null;
        JSONObject res = ok().put("component", component).put("displayId", s.displayId);
        if (warning != null) {
            res.put("warning", warning);
        }
        return res;
    }

    // ==================== screenshot ====================

    private static JSONObject see(int maxSide, int quality) throws Exception {
        Session s = currentSession();
        if (s == null) {
            return err("no virtual screen: call create first");
        }
        Bitmap bmp = snapshotFrame(s);
        if (bmp == null) {
            return err("the virtual screen has no frame yet (nothing rendered since it was created)");
        }
        Bitmap scaled = null;
        try {
            int bw = bmp.getWidth();
            int bh = bmp.getHeight();
            int limit = maxSide > 0 ? maxSide : 1280;
            float k = Math.min(1f, limit / (float) Math.max(bw, bh));
            int iw = Math.max(1, Math.round(bw * k));
            int ih = Math.max(1, Math.round(bh * k));
            scaled = (iw == bw && ih == bh) ? bmp : Bitmap.createScaledBitmap(bmp, iw, ih, true);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            scaled.compress(Bitmap.CompressFormat.JPEG, Math.max(30, Math.min(95, quality)), bos);
            String b64 = android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
            return ok().put("jpeg", b64).put("displayId", s.displayId)
                    .put("screenW", s.width).put("screenH", s.height)
                    .put("imageW", iw).put("imageH", ih)
                    .put("frameAgeMs", System.currentTimeMillis() - s.frameTs);
        } finally {
            if (scaled != null && scaled != bmp) {
                scaled.recycle();
            }
            bmp.recycle();
        }
    }

    // ==================== input ====================

    private static JSONObject input(String action, String... args) throws Exception {
        Session s = currentSession();
        if (s == null) {
            return err("no virtual screen: call create first");
        }
        String[] cmd = new String[4 + args.length];
        cmd[0] = "/system/bin/input";
        cmd[1] = "-d";
        cmd[2] = String.valueOf(s.displayId);
        cmd[3] = action;
        System.arraycopy(args, 0, cmd, 4, args.length);
        Object[] r = execCapture(cmd);
        if ((Integer) r[0] != 0) {
            log("input " + action + " failed: " + r[1], null);
            return err("input " + action + " failed: " + ((String) r[1]).replace("\n", " "));
        }
        return ok();
    }

    private static JSONObject status() throws Exception {
        Session s = currentSession();
        if (s == null) {
            return ok().put("displayId", -1).put("running", false).put("build", BUILD);
        }
        return describe(s).put("running", true).put("build", BUILD);
    }

    // ==================== helpers ====================

    private static String summarize(JSONObject res) {
        String body = res.has("jpeg") ? "{image}" : res.toString();
        return body.length() > 200 ? body.substring(0, 200) + "..." : body;
    }

    private static String fmt(double f) {
        if (f == Math.rint(f)) {
            return String.valueOf((long) f);
        }
        return String.valueOf((float) f);
    }

    private static JSONObject ok() throws Exception {
        return new JSONObject().put("ok", true);
    }

    private static JSONObject err(String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false).put("error", msg);
        } catch (Throwable ignored) {
        }
        return o;
    }

    // ==================== log ====================

    static void logToFile(String msg, Throwable t) {
        log(msg, t);
    }

    static void log(String msg, Throwable t) {
        String stamp = new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US).format(new Date());
        StringBuilder sb = new StringBuilder();
        sb.append(stamp).append(' ').append(msg);
        if (t != null) {
            sb.append(" | ").append(t.getClass().getSimpleName()).append(": ").append(t.getMessage());
            StackTraceElement[] st = t.getStackTrace();
            for (int i = 0; i < Math.min(6, st.length); i++) {
                sb.append("\n    at ").append(st[i]);
            }
        }
        System.err.println(TAG + ": " + sb);
        try {
            File f = new File(LOG_PATH);
            boolean append = !f.exists() || f.length() < LOG_MAX_BYTES;
            FileOutputStream fos = new FileOutputStream(f, append);
            fos.write((TAG + ": " + sb + "\n").getBytes("UTF-8"));
            fos.flush();
            fos.close();
        } catch (Throwable ignored) {
        }
    }
}
