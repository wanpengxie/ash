package com.deepseek.harness;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * 前台常驻服务：ash 主 Agent 的宿主。
 *
 * 上游只用它挂一条常驻通知；ash 让它真正负责引擎存活：
 *   - 巡检线程每 20 秒看一次引擎端口，引擎没在跑就按 {@link #saveLaunchSpec} 记下的
 *     参数重拉（Activity 不在、进程被杀后 START_STICKY 重建、开机自启都走这里）；
 *   - 引擎就绪后确保主会话存在（{@link AshAgent#mainSession}），通知栏显示主 Agent 状态；
 *   - 用户在控制台点「停止」会写 {@link #KEY_STOPPED}，巡检不再拉起，直到下次启动。
 *
 * 生命周期：
 *   - MainActivity.startEngine / BootReceiver / AlarmReceiver 拉起
 *   - 用户主动「退出」时由 MainActivity 停止（stopService）
 */
public class EngineService extends Service {
    private static final String TAG = "AshEngineService";
    private static final String CHANNEL_ID = "dsh_engine";
    private static final int NOTIF_ID = 1;
    private static final String PREFS = "dsh_prefs";
    static final String KEY_STOPPED = "ash_engine_stopped";
    private static final String SPEC_FILE = "ash-launch.json";
    private static final String REL_BINJS = "lib/node_modules/@deepseek-ai/dsh/lib/bin.js";
    private static final long CHECK_MS = 20000;
    /** 刚拉起过引擎的这段时间内不再重复拉（node 冷启动要几十秒才开始监听）。 */
    private static final long SPAWN_GRACE_MS = 120000;

    private static volatile long lastSpawnAt = 0L;
    private static volatile Thread supervisor;
    private volatile String shownState = "";

    static void markSpawn() {
        lastSpawnAt = System.currentTimeMillis();
    }

    /** 记下一次成功发起的引擎启动：命令行 + 相对本进程环境的覆盖项。 */
    static void saveLaunchSpec(Context ctx, List<String> cmd, Map<String, String> env) {
        try {
            JSONObject o = new JSONObject();
            JSONArray c = new JSONArray();
            for (String s : cmd) c.put(s);
            o.put("cmd", c);
            JSONObject e = new JSONObject();
            Map<String, String> base = System.getenv();
            for (Map.Entry<String, String> kv : env.entrySet()) {
                String v = kv.getValue();
                if (v != null && !v.equals(base.get(kv.getKey()))) e.put(kv.getKey(), v);
            }
            o.put("env", e);
            File f = new File(ctx.getFilesDir(), SPEC_FILE);
            File tmp = new File(ctx.getFilesDir(), SPEC_FILE + ".tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            out.write(o.toString().getBytes("UTF-8"));
            out.close();
            if (!tmp.renameTo(f)) Log.w(TAG, "rename launch spec failed");
        } catch (Throwable t) {
            Log.w(TAG, "save launch spec failed", t);
        }
    }

    /**
     * 按记下的参数拉起引擎。没有记录（从没在 Activity 里成功启动过）或文件缺失时返回 false。
     * 引擎已在监听或刚被拉起过时不重复拉（返回 true，调用方照常等就绪）。
     */
    static synchronized boolean spawnFromSpec(Context ctx) {
        if (portListening(AshAgent.port(ctx))) return true;
        if (System.currentTimeMillis() - lastSpawnAt < SPAWN_GRACE_MS) return true;
        if (enginePid(ctx) > 0) return true;
        try {
            JSONObject o = readSpec(ctx);
            if (o == null) return false;
            JSONArray c = o.getJSONArray("cmd");
            List<String> cmd = new ArrayList<String>();
            for (int i = 0; i < c.length(); i++) cmd.add(c.getString(i));
            for (String path : cmd) {
                if (path.startsWith("/") && !new File(path).exists()) {
                    Log.w(TAG, "launch spec points to missing file: " + path);
                    return false;
                }
            }
            ProcessBuilder pb = new ProcessBuilder(cmd);
            JSONObject e = o.getJSONObject("env");
            Map<String, String> env = pb.environment();
            Iterator<String> keys = e.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                env.put(k, e.getString(k));
            }
            pb.redirectErrorStream(true);
            Process proc = pb.start();
            markSpawn();
            pumpLog(ctx, proc.getInputStream());
            Log.i(TAG, "engine spawned by supervisor");
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "spawn from spec failed", t);
            return false;
        }
    }

    private static JSONObject readSpec(Context ctx) throws Exception {
        File f = new File(ctx.getFilesDir(), SPEC_FILE);
        if (!f.exists()) return null;
        FileInputStream in = new FileInputStream(f);
        byte[] buf = new byte[(int) f.length()];
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) break;
            off += n;
        }
        in.close();
        return new JSONObject(new String(buf, 0, off, "UTF-8"));
    }

    // ------------------------------------------------------------------ ash-link

    private static volatile long lastLinkSpawnAt = 0L;

    /**
     * ash-link（网关客户端，见 ash-gateway 仓库）：files/ash-link/ 下有 ash-link.mjs 与 config.json
     * 就用引擎同一个 Node（同一套环境变量）拉起并守护；没有配置就什么都不做。
     */
    static synchronized void ensureLink(Context ctx) {
        File dir = new File(ctx.getFilesDir(), "ash-link");
        File js = new File(dir, "ash-link.mjs");
        File cfg = new File(dir, "config.json");
        if (!js.exists() || !cfg.exists()) return;
        if (pidMatching("ash-link.mjs") > 0) return;
        if (System.currentTimeMillis() - lastLinkSpawnAt < 30000) return;
        lastLinkSpawnAt = System.currentTimeMillis();
        try {
            JSONObject o = readSpec(ctx);
            if (o == null) return;   // 引擎还没在 Activity 里成功启动过：拿不到 node 与环境
            List<String> cmd = new ArrayList<String>();
            cmd.add(o.getJSONArray("cmd").getString(0));   // node
            cmd.add(js.getAbsolutePath());
            cmd.add("--config");
            cmd.add(cfg.getAbsolutePath());
            ProcessBuilder pb = new ProcessBuilder(cmd);
            JSONObject e = o.getJSONObject("env");
            Map<String, String> env = pb.environment();
            Iterator<String> keys = e.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                env.put(k, e.getString(k));
            }
            pb.directory(dir);
            pb.redirectErrorStream(true);
            Process proc = pb.start();
            pumpLog(new File(dir, "link.log"), proc.getInputStream());
            Log.i(TAG, "ash-link spawned");
        } catch (Throwable t) {
            Log.w(TAG, "ash-link spawn failed", t);
        }
    }

    private static void pumpLog(Context ctx, final InputStream is) {
        pumpLog(new File(ctx.getFilesDir(), "dsh-web.log"), is);
    }

    private static void pumpLog(final File logFile, final InputStream is) {
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    FileOutputStream fos = new FileOutputStream(logFile, true);
                    byte[] b = new byte[4096];
                    int n;
                    while ((n = is.read(b)) > 0) { fos.write(b, 0, n); fos.flush(); }
                    fos.close();
                } catch (Throwable ignored) {}
            }
        }, "ash-node-log").start();
    }

    /**
     * 本应用 uid 下正在跑的引擎 node 进程（找不到返回 -1）。端口探测在机器很忙时会超时，
     * 只看端口会把正在跑的引擎误判为挂了、再拉起第二个；进程还在就不能再拉。
     */
    static int enginePid(Context ctx) {
        return pidMatching("bin.js", " web ", "--port " + AshAgent.port(ctx));
    }

    /** 本 uid 下命令行同时包含所有 needles 的进程（找不到返回 -1）。 */
    static int pidMatching(String... needles) {
        File[] kids = new File("/proc").listFiles();
        if (kids == null) return -1;
        int self = android.os.Process.myPid();
        for (File k : kids) {
            String name = k.getName();
            if (name.isEmpty() || !Character.isDigit(name.charAt(0))) continue;
            int pid;
            try { pid = Integer.parseInt(name); } catch (NumberFormatException e) { continue; }
            if (pid == self) continue;
            try {
                FileInputStream in = new FileInputStream(new File(k, "cmdline"));
                byte[] buf = new byte[4096];
                int n = in.read(buf);
                in.close();
                if (n <= 0) continue;
                String cmd = new String(buf, 0, n, "UTF-8").replace('\0', ' ');
                boolean all = true;
                for (String nd : needles) if (!cmd.contains(nd)) { all = false; break; }
                if (all) return pid;
            } catch (Throwable ignored) {
                // 别的 uid 的进程读不到，跳过
            }
        }
        return -1;
    }

    static boolean portListening(int port) {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress("127.0.0.1", port), 3000);
            return true;
        } catch (Throwable t) {
            return false;
        } finally {
            try { s.close(); } catch (Throwable ignored) {}
        }
    }

    /**
     * 引擎文件是否已解压就位（解压由 Activity 完成）。以 Activity 解压收尾时写下的
     * payload_build_code 为准 —— 解压途中 bin.js 可能已经在了，只看文件会过早拉起引擎。
     */
    @SuppressWarnings("deprecation")
    static boolean filesReady(Context ctx) {
        try {
            int done = ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getInt("payload_build_code", 0);
            int ver = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionCode;
            if (done == 0 || done != ver) return false;
        } catch (Throwable t) {
            return false;
        }
        File payload = new File(ctx.getFilesDir(), "payload");
        return new File(payload, ".extracted").exists()
                && new File(payload, "runtime/bin/node").exists()
                && new File(new File(payload, "dshroot"), REL_BINJS).exists();
    }

    static void setStopped(Context ctx, boolean stopped) {
        try {
            ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_STOPPED, stopped).apply();
        } catch (Throwable ignored) {}
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(NOTIF_ID, buildNotification("Ash 正在运行", "主 Agent 常驻中"));
        startSupervisor();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startSupervisor();
        // 定时任务自动执行：闹钟到点后带 scheduledTask extra 启动本服务，后台执行任务
        if (intent != null) {
            String task = intent.getStringExtra("scheduledTask");
            if (task != null && !task.isEmpty()) {
                final String fTask = task;
                new Thread(new Runnable() {
                    @Override public void run() {
                        ScheduleExecutor.execute(EngineService.this, fTask);
                    }
                }, "scheduled-exec").start();
            }
        }
        return START_STICKY;
    }

    private void startSupervisor() {
        if (supervisor != null && supervisor.isAlive()) return;
        final Context app = getApplicationContext();
        supervisor = new Thread(new Runnable() {
            @Override public void run() {
                while (!Thread.currentThread().isInterrupted()) {
                    try {
                        tick(app);
                    } catch (Throwable t) {
                        Log.w(TAG, "supervisor tick failed", t);
                    }
                    try { Thread.sleep(CHECK_MS); } catch (InterruptedException e) { return; }
                }
            }
        }, "ash-supervisor");
        supervisor.start();
    }

    private void tick(Context ctx) {
        int port = AshAgent.port(ctx);
        if (ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_STOPPED, false)) {
            show("Ash 已停止", "引擎被手动停止，打开 App 可重新启动");
            return;
        }
        if (!filesReady(ctx)) {
            show("Ash 待初始化", "打开 App 完成首次解压");
            return;
        }
        ensureLink(ctx);
        if (portListening(port)) {
            if (AshAgent.tokenUrl(ctx) == null) {
                show("Ash 启动中", "引擎正在启动");
                return;
            }
            String sid = AshAgent.mainSession(ctx);
            if (sid != null) {
                show("Ash 主 Agent 在线", "主会话 " + shortId(sid));
            } else {
                show("Ash 引擎在线", "主会话未就绪（请先在 App 里配置模型与 API Key）");
            }
            return;
        }
        if (System.currentTimeMillis() - lastSpawnAt < SPAWN_GRACE_MS || enginePid(ctx) > 0) {
            show("Ash 启动中", "引擎正在启动");
            return;
        }
        show("Ash 启动中", "引擎未运行，正在拉起");
        if (!spawnFromSpec(ctx)) {
            show("Ash 待启动", "打开 App 启动一次引擎后即可常驻");
        }
    }

    private static String shortId(String sid) {
        return sid.length() > 12 ? sid.substring(0, 12) : sid;
    }

    private void show(String title, String text) {
        String key = title + "|" + text;
        if (key.equals(shownState)) return;
        shownState = key;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification(title, text));
        Log.i(TAG, "state: " + title + " / " + text);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        Thread s = supervisor;
        supervisor = null;
        if (s != null) s.interrupt();
        super.onDestroy();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIF_ID);
    }

    private Notification buildNotification(String title, String text) {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        return b.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentIntent(pi)
                .setOngoing(true)   // 常驻不可滑动删除
                .setPriority(Notification.PRIORITY_LOW)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "引擎保活",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Ash 主 Agent 运行状态");
            nm.createNotificationChannel(ch);
        }
    }
}
