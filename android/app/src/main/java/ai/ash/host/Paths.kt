package ai.ash.host

import android.content.Context
import java.io.File

/**
 * Where everything lives in the app's private storage. The payload is replaceable (app
 * updates swap it); everything under ash/, ash-home/ and dsh-home/ is the user's and survives.
 */
class Paths(ctx: Context) {
    val files: File = ctx.filesDir
    val cache: File = ctx.cacheDir

    /** Extracted payload: runtime/ (node, git, python …), dsh/ (DSH as published), ash/ (ash core), bin/, profile/. */
    val payload = File(files, "payload")
    val payloadStaging = File(files, "payload.new")
    val payloadOld = File(files, "payload.old")

    /** ash core: config, state (event log, tokens, UI URL), log. */
    val ash = File(files, "ash")
    val state = File(ash, "state")
    val config = File(ash, "ash.json")
    val configOverride = File(ash, "config.override.json")
    val coreLog = File(ash, "core.log")
    val uiUrl = File(state, "ui-url")

    /** The main agent's workspace (its cwd; AGENTS.md is its standing brief). */
    val home = File(files, "ash-home")

    /** DSH's home for ash's in-process DSH world (credentials, settings, sessions, plugins). */
    val dshHome = File(files, "dsh-home")

    val tmp = File(cache, "tmp")

    // ---- the payload's own layout
    val node = File(payload, "runtime/bin/node")
    val coreBundle = File(payload, "ash/ash-core.mjs")
    val dshRoot = File(payload, "dsh/lib/node_modules/@deepseek-ai/dsh")
    val compatPreload = File(payload, "dsh/lib/node_modules/android-node-compat/index.cjs")
    val hostPatch = File(payload, "profile/cordis.patch.yml")
    val buildMarker = File(payload, ".build")

    // ---- earlier layouts (0.1.x) we migrate from
    val legacyDshHome = File(payload, "dshhome")
    val legacyCoreState = File(files, "ash-core/state")
    val legacyCoreDshHome = File(files, "ash-core/dsh-home")
    val legacyLink = File(files, "ash-link")
}
