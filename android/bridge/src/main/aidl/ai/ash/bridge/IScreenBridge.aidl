package ai.ash.bridge;

import ai.ash.bridge.IAshHost;

/**
 * The screen helper (ai.ash.screen), as Ash reaches it: its accessibility service's tools and the task island it draws.
 * Only an app signed like the helper may call it. Strings are JSON.
 */
interface IScreenBridge {
    /** Bridge.PROTOCOL of the helper. */
    int protocol();
    /** {version, accessibility, screenshot, island_ready, island_shown}. */
    String status();
    /** The tools it can run now: [{name, description, input_schema, confirm?}]. */
    String manifest();
    /** Runs a tool; the pipe carries its result {ok, content, data?, error?} (a screenshot does not fit a binder call). */
    ParcelFileDescriptor call(String capability, String args);
    /** {foreground_package, epoch}; settle first waits for the screen to settle. */
    String screenState(boolean settle);
    /** Lets the agent's own input pass under the island. "" when it may, else the reason (the owner is typing). */
    String guard(String token);
    oneway void release(String token);
    /** Ash attaches itself to receive the owner's island actions and status changes. */
    oneway void attach(IAshHost host);
    /** What the island shows: {show, model?, ash_in_front}. */
    oneway void island(String state);
    /** The outcome of an island action that asked for one: {request, ok, message}. */
    oneway void islandResult(String result);
}
