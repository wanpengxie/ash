// Ash's apps shell 「Ash 应用」: draws each of the owner's apps (an MCP Apps view, HTML) in its own sandboxed WebView,
// its own task and its own home-screen icon. It reaches only Ash (a signature-checked binder), never the apps.
import java.security.KeyStore
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.ash.apps"
    compileSdk = 35
    buildToolsVersion = "35.0.1"

    defaultConfig {
        applicationId = "ai.ash.apps"
        minSdk = 26
        targetSdk = 35
        versionCode = providers.gradleProperty("ashAppsVersionCode").get().toInt()
        versionName = "1.$versionCode"
    }

    buildTypes {
        debug {
            // The same key as Ash: each side only talks to an app signed like itself.
            val shared = System.getenv("ASH_DEBUG_KEYSTORE")
            val signingFile = file(shared ?: "${System.getProperty("user.home")}/.android/debug.keystore")
            val signingAlias = System.getenv("ASH_DEBUG_ALIAS") ?: if (shared == null) "androiddebugkey" else "ash"
            require(signingFile.isFile) { "Missing installed-app signing key: $signingFile. Do not generate a replacement." }
            val ks = KeyStore.getInstance(signingFile, "android".toCharArray())
            val cert = ks.getCertificate(signingAlias) ?: error("Missing signing alias $signingAlias")
            val digest = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it.toInt() and 255) }
            require(digest == "ace7c87cd62abfdf850a829f473fa4bad222565463570f463a525913fc669cdc") {
                "Signing certificate does not match Ash's ($digest): the two apps would not talk to each other."
            }
            signingConfig = signingConfigs.create("installedDebug") {
                storeFile = signingFile; storePassword = "android"; keyAlias = signingAlias; keyPassword = "android"
            }
        }
        release { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    lint { abortOnError = false; checkReleaseBuilds = false }
}

dependencies {
    implementation(project(":bridge"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
