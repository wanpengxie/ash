package ai.ash.senses

import ai.ash.host.cap.CapResult

/**
 * Why a tool could not answer, with a code the caller can act on. Never answered with made-up data instead.
 *
 * permission_denied, location_off, source_unavailable, unsupported_schema, not_recording, bad_args, no_fix, timeout.
 */
class SenseError(val code: String, message: String) : Exception(message) {
    fun result(): CapResult = CapResult.error(code, message ?: code)

    companion object {
        fun badArgs(message: String) = SenseError("bad_args", message)
    }
}
