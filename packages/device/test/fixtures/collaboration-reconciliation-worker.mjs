// Fake-only crash fixture. There is deliberately no native invoke capability here.
import { OperationStore } from "../../src/collaboration/operation-store.ts";
import { DeliveryReconciler } from "../../src/collaboration/reconciliation.ts";
const [file, window] = process.argv.slice(2), store = new OperationStore(file);
const fact = store.get("owner-1", "operation-1");
const reader = { connector_epoch: "epoch-reconnected", native_interface_version: "fake-v1", async readHistoryPage() {
  return { work: fact.work, connector_epoch: "epoch-reconnected", native_interface_version: "fake-v1", source: "codex.saved_history", observed_at: "2026-10-09T00:00:00Z", next_cursor: null,
    items: [{ source_client_message_id: fact.native_client_message_id, native_turn_id: "turn-1", native_message_id: "item-1" }] };
} };
await new DeliveryReconciler({ store, reader, node_id: "node-1", endpoint_id: "endpoint-1", authorize: () => true,
  failpoint(stage) { if (stage === window) process.exit(71); }
}).reconcile({ principal_id: "owner-1" }, "operation-1", fact.work);
process.exit(0);
