plugins { id("com.android.application") }

android {
    namespace = "ai.ash.permissionprobe"
    compileSdk = 35
    buildToolsVersion = "35.0.1"
    defaultConfig {
        applicationId = "ai.ash.permissionprobe"
        minSdk = 33
        targetSdk = 33
    }
}
