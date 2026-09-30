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
        versionCode = 7
        versionName = "0.2.0"
        ndk { abiFilters += listOf("arm64-v8a") }
    }

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
            // A stable debug key across machines (so updates install over each other).
            val shared = System.getenv("ASH_DEBUG_KEYSTORE")
            if (shared != null) signingConfig = signingConfigs.create("sharedDebug") {
                storeFile = file(shared); storePassword = "android"; keyAlias = System.getenv("ASH_DEBUG_ALIAS") ?: "ash"; keyPassword = "android"
            }
        }
        release {
            isMinifyEnabled = false
            if (System.getenv("ASH_KEYSTORE") != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    sourceSets["main"].assets.srcDir(payloadAssets)

    androidResources {
        // The payload is extracted with java.util.zip: store it, do not compress it twice.
        noCompress += listOf("zip")
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

dependencies {
    implementation(files("libs/shizuku-api.aar", "libs/shizuku-provider.aar", "libs/shizuku-aidl.aar"))
}
