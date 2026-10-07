package ai.ash.host.cap

/**
 * Explicit owner-facing classification for every capability exposed by the phone.
 *
 * `effect` says what the word does to the world, for the gate: "read" (only looks), "act" (operates
 * the phone or an app as the owner would), "write" (changes stored data or settings), "send"
 * (speaks to other people), "execute" (runs arbitrary code), "structure" (changes ash itself).
 */
data class CapabilityPolicy(val risk: String, val effect: String, val label: String) {
    init {
        require(effect in EFFECTS) { "unknown effect $effect" }
    }

    companion object {
        val EFFECTS = setOf("read", "act", "write", "send", "execute", "structure")
    }
}

object CapabilityPolicies {
    val byName: Map<String, CapabilityPolicy> = mapOf(
        "clipboard.get" to CapabilityPolicy("none", "read", "读剪贴板"),
        "clipboard.set" to CapabilityPolicy("structure", "act", "改剪贴板"),
        "device.status" to CapabilityPolicy("none", "read", "看手机状态"),
        "apps.list" to CapabilityPolicy("none", "read", "看装了哪些应用"),
        "apps.open" to CapabilityPolicy("outward", "act", "打开应用"),
        "apps.info" to CapabilityPolicy("none", "read", "查看应用信息"),
        "apps.usage" to CapabilityPolicy("none", "read", "看应用使用情况"),
        "settings.open" to CapabilityPolicy("outward", "act", "打开设置"),
        "settings.get" to CapabilityPolicy("none", "read", "读系统设置"),
        "settings.put" to CapabilityPolicy("structure", "write", "改系统设置"),
        "intent.view" to CapabilityPolicy("outward", "act", "打开链接或文件"),
        "input.key" to CapabilityPolicy("outward", "act", "按手机按键"),
        "screen.read" to CapabilityPolicy("none", "read", "读屏幕内容"),
        "screen.see" to CapabilityPolicy("none", "read", "看屏幕"),
        "screen.screenshot" to CapabilityPolicy("none", "read", "截屏"),
        "screen.capture" to CapabilityPolicy("none", "read", "截屏"),
        "screen.tap" to CapabilityPolicy("outward", "act", "点屏幕"),
        "screen.type" to CapabilityPolicy("outward", "act", "在屏幕上输入"),
        "screen.scroll" to CapabilityPolicy("outward", "act", "滚动屏幕"),
        "screen.swipe" to CapabilityPolicy("outward", "act", "滑动屏幕"),
        "screen.hold" to CapabilityPolicy("outward", "act", "长按屏幕"),
        "screen.touch" to CapabilityPolicy("outward", "act", "触摸屏幕"),
        "screen.gesture" to CapabilityPolicy("outward", "act", "做屏幕手势"),
        "screen.touch_status" to CapabilityPolicy("none", "read", "看触控状态"),
        "screen.global_action" to CapabilityPolicy("outward", "act", "操作手机屏幕"),
        "shell.run" to CapabilityPolicy("structure", "execute", "在手机上执行命令"),
        "shell.status" to CapabilityPolicy("none", "read", "看命令权限"),
        "vscreen.create" to CapabilityPolicy("structure", "act", "创建虚拟屏"),
        "vscreen.status" to CapabilityPolicy("none", "read", "看虚拟屏状态"),
        "vscreen.launch" to CapabilityPolicy("outward", "act", "在虚拟屏里打开应用"),
        "vscreen.see" to CapabilityPolicy("none", "read", "看虚拟屏"),
        "vscreen.tap" to CapabilityPolicy("outward", "act", "点虚拟屏"),
        "vscreen.swipe" to CapabilityPolicy("outward", "act", "滑动虚拟屏"),
        "vscreen.key" to CapabilityPolicy("outward", "act", "在虚拟屏按键"),
        "vscreen.type" to CapabilityPolicy("outward", "act", "在虚拟屏输入"),
        "vscreen.close" to CapabilityPolicy("structure", "act", "关闭虚拟屏"),
        "calendar.search" to CapabilityPolicy("none", "read", "看日历"),
        "calendar.create" to CapabilityPolicy("outward", "write", "添加日历事件"),
        "browser.open" to CapabilityPolicy("none", "read", "打开网页"),
        "browser.read" to CapabilityPolicy("none", "read", "读网页"),
        "browser.click" to CapabilityPolicy("outward", "act", "在网页上点击"),
        "browser.type" to CapabilityPolicy("outward", "act", "在网页上输入"),
        "browser.scroll" to CapabilityPolicy("none", "read", "滚动网页"),
        "browser.back" to CapabilityPolicy("none", "read", "回到上一页"),
        "browser.screenshot" to CapabilityPolicy("none", "read", "给网页截图"),
        "browser.show" to CapabilityPolicy("none", "read", "请你看一下浏览器"),
        "browser.close" to CapabilityPolicy("none", "read", "关闭浏览器"),
        "browser.spaces" to CapabilityPolicy("none", "read", "看打开了哪些网页"),
        "browser.run" to CapabilityPolicy("outward", "act", "在浏览器里连续操作"),
        // The owner's photos, videos and files: Android's storage permission is the boundary, granted once by the owner.
        "media.list" to CapabilityPolicy("none", "read", "看你的照片和视频"),
        "media.albums" to CapabilityPolicy("none", "read", "看你的相册"),
        "media.read" to CapabilityPolicy("none", "read", "看你的照片"),
        "media.save" to CapabilityPolicy("none", "write", "存图片到相册"),
        "camera.capture" to CapabilityPolicy("outward", "act", "请你拍照"),
        // The senses helper (Ash 感知): reading what it recorded or what a source holds needs no approval; changing what is
        // recorded, deleting records, or driving another app (Gadgetbridge) does.
        "location.get" to CapabilityPolicy("none", "read", "看手机位置"),
        "location.history" to CapabilityPolicy("none", "read", "看位置记录"),
        "location.track" to CapabilityPolicy("none", "write", "开关位置记录"),
        "activity.current" to CapabilityPolicy("none", "read", "看运动状态"),
        "activity.history" to CapabilityPolicy("none", "read", "看运动记录"),
        "sensors.steps" to CapabilityPolicy("none", "read", "看今日步数"),
        "health.sources" to CapabilityPolicy("none", "read", "看健康数据来源"),
        "health.read" to CapabilityPolicy("none", "read", "读健康数据"),
        "health.summary" to CapabilityPolicy("none", "read", "看健康汇总"),
        "health.sync" to CapabilityPolicy("none", "act", "让手表同步健康数据"),
        "sense.status" to CapabilityPolicy("none", "read", "看感知记录状态"),
        "sense.configure" to CapabilityPolicy("none", "write", "改感知记录设置"),
        "sense.delete" to CapabilityPolicy("structure", "write", "删除感知记录"),
    )

    fun require(name: String): CapabilityPolicy = requireNotNull(byName[name]) { "missing capability policy: $name" }
}
