package ai.ash.bridge;

/** Ash, as the screen helper reaches it. Every call is one JSON object. */
oneway interface IAshHost {
    /** The owner acted on the island: {action, turn?, request?, ...}; a request id asks for an islandResult. */
    void islandAction(String action);
    /** The helper's state changed: the status object (see IScreenBridge.status). */
    void changed(String status);
}
