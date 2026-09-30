package ai.ash.host.cap

import ai.ash.host.shizuku.PrivShell
import ai.ash.host.system.Apps
import ai.ash.host.system.Clip
import ai.ash.host.system.Launcher
import ai.ash.host.system.Usage
import android.app.ActivityManager
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import android.view.KeyEvent
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Phone capabilities that need no special service (some need a permission the owner grants in settings). */
object SystemCapabilities {

    private fun iso(t: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.ROOT).format(Date(t))

    // ───────────────────────────── clipboard ─────────────────────────────

    private val clipboardGet = Cap(
        "clipboard.get",
        "Read the text currently on the phone's clipboard. No permission needed, but Android 10+ only lets the app in " +
            "the foreground read the clipboard: while ash is in the background this fails (ask the owner to open ash, or to paste the text).",
    ) { ctx, _ ->
        val text = Clip.get(ctx)
        when {
            text != null -> CapResult.text(text, JSONObject().put("text", text))
            Build.VERSION.SDK_INT >= 29 && !Launcher.isForeground(ctx) ->
                CapResult.fail("cannot read the clipboard: Android ${Build.VERSION.RELEASE} hides it from apps in the background and ash is not in the foreground")
            else -> CapResult.text("(the clipboard is empty)", JSONObject().put("text", ""))
        }
    }

    private val clipboardSet = Cap(
        "clipboard.set",
        "Put text on the phone's clipboard (replacing what is there) so the owner can paste it anywhere. No permission needed.",
        schema("text" to prop("string", "The text to copy.", required = true)),
    ) { ctx, args ->
        if (!args.has("text")) return@Cap CapResult.fail("text is required")
        val text = args.optString("text")
        Clip.set(ctx, text)
        CapResult.text("Copied ${text.length} characters to the clipboard.")
    }

    // ───────────────────────────── device ─────────────────────────────

    private val deviceStatus = Cap(
        "device.status",
        "Current phone status: battery level and charging, network (type, online, metered), free storage, memory, " +
            "screen on/locked, ringer mode and volumes, time, time zone, locale, model and Android version. No permission needed.",
    ) { ctx, _ -> CapResult.json(deviceStatus(ctx)) }

    private fun deviceStatus(ctx: Context): JSONObject {
        val d = JSONObject()
        val bat = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        if (bat != null) {
            val level = bat.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = bat.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            val status = bat.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            val plugged = bat.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
            d.put("battery", JSONObject()
                .put("percent", if (level >= 0 && scale > 0) level * 100 / scale else -1)
                .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
                .put("full", status == BatteryManager.BATTERY_STATUS_FULL)
                .put("plugged", when (plugged) {
                    BatteryManager.BATTERY_PLUGGED_AC -> "ac"; BatteryManager.BATTERY_PLUGGED_USB -> "usb"
                    BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"; 0 -> "none"; else -> "other"
                })
                .put("temperature_c", bat.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0))
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            d.getJSONObject("battery").put("power_save", pm.isPowerSaveMode)
        }
        try {
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val n = cm.activeNetwork
            val caps = n?.let { cm.getNetworkCapabilities(it) }
            val net = JSONObject()
            if (caps == null) {
                net.put("type", "none").put("online", false)
            } else {
                val type = when {
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "bluetooth"
                    else -> "other"
                }
                net.put("type", type)
                    .put("online", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
                    .put("metered", cm.isActiveNetworkMetered)
                if (type == "vpn") net.put("underlying_wifi", caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))
                    .put("underlying_cellular", caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR))
            }
            net.put("airplane_mode", Settings.Global.getInt(ctx.contentResolver, Settings.Global.AIRPLANE_MODE_ON, 0) == 1)
            d.put("network", net)
        } catch (e: Throwable) {
            d.put("network", JSONObject().put("error", e.message))
        }
        fun storage(path: java.io.File) = try {
            val s = StatFs(path.absolutePath)
            JSONObject().put("free_gb", round1(s.availableBytes / 1e9)).put("total_gb", round1(s.totalBytes / 1e9))
        } catch (e: Throwable) { JSONObject().put("error", e.message) }
        d.put("storage", storage(Environment.getDataDirectory()))
        try {
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val mi = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
            d.put("memory", JSONObject().put("available_gb", round1(mi.availMem / 1e9)).put("total_gb", round1(mi.totalMem / 1e9)).put("low", mi.lowMemory))
        } catch (e: Throwable) {}
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        d.put("screen", JSONObject().put("on", pm.isInteractive).put("locked", km.isKeyguardLocked).put("secure_lock", km.isDeviceSecure))
        try {
            val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            d.put("sound", JSONObject()
                .put("ringer", when (audio.ringerMode) { AudioManager.RINGER_MODE_SILENT -> "silent"; AudioManager.RINGER_MODE_VIBRATE -> "vibrate"; else -> "normal" })
                .put("media_volume", "${audio.getStreamVolume(AudioManager.STREAM_MUSIC)}/${audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)}")
                .put("ring_volume", "${audio.getStreamVolume(AudioManager.STREAM_RING)}/${audio.getStreamMaxVolume(AudioManager.STREAM_RING)}")
                .put("music_active", audio.isMusicActive))
        } catch (e: Throwable) {}
        val now = System.currentTimeMillis()
        d.put("time", iso(now)).put("time_zone", TimeZone.getDefault().id)
            .put("locale", Locale.getDefault().toLanguageTag())
            .put("uptime_hours", round1(SystemClock.elapsedRealtime() / 3.6e6))
        d.put("device", JSONObject()
            .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL).put("brand", Build.BRAND)
            .put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT)
            .put("security_patch", if (Build.VERSION.SDK_INT >= 23) Build.VERSION.SECURITY_PATCH else ""))
        return d
    }

    private fun round1(v: Double) = Math.round(v * 10) / 10.0

    // ───────────────────────────── apps ─────────────────────────────

    private val appsList = Cap(
        "apps.list",
        "List the apps installed on the phone that have a launcher icon: label and package name, sorted by label. " +
            "Optionally filter by a substring of the label or package. No permission needed.",
        schema(
            "query" to prop("string", "Only apps whose label or package contains this text (case-insensitive)."),
            "include_system" to prop("boolean", "Include preinstalled system apps (default true)."),
        ),
    ) { ctx, args ->
        val q = args.optString("query").trim().lowercase(Locale.ROOT)
        val sys = args.optBoolean("include_system", true)
        val apps = Apps.launchable(ctx).filter { (sys || !it.system) && (q.isEmpty() || it.label.lowercase(Locale.ROOT).contains(q) || it.pkg.lowercase(Locale.ROOT).contains(q)) }
        val arr = JSONArray()
        apps.forEach { arr.put(JSONObject().put("label", it.label).put("package", it.pkg).put("system", it.system)) }
        val text = if (apps.isEmpty()) "No launchable app matches." else "${apps.size} apps:\n" + apps.joinToString("\n") { "${it.label} — ${it.pkg}" }
        CapResult.text(text, JSONObject().put("apps", arr))
    }

    private val appsOpen = Cap(
        "apps.open",
        "Open (launch or bring to front) an app on the phone's screen, by package name or launcher label. Android 10+ blocks " +
            "background apps from opening screens, so this works when ash is in the foreground, ash's accessibility service is " +
            "enabled, or Shizuku is running with ash authorized (it then goes through the Shizuku shell); otherwise the result says it may have been blocked.",
        schema("app" to prop("string", "Package name (e.g. com.tencent.mm) or launcher label (e.g. \"WeChat\").", required = true)),
    ) { ctx, args ->
        val app = try { Apps.resolve(ctx, args.optString("app")) } catch (e: Exception) { return@Cap CapResult.fail(e.message ?: "unknown app") }
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setComponent(app.component)
            .addFlags(Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        val how = Launcher.start(ctx, intent)
        CapResult.text("${app.label} (${app.pkg}): $how.", JSONObject().put("package", app.pkg).put("label", app.label))
    }

    private val appsInfo = Cap(
        "apps.info",
        "Details of an installed package: label, version, install/update time, whether it is a system app or disabled, " +
            "target/min SDK, installer, launcher activity, APK path, and the permissions it requests with their grant state. " +
            "Accepts a package name or a launcher label. No permission needed. (To install, uninstall, clear data or grant/revoke " +
            "permissions use shell.run with pm.)",
        schema(
            "app" to prop("string", "Package name or launcher label.", required = true),
            "permissions" to prop("boolean", "Include the requested permissions (default true)."),
        ),
    ) { ctx, args ->
        val q = args.optString("app").trim()
        val pkg = if (Apps.isInstalled(ctx, q)) q else try { Apps.resolve(ctx, q).pkg } catch (e: Exception) { return@Cap CapResult.fail("$q is not installed (${e.message})") }
        CapResult.json(packageInfo(ctx, pkg, args.optBoolean("permissions", true)))
    }

    @Suppress("DEPRECATION")
    private fun packageInfo(ctx: Context, pkg: String, perms: Boolean): JSONObject {
        val pm = ctx.packageManager
        val pi: PackageInfo = pm.getPackageInfo(pkg, if (perms) PackageManager.GET_PERMISSIONS else 0)
        val ai = pi.applicationInfo!!
        val d = JSONObject()
            .put("package", pkg)
            .put("label", pm.getApplicationLabel(ai).toString())
            .put("version_name", pi.versionName ?: "")
            .put("version_code", if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode else pi.versionCode.toLong())
            .put("first_install", iso(pi.firstInstallTime))
            .put("last_update", iso(pi.lastUpdateTime))
            .put("system", (ai.flags and ApplicationInfo.FLAG_SYSTEM) != 0)
            .put("updated_system", (ai.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0)
            .put("enabled", ai.enabled)
            .put("debuggable", (ai.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)
            .put("target_sdk", ai.targetSdkVersion)
            .put("min_sdk", if (Build.VERSION.SDK_INT >= 24) ai.minSdkVersion else 0)
            .put("uid", ai.uid)
            .put("apk", ai.sourceDir)
            .put("data_dir", ai.dataDir)
        try {
            val installer = if (Build.VERSION.SDK_INT >= 30) pm.getInstallSourceInfo(pkg).installingPackageName else pm.getInstallerPackageName(pkg)
            d.put("installer", installer ?: "")
        } catch (e: Throwable) {}
        pm.getLaunchIntentForPackage(pkg)?.component?.let { d.put("launcher_activity", it.flattenToShortString()) }
        if (Build.VERSION.SDK_INT >= 26) try { d.put("category", ai.category) } catch (e: Throwable) {}
        if (perms) {
            val arr = JSONArray()
            val names = pi.requestedPermissions ?: emptyArray()
            val flags = pi.requestedPermissionsFlags
            for (i in names.indices) {
                val granted = flags != null && i < flags.size && (flags[i] and PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0
                arr.put(JSONObject().put("name", names[i]).put("granted", granted))
            }
            d.put("permissions", arr)
        }
        return d
    }

    private val appsUsage = Cap(
        "apps.usage",
        "How long each app was used in the foreground (screen time), most used first, with the last time it was used. " +
            "days=1 means today since midnight, days=7 the last 7 days including today (max 30). Requires the " +
            "\"Usage access\" permission for ash (the owner grants it in system settings; settings.open page=usage_access opens it).",
        schema(
            "days" to prop("integer", "Range in days, counted from local midnight (default 1 = today, max 30)."),
            "limit" to prop("integer", "Max apps returned (default 20)."),
            "app" to prop("string", "Only this package (or label substring)."),
        ),
        availableIf = { Usage.granted(it) },
    ) { ctx, args ->
        val days = args.optInt("days", 1).coerceIn(1, 30)
        val limit = args.optInt("limit", 20).coerceIn(1, 500)
        val filter = args.optString("app").trim().lowercase(Locale.ROOT)
        val start = Usage.startOfRange(days)
        val end = System.currentTimeMillis()
        var entries = Usage.query(ctx, start, end).map { it to (Apps.labelOf(ctx, it.pkg) ?: it.pkg) }
        if (filter.isNotEmpty()) entries = entries.filter { (e, label) -> e.pkg.lowercase(Locale.ROOT) == filter || label.lowercase(Locale.ROOT).contains(filter) || e.pkg.lowercase(Locale.ROOT).contains(filter) }
        val total = entries.sumOf { it.first.foregroundMs }
        val arr = JSONArray()
        val lines = StringBuilder("Screen time since ${iso(start)} (${entries.size} apps, total ${dur(total)}):")
        for ((e, label) in entries.take(limit)) {
            arr.put(JSONObject().put("package", e.pkg).put("label", label).put("foreground_ms", e.foregroundMs)
                .put("minutes", e.foregroundMs / 60000).apply { if (e.lastUsed > 0) put("last_used", iso(e.lastUsed)) })
            lines.append("\n").append(label).append(" (").append(e.pkg).append("): ").append(dur(e.foregroundMs))
            if (e.lastUsed > 0) lines.append(", last used ").append(iso(e.lastUsed))
        }
        if (entries.isEmpty()) lines.append("\n(no usage recorded in this range)")
        CapResult.text(lines.toString(), JSONObject().put("since", iso(start)).put("days", days).put("total_ms", total).put("apps", arr))
    }

    private fun dur(ms: Long): String {
        val m = ms / 60000
        return if (m >= 60) "${m / 60}h ${m % 60}m" else if (m > 0) "${m}m" else "${ms / 1000}s"
    }

    // ───────────────────────────── settings ─────────────────────────────

    /** page name → settings action; the Boolean says whether the page takes a `package:` uri. */
    private val PAGES: Map<String, Pair<String, Boolean>> = linkedMapOf(
        "settings" to (Settings.ACTION_SETTINGS to false),
        "wifi" to (Settings.ACTION_WIFI_SETTINGS to false),
        "bluetooth" to (Settings.ACTION_BLUETOOTH_SETTINGS to false),
        "mobile_network" to (Settings.ACTION_DATA_ROAMING_SETTINGS to false),
        "data_usage" to ("android.settings.DATA_USAGE_SETTINGS" to false),
        "airplane_mode" to (Settings.ACTION_AIRPLANE_MODE_SETTINGS to false),
        "vpn" to ("android.settings.VPN_SETTINGS" to false),
        "nfc" to (Settings.ACTION_NFC_SETTINGS to false),
        "display" to (Settings.ACTION_DISPLAY_SETTINGS to false),
        "sound" to (Settings.ACTION_SOUND_SETTINGS to false),
        "battery_saver" to (Settings.ACTION_BATTERY_SAVER_SETTINGS to false),
        "battery_usage" to (Intent.ACTION_POWER_USAGE_SUMMARY to false),
        "location" to (Settings.ACTION_LOCATION_SOURCE_SETTINGS to false),
        "security" to (Settings.ACTION_SECURITY_SETTINGS to false),
        "storage" to (Settings.ACTION_INTERNAL_STORAGE_SETTINGS to false),
        "date_time" to (Settings.ACTION_DATE_SETTINGS to false),
        "language" to (Settings.ACTION_LOCALE_SETTINGS to false),
        "keyboard" to (Settings.ACTION_INPUT_METHOD_SETTINGS to false),
        "accessibility" to (Settings.ACTION_ACCESSIBILITY_SETTINGS to false),
        "developer" to (Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS to false),
        "device_info" to (Settings.ACTION_DEVICE_INFO_SETTINGS to false),
        "apps" to (Settings.ACTION_MANAGE_APPLICATIONS_SETTINGS to false),
        "default_apps" to (Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS to false),
        "home_app" to (Settings.ACTION_HOME_SETTINGS to false),
        "notification_access" to ("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS" to false),
        "usage_access" to (Settings.ACTION_USAGE_ACCESS_SETTINGS to false),
        "battery_optimization" to (Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS to false),
        "app_details" to (Settings.ACTION_APPLICATION_DETAILS_SETTINGS to true),
        "app_notifications" to ("android.settings.APP_NOTIFICATION_SETTINGS" to false),
        "overlay" to (Settings.ACTION_MANAGE_OVERLAY_PERMISSION to true),
        "write_settings" to (Settings.ACTION_MANAGE_WRITE_SETTINGS to true),
        "install_unknown_apps" to ("android.settings.MANAGE_UNKNOWN_APP_SOURCES" to true),
        "all_files_access" to ("android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION" to true),
    )

    private val settingsOpen = Cap(
        "settings.open",
        "Open a system settings page on the phone's screen for the owner: a named page, an app's details page " +
            "(page=app_details with package) or its notification settings (page=app_notifications), or any raw " +
            "android.settings.* action. Pages that take a package (app_details, app_notifications, overlay, write_settings, " +
            "install_unknown_apps, all_files_access) default to ash itself. Same background-start rules as apps.open.",
        schema(
            "page" to prop("string", "Named page.", enum = PAGES.keys.toList()),
            "action" to prop("string", "Raw settings intent action instead of page, e.g. android.settings.NIGHT_DISPLAY_SETTINGS."),
            "package" to prop("string", "Package for app-specific pages (default: ash)."),
        ),
    ) { ctx, args ->
        val page = args.optString("page").trim()
        val raw = args.optString("action").trim()
        val pkg = args.optString("package").trim().ifEmpty { ctx.packageName }
        val intent: Intent = when {
            raw.isNotEmpty() -> Intent(raw)
            page == "app_notifications" -> if (Build.VERSION.SDK_INT >= 26) {
                Intent("android.settings.APP_NOTIFICATION_SETTINGS").putExtra("android.provider.extra.APP_PACKAGE", pkg)
            } else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
            page.isNotEmpty() -> {
                val (action, withPkg) = PAGES[page] ?: return@Cap CapResult.fail("unknown page \"$page\"")
                if (withPkg) Intent(action, Uri.parse("package:$pkg")) else Intent(action)
            }
            else -> return@Cap CapResult.fail("give page or action")
        }
        val pm = ctx.packageManager
        var target = intent
        if (target.resolveActivity(pm) == null && target.data != null) target = Intent(target.action) // some ROMs lack the per-app variant
        if (target.resolveActivity(pm) == null) return@Cap CapResult.fail("this phone has no settings page for ${raw.ifEmpty { page }}")
        val how = Launcher.start(ctx, target)
        CapResult.text("Settings page ${raw.ifEmpty { page }}${if (target.data != null) " ($pkg)" else ""}: $how.")
    }

    private val NAMESPACES = listOf("system", "secure", "global")
    private val KEY_RE = Regex("^[A-Za-z0-9_.:\\-]+$")

    private fun readSetting(ctx: Context, ns: String, key: String): String? {
        val cr = ctx.contentResolver
        return try {
            when (ns) {
                "system" -> Settings.System.getString(cr, key)
                "secure" -> Settings.Secure.getString(cr, key)
                else -> Settings.Global.getString(cr, key)
            }
        } catch (e: SecurityException) {
            val via = PrivShell.channel(ctx) ?: throw e
            val r = PrivShell.exec(ctx, "settings get $ns ${PrivShell.quote(key)}", 10_000, via = via)
            r.stdout.trim().takeIf { r.ok && it != "null" }
        }
    }

    private val settingsGet = Cap(
        "settings.get",
        "Read an Android system setting from Settings.System, Settings.Secure or Settings.Global (e.g. system " +
            "screen_brightness, screen_off_timeout; secure default_input_method, location_mode; global airplane_mode_on, " +
            "adb_enabled). Without key, lists all keys and values of the namespace (requires Shizuku). Reading needs no permission; " +
            "a few protected keys require Shizuku.",
        schema(
            "namespace" to prop("string", "system, secure or global.", required = true, enum = NAMESPACES),
            "key" to prop("string", "Setting key; omit to list the namespace."),
        ),
    ) { ctx, args ->
        val ns = args.optString("namespace").lowercase(Locale.ROOT)
        if (ns !in NAMESPACES) return@Cap CapResult.fail("namespace must be system, secure or global")
        val key = args.optString("key").trim()
        if (key.isEmpty()) {
            val r = try { PrivShell.exec(ctx, "settings list $ns", 15_000, maxOut = 60_000) } catch (e: Exception) {
                return@Cap CapResult.fail("listing settings requires Shizuku: ${e.message}")
            }
            if (!r.ok) return@Cap CapResult.fail("settings list failed: ${r.stderr.ifEmpty { r.stdout }.take(500)}")
            return@Cap CapResult.text(r.stdout + if (r.stdoutTruncated) "\n[truncated]" else "")
        }
        if (!KEY_RE.matches(key)) return@Cap CapResult.fail("invalid key")
        val v = readSetting(ctx, ns, key)
        CapResult.text(if (v == null) "$ns/$key is not set (null)" else "$ns/$key = $v", JSONObject().put("namespace", ns).put("key", key).put("value", v ?: JSONObject.NULL))
    }

    private val VOLUME_STREAMS = mapOf(
        "volume_music" to AudioManager.STREAM_MUSIC, "volume_ring" to AudioManager.STREAM_RING,
        "volume_alarm" to AudioManager.STREAM_ALARM, "volume_notification" to AudioManager.STREAM_NOTIFICATION,
        "volume_system" to AudioManager.STREAM_SYSTEM, "volume_voice_call" to AudioManager.STREAM_VOICE_CALL,
    )

    private val settingsPut = Cap(
        "settings.put",
        "Change an Android system setting. namespace=system keys (e.g. screen_brightness 0-255, screen_brightness_mode 0/1, " +
            "screen_off_timeout ms, accelerometer_rotation 0/1, font_scale) are written by ash itself when the owner granted it " +
            "\"Modify system settings\" (settings.open page=write_settings), otherwise through Shizuku; secure and global keys " +
            "always require Shizuku. Special keys volume_music / volume_ring / volume_alarm / volume_notification / volume_system / " +
            "volume_voice_call set that volume (a level or a percentage like \"50%\") and need nothing. The previous and new values are returned.",
        schema(
            "namespace" to prop("string", "system, secure or global.", required = true, enum = NAMESPACES),
            "key" to prop("string", "Setting key.", required = true),
            "value" to prop("string", "New value (as a string).", required = true),
        ),
        confirm = true,
    ) { ctx, args ->
        val ns = args.optString("namespace").lowercase(Locale.ROOT)
        val key = args.optString("key").trim()
        if (!args.has("value") || args.isNull("value")) return@Cap CapResult.fail("value is required")
        val value = args.optString("value").trim()
        if (ns !in NAMESPACES) return@Cap CapResult.fail("namespace must be system, secure or global")
        if (!KEY_RE.matches(key)) return@Cap CapResult.fail("invalid key")
        VOLUME_STREAMS[key]?.let { return@Cap setVolume(ctx, key, it, value) }
        val before = try { readSetting(ctx, ns, key) } catch (e: Throwable) { null }
        var how = ""
        var written = false
        if (ns == "system" && Build.VERSION.SDK_INT >= 23 && Settings.System.canWrite(ctx)) {
            try {
                written = Settings.System.putString(ctx.contentResolver, key, value)
                how = "written by ash"
            } catch (e: IllegalArgumentException) {
                // Apps may only write public Settings.System keys; others go through the shell.
            } catch (e: SecurityException) {}
        }
        if (!written) {
            val via = try { PrivShell.requireChannel(ctx) } catch (e: Exception) {
                val need = if (ns == "system") "grant ash \"Modify system settings\" (settings.open page=write_settings) or enable Shizuku" else "$ns settings require Shizuku"
                return@Cap CapResult.fail("cannot write $ns/$key: $need (${e.message})")
            }
            val r = PrivShell.exec(ctx, "settings put $ns ${PrivShell.quote(key)} ${PrivShell.quote(value)}", 15_000, via = via)
            if (!r.ok) return@Cap CapResult.fail("settings put failed: ${(r.stderr + " " + r.stdout).trim().ifEmpty { "exit ${r.exitCode}" }.take(500)}")
            how = "written via $via"
        }
        val after = try { readSetting(ctx, ns, key) } catch (e: Throwable) { null }
        CapResult.text("$ns/$key: ${before ?: "null"} → ${after ?: "null"} ($how).",
            JSONObject().put("namespace", ns).put("key", key).put("before", before ?: JSONObject.NULL).put("after", after ?: JSONObject.NULL))
    }

    private fun setVolume(ctx: Context, key: String, stream: Int, value: String): CapResult {
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val max = am.getStreamMaxVolume(stream)
        val before = am.getStreamVolume(stream)
        val level = try {
            if (value.endsWith("%")) Math.round(max * value.dropLast(1).trim().toDouble() / 100.0).toInt() else value.toDouble().toInt()
        } catch (e: NumberFormatException) { return CapResult.fail("volume must be a number or a percentage") }
        try {
            am.setStreamVolume(stream, level.coerceIn(0, max), 0)
        } catch (e: SecurityException) {
            return CapResult.fail("Android refused to change $key (Do Not Disturb policy): ${e.message}")
        }
        val after = am.getStreamVolume(stream)
        return CapResult.text("$key: $before → $after (max $max).", JSONObject().put("key", key).put("before", before).put("after", after).put("max", max))
    }

    // ───────────────────────────── intents & keys ─────────────────────────────

    private val intentView = Cap(
        "intent.view",
        "Open a URL or deep link on the phone's screen with the app that handles it (https:// in the browser or the " +
            "matching app, geo:, tel: (opens the dialer, does not call), mailto:, market://, app-specific schemes). Optionally " +
            "force a package. Same background-start rules as apps.open.",
        schema(
            "uri" to prop("string", "The URL or deep link.", required = true),
            "package" to prop("string", "Open with this app only (package name)."),
        ),
    ) { ctx, args ->
        val uri = args.optString("uri").trim()
        if (uri.isEmpty() || !uri.contains(':')) return@Cap CapResult.fail("uri must be an absolute URL or deep link (scheme:...)")
        val pkg = args.optString("package").trim().ifEmpty { null }
        // Prefer handlers meant to be opened from links (BROWSABLE); fall back to any VIEW handler.
        var intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(pkg)
        var ri = ctx.packageManager.resolveActivity(intent, 0)
        if (ri == null) {
            intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(pkg)
            ri = ctx.packageManager.resolveActivity(intent, 0) ?: return@Cap CapResult.fail("no app on the phone can open $uri")
        }
        val how = Launcher.start(ctx, intent)
        val handler = ri.activityInfo?.packageName?.let { if (it == "android") "chooser" else it } ?: "?"
        CapResult.text("Opened $uri (handler: $handler): $how.")
    }

    private val MEDIA_KEYS = mapOf(
        "play_pause" to KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, "play" to KeyEvent.KEYCODE_MEDIA_PLAY, "pause" to KeyEvent.KEYCODE_MEDIA_PAUSE,
        "next" to KeyEvent.KEYCODE_MEDIA_NEXT, "previous" to KeyEvent.KEYCODE_MEDIA_PREVIOUS, "stop" to KeyEvent.KEYCODE_MEDIA_STOP,
        "rewind" to KeyEvent.KEYCODE_MEDIA_REWIND, "fast_forward" to KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
    )
    private val VOLUME_KEYS = mapOf(
        "volume_up" to KeyEvent.KEYCODE_VOLUME_UP, "volume_down" to KeyEvent.KEYCODE_VOLUME_DOWN, "volume_mute" to KeyEvent.KEYCODE_VOLUME_MUTE,
    )
    private val SHELL_KEYS = mapOf(
        "back" to 4, "home" to 3, "recents" to 187, "menu" to 82, "enter" to 66, "power" to 26, "wakeup" to 224, "sleep" to 223,
        "notifications" to 83, "search" to 84, "camera" to 27, "brightness_up" to 221, "brightness_down" to 220,
        "screenshot" to 120, "assist" to 219, "tab" to 61, "escape" to 111, "delete" to 67,
        "dpad_up" to 19, "dpad_down" to 20, "dpad_left" to 21, "dpad_right" to 22, "dpad_center" to 23,
    )

    private val inputKey = Cap(
        "input.key",
        "Press a key on the phone. Media keys (${MEDIA_KEYS.keys.joinToString(", ")}) control whatever is playing and volume keys " +
            "(${VOLUME_KEYS.keys.joinToString(", ")}) change the active volume; both need no permission. Other keys " +
            "(${SHELL_KEYS.keys.joinToString(", ")}, or any Android keycode number) are injected on the main screen with the " +
            "shell `input keyevent` and require Shizuku. For back/home/recents the accessibility screen capabilities also work.",
        schema(
            "key" to prop("string", "Key name or numeric KeyEvent keycode.", required = true),
            "long_press" to prop("boolean", "Long-press (injected keys only)."),
        ),
    ) { ctx, args ->
        val k = args.optString("key").trim().lowercase(Locale.ROOT)
        val num = k.toIntOrNull()
        val media = MEDIA_KEYS[k] ?: num?.takeIf { it in MEDIA_KEYS.values }
        val vol = VOLUME_KEYS[k] ?: num?.takeIf { it in VOLUME_KEYS.values }
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        when {
            media != null -> {
                val t = SystemClock.uptimeMillis()
                am.dispatchMediaKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_DOWN, media, 0))
                am.dispatchMediaKeyEvent(KeyEvent(t, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, media, 0))
                CapResult.text("Media key $k sent${if (!am.isMusicActive && media != KeyEvent.KEYCODE_MEDIA_PLAY && media != KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) " (nothing is playing right now)" else ""}.")
            }
            vol != null -> {
                val dir = when (vol) { KeyEvent.KEYCODE_VOLUME_UP -> AudioManager.ADJUST_RAISE; KeyEvent.KEYCODE_VOLUME_DOWN -> AudioManager.ADJUST_LOWER; else -> AudioManager.ADJUST_TOGGLE_MUTE }
                try {
                    am.adjustSuggestedStreamVolume(dir, AudioManager.USE_DEFAULT_STREAM_TYPE, AudioManager.FLAG_SHOW_UI)
                } catch (e: SecurityException) {
                    return@Cap CapResult.fail("Android refused the volume change (Do Not Disturb policy): ${e.message}")
                }
                val m = am.getStreamVolume(AudioManager.STREAM_MUSIC)
                CapResult.text("Volume key $k sent (media volume now $m/${am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)}).")
            }
            else -> {
                val code = SHELL_KEYS[k] ?: num ?: return@Cap CapResult.fail("unknown key \"$k\"")
                val via = try { PrivShell.requireChannel(ctx) } catch (e: Exception) {
                    return@Cap CapResult.fail("injecting $k requires Shizuku: ${e.message}")
                }
                val r = PrivShell.exec(ctx, "input keyevent ${if (args.optBoolean("long_press")) "--longpress " else ""}$code", 10_000, via = via)
                if (r.ok) CapResult.text("Key $k ($code) injected.") else CapResult.fail("input keyevent failed: ${(r.stderr + " " + r.stdout).trim().take(400)}")
            }
        }
    }

    val list: List<Capability> = listOf(
        clipboardGet, clipboardSet, deviceStatus,
        appsList, appsOpen, appsInfo, appsUsage,
        settingsOpen, settingsGet, settingsPut,
        intentView, inputKey,
    )
}
