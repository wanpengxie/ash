package ai.ash.bridge;

/** Ash, as the senses helper reaches it. Every call is one JSON object. */
oneway interface ISensesHost {
    /** Newly recorded rows: {batch_id, word, body}; Ash answers with ISensesBridge.ack(batch_id) once delivered. */
    void senseBatch(String batch);
    /** The helper's state changed: the status object (see ISensesBridge.status). */
    void changed(String status);
}
