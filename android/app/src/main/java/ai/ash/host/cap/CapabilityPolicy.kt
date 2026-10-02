package ai.ash.host.cap

/** Explicit owner-facing classification for every capability exposed by the phone. */
data class CapabilityPolicy(val risk: String, val label: String)

object CapabilityPolicies {
    val byName: Map<String, CapabilityPolicy> = mapOf(
        "clipboard.get" to CapabilityPolicy("none", "读剪贴板"),
        "clipboard.set" to CapabilityPolicy("structure", "改剪贴板"),
        "device.status" to CapabilityPolicy("none", "看手机状态"),
        "apps.list" to CapabilityPolicy("none", "看装了哪些应用"),
        "apps.open" to CapabilityPolicy("outward", "打开应用"),
        "apps.info" to CapabilityPolicy("none", "查看应用信息"),
        "apps.usage" to CapabilityPolicy("none", "看应用使用情况"),
        "settings.open" to CapabilityPolicy("outward", "打开设置"),
        "settings.get" to CapabilityPolicy("none", "读系统设置"),
        "settings.put" to CapabilityPolicy("structure", "改系统设置"),
        "intent.view" to CapabilityPolicy("outward", "打开链接或文件"),
        "input.key" to CapabilityPolicy("outward", "按手机按键"),
        "screen.read" to CapabilityPolicy("none", "读屏幕内容"),
        "screen.see" to CapabilityPolicy("none", "看屏幕"),
        "screen.screenshot" to CapabilityPolicy("none", "截屏"),
        "screen.tap" to CapabilityPolicy("outward", "点屏幕"),
        "screen.type" to CapabilityPolicy("outward", "在屏幕上输入"),
        "screen.scroll" to CapabilityPolicy("outward", "滚动屏幕"),
        "screen.swipe" to CapabilityPolicy("outward", "滑动屏幕"),
        "screen.hold" to CapabilityPolicy("outward", "长按屏幕"),
        "screen.touch" to CapabilityPolicy("outward", "触摸屏幕"),
        "screen.gesture" to CapabilityPolicy("outward", "做屏幕手势"),
        "screen.touch_status" to CapabilityPolicy("none", "看触控状态"),
        "screen.global_action" to CapabilityPolicy("outward", "操作手机屏幕"),
        "shell.run" to CapabilityPolicy("structure", "在手机上执行命令"),
        "shell.status" to CapabilityPolicy("none", "看命令权限"),
        "vscreen.create" to CapabilityPolicy("structure", "创建虚拟屏"),
        "vscreen.status" to CapabilityPolicy("none", "看虚拟屏状态"),
        "vscreen.launch" to CapabilityPolicy("outward", "在虚拟屏里打开应用"),
        "vscreen.see" to CapabilityPolicy("none", "看虚拟屏"),
        "vscreen.tap" to CapabilityPolicy("outward", "点虚拟屏"),
        "vscreen.swipe" to CapabilityPolicy("outward", "滑动虚拟屏"),
        "vscreen.key" to CapabilityPolicy("outward", "在虚拟屏按键"),
        "vscreen.type" to CapabilityPolicy("outward", "在虚拟屏输入"),
        "vscreen.close" to CapabilityPolicy("structure", "关闭虚拟屏"),
        "calendar.search" to CapabilityPolicy("none", "看日历"),
        "calendar.create" to CapabilityPolicy("outward", "添加日历事件"),
    )

    fun require(name: String): CapabilityPolicy = requireNotNull(byName[name]) { "missing capability policy: $name" }
}
