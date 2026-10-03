// The ash Android host: keeps ash core alive, lends the phone's abilities to it, shows its UI.
// Everything agent-related lives in ash core (the payload); this app has no business logic.

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

// A plain task, not part of the Copy: a Copy with nothing to copy is skipped as NO-SOURCE.
val checkContainer by tasks.registering {
    doLast {
        val version = containerDir.resolve("VERSION")
        if (!version.exists()) throw GradleException("no container: run `npm run build:container` at the repo root first")
        val v = version.readText().trim()
        val all = containerDir.listFiles { f -> f.name.matches(Regex("ash-container-.*\\.tar\\.gz")) }.orEmpty().map { it.name }
        if (all != listOf("ash-container-$v.tar.gz")) {
            throw GradleException("build/container/VERSION is $v but the archives are $all: run `npm run build:container` again")
        }
    }
}

val copyContainer by tasks.registering(Sync::class) {
    dependsOn(checkContainer)
    from(containerDir) { include("ash-container-*.tar.gz", "VERSION") }
    into(containerAssets.map { it.dir("container") })
    rename("ash-container-.*\\.tar\\.gz", "ash-container.tgz")
}

android {
    namespace = "ai.ash"
    compileSdk = 35
    buildToolsVersion = "35.0.1"

    defaultConfig {
        applicationId = "ai.ash.agent"
        minSdk = 24
        // 28 on purpose: from 29 on, app-private files are no longer executable (the payload's
        // node/git/python run from files/). Moving binaries to jniLibs is a separate project.
        targetSdk = 28
        versionCode = 11
        versionName = "0.3.0"
        buildConfigField("int", "CORE_PORT", "4700")
        buildConfigField("int", "HOST_PORT", "4710")
        buildConfigField("int", "SENSE_PORT", "4700")
        buildConfigField("boolean", "ISOLATED_PROBE", "false")
        buildConfigField("long", "SENSE_RESCAN_MS", "21600000L")
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
            // Opt-in isolated package for emulator probes; never replace the owner's installed app.
            if (providers.gradleProperty("ashIsolatedProbe").orNull == "true") {
                applicationIdSuffix = ".probe"
                buildConfigField("int", "CORE_PORT", "14763")
                buildConfigField("int", "HOST_PORT", "14764")
                buildConfigField("int", "SENSE_PORT", "14763")
                buildConfigField("boolean", "ISOLATED_PROBE", "true")
            }
            // A stable debug key across machines (so updates install over each other).
            val shared = System.getenv("ASH_DEBUG_KEYSTORE")
            if (shared != null) signingConfig = signingConfigs.create("sharedDebug") {
                storeFile = file(shared); storePassword = "android"; keyAlias = System.getenv("ASH_DEBUG_ALIAS") ?: "ash"; keyPassword = "android"
            }
        }
        create("sensesProbe") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".sensesprobe"
            buildConfigField("int", "CORE_PORT", "4700")
            buildConfigField("int", "HOST_PORT", "4710")
            buildConfigField("boolean", "ISOLATED_PROBE", "false")
            buildConfigField("int", "SENSE_PORT", "4870")
            // Isolated emulator probe only; release keeps the six-hour rolling scan.
            buildConfigField("long", "SENSE_RESCAN_MS", "90000L")
        }
        release {
            isMinifyEnabled = false
            if (System.getenv("ASH_KEYSTORE") != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    sourceSets["main"].assets.srcDir(payloadAssets)
    sourceSets["main"].assets.srcDir(containerAssets)
    buildFeatures { buildConfig = true }

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
}

tasks.named("preBuild") { dependsOn(copyPayload) }
// Only packaging needs the container (unit tests do not merge assets, so they run without it).
tasks.matching { it.name.matches(Regex("merge.*Assets")) }.configureEach { dependsOn(copyContainer) }

dependencies {
    implementation(files("libs/shizuku-api.aar", "libs/shizuku-provider.aar", "libs/shizuku-aidl.aar"))
    implementation("androidx.webkit:webkit:1.17.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
