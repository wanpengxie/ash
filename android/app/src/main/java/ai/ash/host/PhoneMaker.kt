package ai.ash.host

import android.os.Build

/**
 * Phone makers whose systems keep switches of their own over apps' notifications and background running. Android gives
 * an app no way to read them, so Ash names them for the owner, in the words of that system's settings.
 */
enum class PhoneMaker(
    /** Ash's notification settings page: what to switch on so a reminder rings and vibrates. */
    val alerts: String,
    /** The screen helper's app info page: what to switch on so the system does not clear it. */
    val keepAlive: String,
    /** The recent-apps screen: how to lock an app's card so clearing the background leaves it. */
    val lock: String,
) {
    COLOROS("打开「铃声」「振动」，并勾选「横幅」和「锁屏」",
        "进入「耗电管理」，打开「允许完全后台行为」「允许自动启动」「允许关联启动」",
        "打开最近任务，点它卡片右上角的「⋮」（或按住卡片往下拉），选「锁定」"),
    HYPEROS("打开「悬浮通知」「锁屏通知」「响铃」「振动」",
        "打开「自启动」；「省电策略」选「无限制」",
        "打开最近任务，按住它的卡片，点锁形图标"),
    ORIGINOS("打开「横幅」「声音」「振动」",
        "进入「后台耗电管理」选「允许后台高耗电」，并打开「自启动」",
        "打开最近任务，把它的卡片往下拉，点「锁定」"),
    HARMONY("打开「横幅通知」「铃声」「振动」",
        "进入「应用启动管理」，改为手动管理，把「允许自启动」「允许关联启动」「允许后台活动」都打开",
        "打开最近任务，把它的卡片往下拉，加上锁"),
    OTHER("确认通知允许横幅、声音和振动",
        "如果系统有「自启动」或「后台运行」之类的开关，请为它打开",
        "如果最近任务里能锁定应用，把它的卡片锁上");

    /** Stock Android reports these settings to the app; the makers above keep their own on top. */
    val ownSwitches get() = this != OTHER

    companion object {
        val current: PhoneMaker by lazy {
            when (Build.MANUFACTURER.lowercase()) {
                "oppo", "oneplus", "realme" -> COLOROS
                "xiaomi", "redmi", "poco" -> HYPEROS
                "vivo", "iqoo" -> ORIGINOS
                "huawei", "honor" -> HARMONY
                else -> OTHER
            }
        }
    }
}
