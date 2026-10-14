package ai.ash.kernel.host

import ai.ash.kernel.HostApi
import ai.ash.kernel.HostPipe
import ai.ash.kernel.HostSpecInput
import ai.ash.kernel.HostSpecWriter
import ai.ash.kernel.NodeEnv
import ai.ash.kernel.NodeHandle
import ai.ash.kernel.NodeLauncher
import ai.ash.kernel.NodeProcess
import ai.ash.kernel.Paths
import ai.ash.kernel.RotatingLog
import ai.ash.kernel.SystemEnv
import android.util.Log
import java.io.File

/**
 * Starts the core the way [ai.ash.kernel.AndroidNodeLauncher] does, but as the shell user through `run-as`, so the core
 * runs under the kernel package's uid (its data is where it always was) while its parent is the shell host (outside the
 * package's process group and at oom_score_adj -1000 from adbd): the maker's background cleaning does not reach it.
 *
 * What only the kernel package's identity can do — the seal key, writing host.json into the package storage — is done
 * through the bridge. The log and the pid file go to a shell-writable directory (the shell cannot write the package's).
 */
class ShellNodeLauncher(
    private val bridge: IKernelBridge,
    private val kernelPackage: String,
    private val paths: Paths,
    private val sys: SystemEnv,
    private val api: HostApi,
    private val pipe: HostPipe,
    private val runDir: File,
    private val hostVersion: String,
) : NodeLauncher {
    private val logs = File(runDir, "logs")
    private val log = RotatingLog(logs)

    override fun launch(): NodeHandle {
        val proxy = sys.proxy()
        val spec = HostSpecWriter.build(
            HostSpecInput(paths, hostVersion, sys.platform(), proxy, sys.dnsServers(), api.capabilities, logs = logs),
        )
        bridge.writeHostSpec(spec.toString(2))
        val env = NodeEnv.build(paths, paths.hostSpec.path, proxy, System.getenv("ANDROID_DATA") ?: "/data", System.getenv("ANDROID_ROOT") ?: "/system")
        // run-as enters the package's data as its uid; the core binary and data are the same ones the service would use.
        // run-as hands the core this process's pipes: the private pipe between this host and the core.
        return NodeProcess.start(runAs(NodeEnv.command(paths)), env, runDir, log, File(runDir, "node.pid"), HostPipe.bootLine(bridge.sealKey()), pipe::take)
    }

    private fun runAs(nodeCommand: List<String>): List<String> {
        Log.i(TAG, "launching the core through run-as $kernelPackage")
        return listOf(RUN_AS, kernelPackage) + nodeCommand
    }

    companion object {
        private const val RUN_AS = "/system/bin/run-as"
        private const val TAG = "ash.kernel.host"
    }
}
