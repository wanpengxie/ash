// What Ash and the screen helper share: the bridge between the two apps, and the capability shapes both speak.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.ash.bridge"
    compileSdk = 35
    buildToolsVersion = "35.0.1"
    defaultConfig { minSdk = 24 }
    buildFeatures { aidl = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
