// The ash kernel package: a status/pairing page. Installs and runs ash core (Node + proot/Ubuntu + DSH), is the Android kernel host
// of the ash-host/1 contract (host.json, the host interface, host events on stdin) and hands the local link to the hand app.
import java.security.KeyStore

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// payload.zip + payload-index.json from `npm run build:payload` (repo root build/payload).
val payloadDir = rootProject.file("../build/payload")
val payloadAssets = layout.buildDirectory.dir("generated/payload-assets")

val copyPayload by tasks.registering(Copy::class) {
    from(payloadDir) { include("payload.zip", "payload-index.json") }
    into(payloadAssets)
    doFirst {
        if (!payloadDir.resolve("payload.zip").exists()) {
            throw GradleException("no payload: run `npm run build:payload` at the repo root first")
        }
    }
}

// The agent container (arm64 Ubuntu + node + DSH + proot) from `npm run build:container`
// (repo root build/container): shipped as assets/container/{ash-container.tgz,VERSION}
// (not .tar.gz: the asset merger would gunzip anything named *.gz).
val containerDir = rootProject.file("../build/container")
val containerAssets = layout.buildDirectory.dir("generated/container-assets")

// A plain task, not part of the Sync: a Sync with nothing to copy is skipped as NO-SOURCE.
val checkContainer by tasks.registering {
    doLast {
        val version = containerDir.resolve("VERSION")
        if (!version.exists()) throw GradleException("no container: run `npm run build:container` at the repo root first")
        val v = version.readText().trim()
        val all = containerDir.listFiles { f -> f.name.matches(Regex("ash-container-.*\\.tar\\.gz")) }.orEmpty().map { it.name }
        if (all != listOf("ash-container-$v.tar.gz")) {
            throw GradleException("build/container/VERSION is $v but the archives are $all: run `npm run build:container` again")
        }
        // The container carries ash's skills and control plugin: a container older than their source must not ship.
        val check = ProcessBuilder("node", rootProject.file("../tools/container-sources.mjs").path, "--check", containerDir.path)
            .redirectErrorStream(true).start()
        val said = check.inputStream.bufferedReader().readText().trim()
        if (check.waitFor() != 0) throw GradleException(said)
    }
}

val copyContainer by tasks.registering(Sync::class) {
    dependsOn(checkContainer)
    from(containerDir) { include("ash-container-*.tar.gz", "VERSION") }
    into(containerAssets.map { it.dir("container") })
    rename("ash-container-.*\\.tar\\.gz", "ash-container.tgz")
}

android {
    namespace = "ai.ash.kernel"
    compileSdk = 35
    buildToolsVersion = "35.0.1"

    defaultConfig {
        applicationId = "ai.ash.kernel"
        minSdk = 26
        // 28 on purpose: the payload's executables (node, git, python, proot) are run from the app's private files/,
        // which Android refuses for apps targeting 29 and above. Same reason the shared-storage permissions work as they do.
        targetSdk = 28
        versionCode = 42
        versionName = "0.4.42"
        ndk { abiFilters += listOf("arm64-v8a") }
    }
    ndkVersion = "27.2.12479018"
    externalNativeBuild { ndkBuild { path = file("src/main/jni/Android.mk") } }

    signingConfigs {
        create("release") {
            val ks = System.getenv("ASH_KEYSTORE")
            if (ks != null) {
                storeFile = file(ks)
                storePassword = System.getenv("ASH_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ASH_KEY_ALIAS") ?: "ash"
                keyPassword = System.getenv("ASH_KEY_PASSWORD") ?: System.getenv("ASH_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            // The same debug key as the hand app: the two signature permissions only work between packages signed alike.
            val shared = System.getenv("ASH_DEBUG_KEYSTORE")
            val signingFile = file(shared ?: "${System.getProperty("user.home")}/.android/debug.keystore")
            val signingAlias = System.getenv("ASH_DEBUG_ALIAS") ?: if (shared == null) "androiddebugkey" else "ash"
            require(signingFile.isFile) { "Missing signing key: $signingFile. Do not generate a replacement." }
            val ks = KeyStore.getInstance(signingFile, "android".toCharArray())
            requireNotNull(ks.getCertificate(signingAlias)) { "Missing signing alias $signingAlias" }
            signingConfig = signingConfigs.create("installedDebug") {
                storeFile = signingFile; storePassword = "android"; keyAlias = signingAlias; keyPassword = "android"
            }
        }
        release {
            isMinifyEnabled = false
            if (System.getenv("ASH_KEYSTORE") != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    sourceSets["main"].assets.srcDir(payloadAssets)
    sourceSets["main"].assets.srcDir(containerAssets)
    buildFeatures { aidl = true; prefab = true; buildConfig = true }

    androidResources {
        // The payload is extracted with java.util.zip and the container with tar -z: store both,
        // do not compress them twice (stored assets also report their length for progress).
        noCompress += listOf("zip", "tgz")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging { resources.excludes += listOf("META-INF/*.kotlin_module") }
    lint { abortOnError = false; checkReleaseBuilds = false }
    testOptions { unitTests.isReturnDefaultValues = true }
}

tasks.named("preBuild") { dependsOn(copyPayload) }
// Only packaging needs the container (unit tests do not merge assets, so they run without it).
tasks.matching { it.name.matches(Regex("merge.*Assets")) }.configureEach { dependsOn(copyContainer) }
// The host.json schema is the contract's own file: the generator is tested against it, so tests rerun when it changes.
tasks.withType<Test>().configureEach {
    val schema = rootProject.file("../packages/sdk/schema/host.json")
    inputs.file(schema).withPropertyName("hostSchema")
    systemProperty("ash.hostSchema", schema.path)
}

dependencies {
    // Pairing with the phone's wireless debugging (host/adb): BoringSSL's SPAKE2 (static), a self-signed cert (okhttp-tls).
    implementation("io.github.vvb2060.ndk:boringssl:20251124")
    implementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
