package ai.ash.caps.perception

import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.file.Files
import java.io.File

class OcrCpuTest {
    @Test fun estimatesThePerformanceClusterWithoutAPhoneName() {
        assertEquals(4, OcrCpu.estimate(listOf(1800L, 1800, 1800, 1800, 2800, 2800, 2800, 3200), 8))
        assertEquals(2, OcrCpu.estimate(listOf(512L, 512, 512, 512, 512, 512, 1024, 1024), 8))
        assertEquals(1, OcrCpu.estimate(listOf(100L, 100), 1))
    }

    @Test fun inaccessibleTopologyUsesASmallFallback() {
        val root = Files.createTempDirectory("ocr-cpu-test").toFile()
        try { assertEquals(2, OcrCpu.threads(root, 8)); assertEquals(1, OcrCpu.threads(root, 1)) }
        finally { root.deleteRecursively() }
    }

    @Test fun readsCapacityBeforeFrequencyAndFallsBackWhenFilesAreIncomplete() {
        val root = Files.createTempDirectory("ocr-cpu-topology").toFile()
        try {
            for (i in 0 until 8) {
                val cpu = File(root, "cpu$i").apply { mkdirs() }
                File(cpu, "cpu_capacity").writeText(if (i == 7) "1024" else "512")
                File(cpu, "cpufreq").mkdirs()
                File(cpu, "cpufreq/cpuinfo_max_freq").writeText(if (i >= 6) "3000000" else "1800000")
            }
            assertEquals(1, OcrCpu.threads(root, 8))
            File(root, "cpu0/cpu_capacity").delete()
            assertEquals(2, OcrCpu.threads(root, 8))
            File(root, "cpu0/cpufreq/cpuinfo_max_freq").delete()
            assertEquals(2, OcrCpu.threads(root, 8))
        } finally { root.deleteRecursively() }
    }
}
