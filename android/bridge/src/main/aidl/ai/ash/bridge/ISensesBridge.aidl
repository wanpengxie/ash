package ai.ash.bridge;

import ai.ash.bridge.ISensesHost;

/**
 * The senses helper (ai.ash.senses), as Ash reaches it: location, motion, steps and health data it records on the
 * phone. Only an app signed like the helper may call it. Strings are JSON.
 */
interface ISensesBridge {
    /** Bridge.PROTOCOL of the helper. */
    int protocol();
    /** {version, recording, permissions, sources, pending_batches, ...}. */
    String status();
    /** Its tools: [{name, description, input_schema, confirm?}]. */
    String manifest();
    /** Runs a tool; the pipe carries its result {ok, content, data?, error?} (a long history does not fit a binder call). */
    ParcelFileDescriptor call(String capability, String args);
    /** Ash attaches itself to receive batches of newly recorded rows and status changes. */
    oneway void attach(ISensesHost host);
    /** Ash delivered the batch onward: the helper forgets it. Unacknowledged batches are offered again. */
    oneway void ack(String batchId);
    /** Ash can take batches again (its core came back): every unacknowledged batch is offered now. */
    oneway void pull();
}
