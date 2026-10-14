package ai.ash.caps.perception

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Why speech could not be made: [code] is one of the unified error codes, the message says it for the agent. */
class TtsFailure(val code: String, message: String) : Exception(message)

class Spoken(val durationMs: Long, val lang: String, val voice: String?, val engine: String?)

/**
 * The phone's own speech engine (Android TextToSpeech: whatever the maker or the owner set as the default, offline when its
 * voice data is installed). One utterance at a time; the engine is bound on first use and let go of after [IDLE_MS].
 */
class SystemTts(private val ctx: Context) {
    private var tts: TextToSpeech? = null
    private var release: ScheduledFuture<*>? = null
    private val running = ConcurrentHashMap<String, Run>()

    private class Run { val started = CountDownLatch(1); val finished = CountDownLatch(1); @Volatile var error: Int? = null; @Volatile var t0 = 0L; @Volatile var t1 = 0L }

    /** Whether an app that provides speech is installed at all; says nothing about its voice data. */
    fun installed(): Boolean = ctx.packageManager.queryIntentServices(Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0).isNotEmpty()

    /** Says [text] aloud on the phone; returns when it has been said. */
    @Synchronized fun play(text: String, a: TtsSpeakArgs): Spoken = use(a, text) { engine, chosen ->
        configure(engine, a)
        val run = Run()
        val id = "play-${System.nanoTime()}"
        running[id] = run
        try {
            val queued = engine.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), id)
            if (queued != TextToSpeech.SUCCESS) throw TtsFailure("failed", "the speech engine refused the text")
            await(engine, run, text, "play")
            Spoken(maxOf(0, run.t1 - run.t0), chosen.toLanguageTag(), engine.voice?.name, engine.defaultEngine)
        } finally {
            running.remove(id)
        }
    }

    /** Writes [text] spoken to [out] as audio (what the engine writes: WAV); returns how long it is. */
    @Synchronized fun render(text: String, a: TtsSpeakArgs, out: File): Spoken = use(a, text) { engine, chosen ->
        configure(engine, a)
        val run = Run()
        val id = "file-${System.nanoTime()}"
        running[id] = run
        try {
            out.parentFile?.mkdirs()
            out.delete()
            val queued = engine.synthesizeToFile(text, Bundle(), out, id)
            if (queued != TextToSpeech.SUCCESS) throw TtsFailure("failed", "the speech engine refused the text")
            await(engine, run, text, "write")
            val ms = Wav.durationMs(out) ?: throw TtsFailure("failed", "the speech engine wrote a file that is not WAV audio")
            Spoken(ms, chosen.toLanguageTag(), engine.voice?.name, engine.defaultEngine)
        } finally {
            running.remove(id)
        }
    }

    @Synchronized fun shutdown() {
        tts?.shutdown()
        tts = null
    }

    private fun await(engine: TextToSpeech, run: Run, text: String, what: String) {
        // Seconds of speech are about a tenth of a second per character; the rest is the engine waking up.
        val limitMs = 20_000L + text.length * 300L
        if (!run.finished.await(limitMs, TimeUnit.MILLISECONDS)) {
            engine.stop()
            throw TtsFailure("timeout", "the speech engine did not finish within ${limitMs / 1000}s")
        }
        run.error?.let { throw TtsFailure("failed", "the speech engine failed to $what the text (error $it)") }
    }

    private fun configure(engine: TextToSpeech, a: TtsSpeakArgs) {
        engine.setSpeechRate(a.rate)
        engine.setPitch(a.pitch)
    }

    /** Runs [block] with the engine set to the language and voice asked for. */
    private fun <T> use(a: TtsSpeakArgs, text: String, block: (TextToSpeech, Locale) -> T): T {
        release?.cancel(false)
        try {
            val engine = tts ?: bind()
            val wanted = a.lang?.let { PerceptionArguments.locale(it) } ?: PerceptionArguments.languageOf(text)
            val chosen = pick(engine, wanted)
            engine.language = chosen
            if (a.voice != null) {
                val voice = engine.voices.orEmpty().firstOrNull { it.name == a.voice }
                    ?: throw TtsFailure("bad_request", "the speech engine has no voice named ${a.voice}; for ${chosen.toLanguageTag()} it has: " +
                        engine.voices.orEmpty().filter { it.locale.language == chosen.language }.joinToString { it.name }.ifEmpty { "(none)" })
                engine.voice = voice
            }
            return block(engine, chosen)
        } finally {
            release = idle.schedule({ shutdown() }, IDLE_MS, TimeUnit.MILLISECONDS)
        }
    }

    private fun bind(): TextToSpeech {
        val ready = CountDownLatch(1)
        var status = TextToSpeech.ERROR
        val created = TextToSpeech(ctx) { s -> status = s; ready.countDown() }
        if (!ready.await(10, TimeUnit.SECONDS) || status != TextToSpeech.SUCCESS) {
            created.shutdown()
            throw TtsFailure("unavailable", "the phone's speech engine did not start" + if (installed()) " (check the default engine in the phone's text-to-speech settings)" else ": no speech engine is installed")
        }
        created.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        created.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) { running[utteranceId]?.let { it.t0 = System.currentTimeMillis(); it.started.countDown() } }
            override fun onDone(utteranceId: String?) { running[utteranceId]?.let { it.t1 = System.currentTimeMillis(); it.finished.countDown() } }
            @Deprecated("Deprecated in Java") override fun onError(utteranceId: String?) { onError(utteranceId, -1) }
            override fun onError(utteranceId: String?, errorCode: Int) { running[utteranceId]?.let { it.error = errorCode; it.t1 = System.currentTimeMillis(); it.finished.countDown() } }
        })
        tts = created
        return created
    }

    /** [wanted], or another variant of its language the engine has voice data for. */
    private fun pick(engine: TextToSpeech, wanted: Locale): Locale {
        val tries = listOf(wanted, Locale(wanted.language, wanted.country), Locale(wanted.language))
        for (l in tries) if (engine.isLanguageAvailable(l) >= TextToSpeech.LANG_AVAILABLE) return l
        throw TtsFailure("unavailable", "the phone's speech engine (${engine.defaultEngine}) has no voice for ${wanted.toLanguageTag()} " +
            "(install its voice data in the phone's text-to-speech settings, or pick another language)")
    }

    companion object {
        const val IDLE_MS = 60_000L
        private val idle = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "tts-idle").apply { isDaemon = true } }
    }
}

/** What the speech engine writes: RIFF/WAVE with 16-bit PCM or similar; just enough of the header to tell its length. */
object Wav {
    /** The playing time in ms from the header of [file], or null when it is not a WAV file. */
    fun durationMs(file: File): Long? = file.inputStream().use { input ->
        val head = ByteArray(minOf(4096L, file.length()).toInt())
        input.read(head)
        durationMs(head, file.length())
    }

    fun durationMs(head: ByteArray, fileLength: Long): Long? {
        fun u32(i: Int) = (head[i].toLong() and 255) or ((head[i + 1].toLong() and 255) shl 8) or ((head[i + 2].toLong() and 255) shl 16) or ((head[i + 3].toLong() and 255) shl 24)
        fun tag(i: Int, s: String) = i + 4 <= head.size && s.indices.all { head[i + it].toInt() == s[it].code }
        if (head.size < 12 || !tag(0, "RIFF") || !tag(8, "WAVE")) return null
        var byteRate = 0L
        var i = 12
        while (i + 8 <= head.size) {
            val size = u32(i + 4)
            if (tag(i, "fmt ") && i + 20 <= head.size) byteRate = u32(i + 16)
            if (tag(i, "data")) {
                // A streaming engine may leave the size at 0 or "unknown"; the rest of the file is the data then.
                val bytes = if (size == 0L || size == 0xffffffffL || i + 8 + size > fileLength) fileLength - (i + 8) else size
                return if (byteRate > 0) bytes * 1000 / byteRate else null
            }
            if (size > head.size) return null
            i += 8 + size.toInt() + (size.toInt() and 1)
        }
        return null
    }
}
