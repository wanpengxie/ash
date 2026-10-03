// Loaded by ash core at start on the phone. Marks the core process non-dumpable, so a process of the same Linux user
// (everything in the agent container runs as the app's user) cannot read core's memory or environment through /proc.
#include <sys/prctl.h>

__attribute__((constructor)) static void ash_nodump(void) { prctl(PR_SET_DUMPABLE, 0, 0, 0, 0); }
