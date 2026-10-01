package ai.ash.host.cap

/** Explicit owner-facing classification for every capability exposed by the phone. */
data class CapabilityPolicy(val risk: String, val label: String)

object CapabilityPolicies {
    val byName: Map<String, CapabilityPolicy> = mapOf(
        "clipboard.get" to CapabilityPolicy("none", "Reading the clipboard"),
        "clipboard.set" to CapabilityPolicy("structure", "Changing the clipboard"),
        "device.status" to CapabilityPolicy("none", "Checking phone status"),
        "apps.list" to CapabilityPolicy("none", "Listing apps"),
        "apps.open" to CapabilityPolicy("outward", "Opening an app"),
        "apps.info" to CapabilityPolicy("none", "Checking an app"),
        "apps.usage" to CapabilityPolicy("none", "Checking app usage"),
        "settings.open" to CapabilityPolicy("outward", "Opening settings"),
        "settings.get" to CapabilityPolicy("none", "Reading settings"),
        "settings.put" to CapabilityPolicy("structure", "Changing settings"),
        "intent.view" to CapabilityPolicy("outward", "Opening a link or file"),
        "input.key" to CapabilityPolicy("outward", "Pressing a phone key"),
        "screen.read" to CapabilityPolicy("none", "Reading the screen"),
        "screen.see" to CapabilityPolicy("none", "Looking at the screen"),
        "screen.screenshot" to CapabilityPolicy("none", "Taking a screenshot"),
        "screen.tap" to CapabilityPolicy("outward", "Tapping the screen"),
        "screen.type" to CapabilityPolicy("outward", "Typing on the screen"),
        "screen.scroll" to CapabilityPolicy("outward", "Scrolling the screen"),
        "screen.swipe" to CapabilityPolicy("outward", "Swiping the screen"),
        "screen.hold" to CapabilityPolicy("outward", "Holding the screen"),
        "screen.touch" to CapabilityPolicy("outward", "Touching the screen"),
        "screen.gesture" to CapabilityPolicy("outward", "Using a screen gesture"),
        "screen.touch_status" to CapabilityPolicy("none", "Checking screen touch state"),
        "screen.global_action" to CapabilityPolicy("outward", "Controlling the phone screen"),
        "shell.run" to CapabilityPolicy("structure", "Running a privileged command"),
        "shell.status" to CapabilityPolicy("none", "Checking privileged access"),
        "vscreen.create" to CapabilityPolicy("structure", "Creating a virtual screen"),
        "vscreen.status" to CapabilityPolicy("none", "Checking the virtual screen"),
        "vscreen.launch" to CapabilityPolicy("outward", "Opening an app virtually"),
        "vscreen.see" to CapabilityPolicy("none", "Looking at the virtual screen"),
        "vscreen.tap" to CapabilityPolicy("outward", "Tapping the virtual screen"),
        "vscreen.swipe" to CapabilityPolicy("outward", "Swiping the virtual screen"),
        "vscreen.key" to CapabilityPolicy("outward", "Pressing a virtual key"),
        "vscreen.type" to CapabilityPolicy("outward", "Typing on the virtual screen"),
        "vscreen.close" to CapabilityPolicy("structure", "Closing the virtual screen"),
        "calendar.search" to CapabilityPolicy("none", "Checking your calendar"),
        "calendar.create" to CapabilityPolicy("outward", "Adding a calendar event"),
    )

    fun require(name: String): CapabilityPolicy = requireNotNull(byName[name]) { "missing capability policy: $name" }
}
