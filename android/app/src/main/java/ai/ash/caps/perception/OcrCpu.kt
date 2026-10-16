package ai.ash.caps.perception

import java.io.File

/** Estimate the performance-core cluster without Android-specific APIs or model/phone names. No affinity is forced. */
object OcrCpu {
    fun threads(root: File = File("/sys/devices/system/cpu"), available: Int = Runtime.getRuntime().availableProcessors()): Int {
        val cpus = runCatching { root.listFiles()?.filter { it.name.matches(Regex("cpu[0-9]+")) } }.getOrNull() ?: emptyList()
        fun read(cpu: File, path: String) = runCatching { File(cpu, path).readText().trim().toLong().takeIf { it > 0 } }.getOrNull()
        val capacities = cpus.mapNotNull { read(it, "cpu_capacity") }
        val speeds = if (capacities.size == cpus.size && capacities.isNotEmpty()) capacities else cpus.mapNotNull { read(it, "cpufreq/cpuinfo_max_freq") }
        return if (speeds.size == cpus.size && speeds.isNotEmpty()) estimate(speeds, available)
        else available.coerceIn(1, 2)
    }

    fun estimate(capacities: List<Long>, available: Int): Int {
        require(available > 0 && capacities.isNotEmpty() && capacities.all { it > 0 })
        val peak = capacities.max()
        return capacities.count { it >= peak * 0.75 }.coerceIn(1, available.coerceAtMost(4))
    }
}
