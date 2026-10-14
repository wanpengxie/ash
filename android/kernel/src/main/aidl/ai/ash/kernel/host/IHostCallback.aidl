package ai.ash.kernel.host;

// The shell host, as the kernel-package bridge calls it back: the few things that originate in the app process (an alarm
// the app set went off; the device is shutting down) and must reach the core the shell host supervises.
interface IHostCallback {
    oneway void wakeFired(long atMs);
    oneway void shutdown(String reason);
    // The owner paused or resumed the context probe on the kernel page.
    oneway void setProbe(boolean on);
}
