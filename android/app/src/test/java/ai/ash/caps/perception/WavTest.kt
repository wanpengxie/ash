package ai.ash.caps.perception

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class WavTest {
    /** A canonical 44-byte header for [dataBytes] of 16-bit mono PCM at [rate] Hz. */
    private fun header(rate: Int, dataBytes: Int, dataSize: Int = dataBytes): ByteArray = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
        put("RIFF".toByteArray()); putInt(36 + dataBytes); put("WAVE".toByteArray())
        put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1); putInt(rate); putInt(rate * 2); putShort(2); putShort(16)
        put("data".toByteArray()); putInt(dataSize)
    }.array()

    @Test fun lengthComesFromTheDataChunkAndTheByteRate() {
        assertEquals(1000L, Wav.durationMs(header(22050, 44100), 44 + 44100L))
        assertEquals(2500L, Wav.durationMs(header(16000, 80000), 44 + 80000L))
    }

    @Test fun aStreamedFileWithAnUnknownSizeUsesTheRestOfTheFile() {
        assertEquals(1000L, Wav.durationMs(header(22050, 44100, dataSize = 0), 44 + 44100L))
        assertEquals(1000L, Wav.durationMs(header(22050, 44100, dataSize = -1), 44 + 44100L))
    }

    @Test fun somethingElseIsNotWav() {
        assertNull(Wav.durationMs("ID3\u0004 not audio at all".toByteArray(), 30))
        assertNull(Wav.durationMs(ByteArray(5), 5))
    }
}
