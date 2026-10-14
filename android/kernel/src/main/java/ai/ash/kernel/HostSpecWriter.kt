package ai.ash.kernel

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** What this device is, for `platform`. */
data class Platform(val os: String, val osVersion: String, val arch: String, val model: String, val locale: String, val timezone: String)

/** Everything host.json is made of that is not a path under [Paths]. */
data class HostSpecInput(
    val paths: Paths,
    val hostVersion: String,
    val platform: Platform,
    val proxy: Proxy?,
    val dns: List<String>,
    val capabilities: List<String>,
    val storageBinds: List<String> = listOf("/sdcard:/sdcard", "/storage/emulated/0:/storage/emulated/0"),
    /** A debug build of this package: the core then declares the script agent (`agent:script`) used for device verification. Never true in a release build. */
    val debuggable: Boolean = BuildConfig.DEBUG,
    /** Where the core's log is written: the core reads it back for service:admin/logs. */
    val logs: java.io.File = paths.logs,
)

/** Writes the launch description of `ash-host/1` (packages/sdk/schema/host.json). */
object HostSpecWriter {
    const val CONTRACT = "ash-host/1"

    fun build(i: HostSpecInput): JSONObject {
        val p = i.paths
        return JSONObject()
            .put("contract", CONTRACT)
            .put("host", JSONObject().put("kind", "android").put("version", i.hostVersion))
            .put(
                "platform",
                JSONObject().put("os", i.platform.os).put("os_version", i.platform.osVersion).put("arch", i.platform.arch)
                    .put("model", i.platform.model).put("locale", i.platform.locale).put("timezone", i.platform.timezone),
            )
            .put(
                "dirs",
                JSONObject().put("state", p.state.path).put("home", p.home.path).put("tmp", p.tmp.path)
                    .put("runtime", p.payload.path).put("logs", i.logs.path),
            )
            .put(
                "isolation",
                JSONObject().put("kind", "proot").put(
                    "proot",
                    JSONObject().put("root", p.containerRoot.path).put("rootfs", p.rootfs.path).put("bin", p.prootBin.path)
                        .put("loader", p.prootLoader.path).put("lib", p.prootLib.path)
                        .put("storage_binds", JSONArray(i.storageBinds)).put("dns", JSONArray(i.dns)),
                ),
            )
            .put("network", networkJson(i.proxy))
            .put("capabilities", JSONArray(i.capabilities))
            .put("secure_storage", "keystore")
            .put("dev", JSONObject().put("owner_token", false).put("script_agent", i.debuggable))
    }

    /** Writes host.json readable by this user only (0600), through a temporary file so a reader never sees half of it. */
    fun write(i: HostSpecInput) {
        val target = i.paths.hostSpec
        target.parentFile?.mkdirs()
        val tmp = File(target.path + ".tmp")
        tmp.delete()
        tmp.createNewFile()
        ownerOnly(tmp)
        tmp.writeText(build(i).toString(2))
        if (!tmp.renameTo(target)) throw java.io.IOException("cannot write ${target.name}")
    }

    private fun ownerOnly(f: File) {
        f.setReadable(false, false); f.setWritable(false, false); f.setExecutable(false, false)
        f.setReadable(true, true); f.setWritable(true, true)
    }
}
