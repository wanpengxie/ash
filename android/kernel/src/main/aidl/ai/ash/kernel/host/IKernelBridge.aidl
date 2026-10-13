package ai.ash.kernel.host;

import ai.ash.kernel.host.IHostCallback;

// The kernel-package app process, as the shell host (uid 2000) calls it. Only the shell and the system may reach it
// (the provider is guarded by INTERACT_ACROSS_USERS_FULL and a uid check). It does what only the kernel package's own
// identity can: the Keystore, the alarm clock, and writing into the package's private storage; the shell host does the
// rest (supervise and launch the core via run-as). attach yields the core to the shell host and lets it hear wakes.
interface IKernelBridge {
    // Installs what the APK carries (payload, then container) into the package's storage; blocks.
    void provision();
    // Writes host.json (the core's launch spec) into the package's storage, where the run-as core reads it.
    void writeHostSpec(String json);
    // The vault's seal key (32 bytes, base64url), unwrapped by the Keystore for this core run.
    String sealKey();
    // The owner identity: its public key (SPKI, base64url) and an id.
    String identityKey();
    // ECDSA P-256 over the base64url data; returns the signature base64url.
    String identitySign(String dataB64u);
    // The device's alarm clock: one alarm, the earliest (wakes the CPU from doze so the core's timer can run).
    void alarmSet(long atMs);
    void alarmCancel();
    // A wake lock held by the package identity, for power.hold / release.
    void powerHold(long ms, String reason);
    void powerRelease();
    // The shell host is in charge of the core now: the kernel service stops its own core and stays yielded while [cb]
    // lives. The bridge calls [cb] on a wake or a device shutdown. Returns the kernel version.
    String attach(IHostCallback cb);
    // Visible launch progress, and whether this host's core has said lifecycle.ready.
    void reportCoreStatus(String text, boolean ready);
    // The context probe's state, for the kernel page (one or a few lines of text).
    void reportProbe(String text);
}
