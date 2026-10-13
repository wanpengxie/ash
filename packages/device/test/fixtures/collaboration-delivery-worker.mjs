// Fake-only subprocess fixture: the append+fsync marker stands in for native acceptance.
import { openSync, writeSync, fsyncSync, closeSync, existsSync } from "node:fs";
import { OperationStore } from "../../src/collaboration/operation-store.ts";
import { DeliveryJournal } from "../../src/collaboration/delivery.ts";
const [database, calls, mode, window, release] = process.argv.slice(2);
const request = {
  request_id: "request-1", operation_id: "operation-1",
  work: { node_id: "node-1", endpoint_id: "endpoint-1", kind: "conversation", native_id: "thread-1" },
  action: "steer", input: { text: "private-text token-secret" }, expected_turn_id: "active-turn-1", expires_at: 4102444800000,
};
const store = new OperationStore(database);
const journal = new DeliveryJournal({ store, node_id: "node-1", endpoint_id: "endpoint-1", authorize: () => true,
  failpoint(stage) { if (mode === "crash" && stage === window) process.exit(70); },
  adapter: { native_interface_version: "fake-native-v1", connector_epoch: `fake-${process.pid}`, async invoke() {
    const fd = openSync(calls, "a", 0o600); writeSync(fd, "native-accepted\n"); fsyncSync(fd); closeSync(fd);
    if (mode === "hold") {
      process.stdout.write("invoking\n");
      while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { status: "accepted", receipt: { accepted_by: "native", native_turn_id: "active-turn-1", correlation: "uncertain" } };
  } },
});
const fact = await journal.deliver({ principal_id: "owner-1" }, request);
process.stdout.write(`${JSON.stringify(fact)}\n`);
store.close();
