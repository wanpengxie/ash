package ai.ash.host.cap

import ai.ash.host.shizuku.PrivShell
import ai.ash.host.shizuku.RootShell
import ai.ash.host.shizuku.ShizukuState
import android.os.Build
import android.os.Process
import org.json.JSONObject

/** Privileged shell: Shizuku (shell uid) first, root (su) as fallback. */
object ShellCapabilities {

    private val run = Cap(
        name = "shell.run",
        description = "Run one shell command (sh -c) on the phone with elevated privileges: through Shizuku " +
            "(runs as the adb 'shell' user, uid 2000, or as root if Shizuku was started with root), falling back to root (su) " +
            "when Shizuku is not usable. Use it for things an ordinary app cannot do: pm (install/uninstall/grant/revoke/clear), " +
            "am (start/force-stop), cmd, dumpsys, settings, input, screencap to a file, reading /data/local/tmp, etc. " +
            "Returns exit code, stdout and stderr (each cut at max_output bytes). Commands that never exit are killed at the timeout. " +
            "Requires the Shizuku app running with ash authorized, or a rooted phone; fails with the reason otherwise " +
            "(see shell.status). The owner is asked to approve every call, so do not split one job into many calls.",
        schema = schema(
            "command" to prop("string", "The command line, interpreted by /system/bin/sh -c. Quote arguments carefully.", required = true),
            "timeout_ms" to prop("integer", "Kill the command after this many milliseconds (default 30000, max 120000)."),
            "stdin" to prop("string", "Optional text written to the command's standard input (then closed)."),
            "cwd" to prop("string", "Optional working directory (absolute path)."),
            "max_output" to prop("integer", "Max bytes kept per stream (default 16000, max 200000)."),
        ),
        confirm = true,
        availableIf = { PrivShell.maybeAvailable(it) },
    ) { ctx, args ->
        val command = args.optString("command").trim()
        if (command.isEmpty()) return@Cap CapResult.fail("command is required")
        val timeout = args.optInt("timeout_ms", PrivShell.DEFAULT_TIMEOUT_MS).coerceIn(1000, PrivShell.MAX_TIMEOUT_MS)
        val maxOut = args.optInt("max_output", 16_000).coerceIn(256, 200_000)
        val stdin = if (args.has("stdin") && !args.isNull("stdin")) args.optString("stdin") else null
        val cwd = args.optString("cwd").trim().ifEmpty { null }
        val r = try {
            PrivShell.exec(ctx, command, timeout, stdin, cwd, maxOut)
        } catch (e: Throwable) {
            return@Cap CapResult.fail("shell.run: ${e.message ?: e.javaClass.simpleName}")
        }
        val data = JSONObject()
            .put("ok", r.ok)
            .put("exit_code", r.exitCode)
            .put("stdout", r.stdout)
            .put("stderr", r.stderr)
            .put("via", r.via)
        if (r.timedOut) data.put("timed_out", true)
        if (r.stdoutTruncated) data.put("stdout_truncated", true)
        if (r.stderrTruncated) data.put("stderr_truncated", true)
        val text = buildString {
            append(if (r.timedOut) "timed out after ${timeout}ms (killed)" else "exit code ${r.exitCode}")
            append(" · via ").append(r.via)
            if (r.stdout.isNotEmpty()) append("\nstdout:\n").append(r.stdout).append(if (r.stdoutTruncated) "\n[stdout truncated]" else "")
            if (r.stderr.isNotEmpty()) append("\nstderr:\n").append(r.stderr).append(if (r.stderrTruncated) "\n[stderr truncated]" else "")
            if (r.stdout.isEmpty() && r.stderr.isEmpty()) append("\n(no output)")
        }
        CapResult.text(text, data)
    }

    private val status = Cap(
        name = "shell.status",
        description = "Report whether a privileged shell is usable: Shizuku installed / running / ash authorized " +
            "(Shizuku server uid: 2000 = adb mode, 0 = root mode), and whether root (su) is available. " +
            "With request_permission=true and Shizuku running but ash not authorized, shows Shizuku's permission dialog " +
            "to the owner and waits up to 30 s for the answer. With check_root=true, runs `su -c id` (the root manager may " +
            "ask the owner once). Needs no permission itself.",
        schema = schema(
            "request_permission" to prop("boolean", "Ask the owner to authorize ash in Shizuku if it is not yet authorized."),
            "check_root" to prop("boolean", "Actually test su (may show the root manager's prompt). Default: only report whether an su binary exists."),
        ),
    ) { ctx, args ->
        val installed = ShizukuState.installed(ctx)
        if (installed) ShizukuState.awaitBinder(3000)
        var requested: Boolean? = null
        if (args.optBoolean("request_permission") && ShizukuState.running() && !ShizukuState.ready()) {
            requested = ShizukuState.requestPermission(30_000)
        }
        val running = ShizukuState.running()
        val granted = ShizukuState.ready()
        val rootPresent = RootShell.present()
        val root: Boolean? = if (args.optBoolean("check_root")) RootShell.probe() else RootShell.known()
        val d = JSONObject()
            .put("shizuku_installed", installed)
            .put("shizuku_running", running)
            .put("shizuku_granted", granted)
            .put("su_present", rootPresent)
            .put("app_uid", Process.myUid())
            .put("android_sdk", Build.VERSION.SDK_INT)
        if (running) {
            d.put("shizuku_version", ShizukuState.serverVersion())
            d.put("shizuku_uid", ShizukuState.serverUid())
        }
        if (root != null) d.put("root_granted", root)
        val channel = PrivShell.channel(ctx)
        d.put("available", channel != null || (rootPresent && root == null))
        if (channel != null) d.put("channel", channel)
        val hint = when {
            granted -> null
            requested == false -> "The owner denied the Shizuku permission. It can be granted later in the Shizuku app (Authorized apps → ash)."
            requested == null && args.optBoolean("request_permission") && running ->
                "No answer from the Shizuku permission dialog (some ROMs block it). Ask the owner to open the Shizuku app → Authorized apps → enable ash."
            !installed && !rootPresent -> "Neither Shizuku nor root: the owner can install Shizuku (https://shizuku.rikka.app) and start it via wireless debugging."
            installed && !running -> "Shizuku is installed but its service is not running: the owner must open the Shizuku app and start it (again after each reboot unless rooted)."
            installed && running -> "Shizuku is running but ash is not authorized: call shell.status with request_permission=true."
            else -> null
        }
        if (hint != null) d.put("hint", hint)
        CapResult.json(d)
    }

    val list: List<Capability> = listOf(run, status)
}
