// The ash hand app: lends the phone's abilities to the kernel over the ash-link/2 link and shows the owner what it sends.
// The kernel (ash core, its payload and the agent container) lives in its own package, android/kernel (ai.ash.kernel).
import java.security.KeyStore
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The ash-link/2 frame schemas that packages/sdk generates (npm run gen:link-schema): the app checks every frame against them.
val linkSchemaDir = rootProject.file("../packages/sdk/schema/link")
val linkSchemaAssets = layout.buildDirectory.dir("generated/link-schema-assets")
val copyLinkSchema by tasks.registering(Sync::class) {
    from(linkSchemaDir) { include("*.json") }
    into(linkSchemaAssets.map { it.dir("link-schema") })
}

android {
    namespace = "ai.ash"
    compileSdk = 35
    buildToolsVersion = "35.0.1"
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "ai.ash.agent"
        minSdk = 26
        // 35, as SPEC-05 asks. What cannot run from files/ at 35 (the payload's executables) lives in the kernel package, which stays on 28.
        targetSdk = 35
        versionCode = 60
        versionName = "0.4.47"
        buildConfigField("boolean", "ISOLATED_PROBE", "false")
        buildConfigField("long", "SENSE_RESCAN_MS", "21600000L")
        // Where the guide downloads the kernel package from when it is not installed (https; empty = no download offered). Set with -PashKernelApkUrl=...
        buildConfigField("String", "KERNEL_APK_URL", "\"${providers.gradleProperty("ashKernelApkUrl").getOrElse("")}\"")
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
            // Opt-in isolated package for emulator probes; never replace the owner's installed app.
            if (providers.gradleProperty("ashIsolatedProbe").orNull == "true") {
                applicationIdSuffix = ".probe"
                buildConfigField("boolean", "ISOLATED_PROBE", "true")
            }
            // Production debug updates must match Claude's last installed/re-signed APK.
            // Isolated probes may use another key, but never silently sign the owner's package with it.
            val probe = providers.gradleProperty("ashIsolatedProbe").orNull == "true"
            val shared = System.getenv("ASH_DEBUG_KEYSTORE")
            val signingFile = file(shared ?: "${System.getProperty("user.home")}/.android/debug.keystore")
            val signingAlias = System.getenv("ASH_DEBUG_ALIAS") ?: if (shared == null) "androiddebugkey" else "ash"
            if (!probe) {
                require(signingFile.isFile) { "Missing installed-app signing key: $signingFile. Do not generate a replacement." }
                val ks = KeyStore.getInstance(signingFile, "android".toCharArray())
                val cert = ks.getCertificate(signingAlias) ?: error("Missing signing alias $signingAlias")
                val digest = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
                    .joinToString("") { "%02x".format(it.toInt() and 255) }
                require(digest == "ace7c87cd62abfdf850a829f473fa4bad222565463570f463a525913fc669cdc") {
                    "Signing certificate does not match the owner's installed Ash/Claude's last APK ($digest). Refusing incompatible update."
                }
            }
            signingConfig = signingConfigs.create("installedDebug") {
                storeFile = signingFile; storePassword = "android"; keyAlias = signingAlias; keyPassword = "android"
            }
        }
        create("sensesProbe") {
            initWith(getByName("debug"))
            matchingFallbacks += listOf("debug")
            applicationIdSuffix = ".sensesprobe"
            buildConfigField("boolean", "ISOLATED_PROBE", "false")
            // Isolated emulator probe only; release keeps the six-hour rolling scan.
            buildConfigField("long", "SENSE_RESCAN_MS", "90000L")
        }
        release {
            isMinifyEnabled = false
            if (System.getenv("ASH_KEYSTORE") != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    sourceSets["main"].assets.srcDir(linkSchemaAssets)
    buildFeatures { buildConfig = true; aidl = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging { resources.excludes += listOf("META-INF/*.kotlin_module") }
    lint { abortOnError = false; checkReleaseBuilds = false }
}

tasks.named("preBuild") { dependsOn(copyLinkSchema) }
// The card cases the core checks too (npm run gen:widget-cards): the phone's tests read them, so they rerun when they change.
tasks.withType<Test>().configureEach { inputs.file(rootProject.file("../packages/core/test/fixtures/widget-cards.json")).withPropertyName("widgetCards") }

dependencies {
    implementation("androidx.webkit:webkit:1.17.1")
    // WindowInsetsCompat, for the one insets helper every screen uses (ai.ash.apps.Ui). Already pulled in by webkit at this version.
    implementation("androidx.core:core:1.12.0")
    // Spring physics for the island's transitions (SpringAnimation).
    implementation("androidx.dynamicanimation:dynamicanimation:1.0.0")
    // Health Connect (read only): the platform's store on Android 14+, the Health Connect app before that.
    // 1.1.0-beta01: the last release that builds with compileSdk 35 and this Android Gradle plugin (1.1.0 needs 36 / 8.9.1).
    implementation("androidx.health.connect:connect-client:1.1.0-beta01")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // The WebSocket under ash-link/2.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // On-phone inference for ocr.read (PP-OCRv6 medium ONNX models, downloaded on first use). The AAR carries arm64 libraries only after abiFilters.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.31.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    // The same ai.onnxruntime API with desktop libraries, so the reader can be run end to end in a unit test when the models are at hand (see OcrEndToEndTest).
    testImplementation("com.microsoft.onnxruntime:onnxruntime:1.31.0")
}

// Unit tests run on the desktop JVM: they take the desktop ONNX Runtime above, not the Android AAR of the same classes.
configurations.matching { it.name.endsWith("UnitTestRuntimeClasspath") || it.name.endsWith("UnitTestCompileClasspath") }.configureEach {
    exclude(group = "com.microsoft.onnxruntime", module = "onnxruntime-android")
}
