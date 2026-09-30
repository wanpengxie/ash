plugins { id("com.android.application") }

android {
    namespace = "ai.ash.permissionprobe"
    compileSdk = 35
    buildToolsVersion = "35.0.1"
    defaultConfig {
        applicationId = providers.gradleProperty("probeApplicationId").orNull ?: "ai.ash.permissionprobe"
        minSdk = providers.gradleProperty("probeMinSdk").orNull?.toInt() ?: 33
        targetSdk = providers.gradleProperty("probeTargetSdk").orNull?.toInt() ?: 33
    }
}
