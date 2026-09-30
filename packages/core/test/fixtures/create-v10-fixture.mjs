// Reproducible, entirely synthetic v1 database. Never source fixture data from a device.
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";

const file = process.argv[2] ?? join(fileURLToPath(new URL(".", import.meta.url)), "v10-ash.db");
if (existsSync(file)) throw new Error("fixture target already exists; choose a new output path");
const db = new DatabaseSync(file);
db.exec(`
  CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    workspace TEXT NOT NULL, member TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX events_ws ON events(workspace, seq);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE timers (id TEXT PRIMARY KEY, owner TEXT NOT NULL, text TEXT NOT NULL,
    fire_at INTEGER NOT NULL, repeat_seconds INTEGER, created_by TEXT NOT NULL);
  CREATE TABLE message_ids (id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
  CREATE TABLE grants (id TEXT PRIMARY KEY, member TEXT NOT NULL, scope TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(member,scope));
  CREATE TABLE confirms (id TEXT PRIMARY KEY, asker TEXT NOT NULL, title TEXT NOT NULL,
    detail TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, answered_by TEXT);
`);
const put = db.prepare("INSERT INTO events(ts,workspace,member,type,data) VALUES(?,?,?,?,?)");
const rows = [
  ["home", "person:owner", "message.delivered", { to: "agent:main", from: "person:owner", text: "Synthetic hello", message_id: "msg-a", mode: "queue", origin: "Sample screen", attachments: [{ name: "sample.txt", mime_type: "text/plain", size: 4, path: "inbox/sample.txt", workspace: "home" }] }],
  ["home", "agent:main", "agent.turn.started", { message_id: "msg-a" }],
  ["home", "agent:main", "agent.status", { status: "running" }],
  ["home", "agent:main", "agent.tool.call", { name: "calendar.search", args: { secret_token: "synthetic-secret-must-not-migrate" }, message_id: "msg-a" }],
  ["home", "agent:main", "agent.tool.result", { name: "calendar.search", ok: true, preview: "synthetic-private-result-must-not-migrate", message_id: "msg-a" }],
  ["home", "agent:main", "call.started", { id: "call-a", device: "device:lab", capability: "calendar.search", caller: "agent:main" }],
  ["home", "agent:main", "call.ended", { id: "call-a", ok: true }],
  ["home", "agent:main", "agent.text", { text: "Synthetic answer", message_id: "msg-a" }],
  ["home", "agent:main", "agent.turn.ended", { message_id: "msg-a", reason: "completed" }],
  ["home", "service:ash", "timer.set", { timer: { id: "timer-a", text: "synthetic reminder" } }],
  ["home", "agent:main", "confirm.requested", { confirmation: { id: "confirm-a", title: "Synthetic approval" } }],
  ["home", "agent:main", "confirm.answered", { confirmation: { id: "confirm-a", state: "approved" } }],
  ["home", "person:owner", "notify", { title: "Synthetic notice", text: "synthetic notice body" }],
  ["secondary", "person:owner", "message.delivered", { to: "agent:helper", from: "person:owner", text: "Synthetic second workspace", message_id: "msg-b" }],
  ["secondary", "agent:helper", "agent.text", { text: "Synthetic second answer", message_id: "msg-b" }],
  ["home", "service:ash", "future.unknown", { private_note: "synthetic-unknown-must-not-migrate" }],
];
for (const [i, [workspace, member, type, data]] of rows.entries()) put.run(1_700_000_000_000 + i, workspace, member, type, JSON.stringify(data));
db.prepare("INSERT INTO kv(key,value) VALUES(?,?)").run("legacy-setting", "preserved");
db.close();
