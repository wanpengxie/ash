#!/usr/bin/env node
// Read-only daily counts for the three-day observation. Human judgments stay unscored.
import { DatabaseSync } from "node:sqlite";

const [file, firstDay, dayCountText = "3"] = process.argv.slice(2);
if (!file || !/^\d{4}-\d{2}-\d{2}$/.test(firstDay) || !/^[1-9]\d?$/.test(dayCountText)) {
  console.error("Usage: TZ=<phone timezone> node tools/dogfood-stats.mjs <ash.db> <YYYY-MM-DD> [days]");
  process.exit(2);
}

const days = Array.from({ length: Number(dayCountText) }, (_, offset) => {
  const date = new Date(`${firstDay}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
});
const localDay = (timestamp) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const results = new Map(days.map((day) => [day, {
  day, proactive_messages: 0, notification_success_replies: 0, repeated_notification_replies: 0,
  reflex_stop_decisions: 0, background_cost_usd: 0, background_cost_unknown: 0,
  conversation_cost_usd: null, duplicate_notifications: null, false_interruptions: null, missed_stops: null,
  worthwhile_proactive_messages: null, memory_claims_checked: null,
  memory_claims_correct: null, fabricated_memory_claims: null, abnormal_restarts: null,
}]));

const db = new DatabaseSync(file, { readOnly: true });
try {
  const seenNotifications = new Set();
  const seenProactive = new Set();
  const rows = db.prepare('SELECT ts, "from" AS sender, "to" AS recipient, kind, word, body, reply_to FROM messages ORDER BY seq').iterate();
  for (const row of rows) {
    const day = localDay(row.ts);
    const result = results.get(day);
    if (!result) continue;
    let body;
    try { body = JSON.parse(row.body); } catch { continue; }
    if (row.kind === "event" && row.sender === "service:post" && row.word === "post.delivery" &&
      body.state === "released" && typeof body.message_id === "string" && !seenProactive.has(body.message_id)) {
      const source = db.prepare('SELECT "to" AS recipient, kind, word, body FROM messages WHERE id=?').get(body.message_id);
      if (source?.kind === "request" && source.recipient === "person:owner" && source.word === "say") {
        try { if (["offer", "heads_up"].includes(JSON.parse(source.body).kind)) {
          result.proactive_messages++;
          seenProactive.add(body.message_id);
        } } catch { /* invalid source is not counted */ }
      }
    }
    if (row.kind === "event" && row.word === "reflex.judged" && body.acted === true) result.reflex_stop_decisions++;
    if (row.kind === "event" && row.word === "worker.usage") {
      if (typeof body.cost_usd === "number" && Number.isFinite(body.cost_usd) && body.cost_usd >= 0)
        result.background_cost_usd += body.cost_usd;
      else result.background_cost_unknown++;
    }
    if (row.kind === "response" && row.sender === "service:post" && row.word === "deliver" &&
      body.ok === true && body.result?.channel === "notification" && typeof row.reply_to === "string") {
      const delivery = db.prepare('SELECT body FROM messages WHERE id=?').get(row.reply_to);
      if (!delivery) continue;
      let sourceId;
      try { sourceId = JSON.parse(delivery.body).message_id; } catch { continue; }
      if (typeof sourceId !== "string") continue;
      result.notification_success_replies++;
      if (seenNotifications.has(sourceId)) result.repeated_notification_replies++;
      seenNotifications.add(sourceId);
    }
  }
  console.log(JSON.stringify({ timezone: process.env.TZ || "host local", days: [...results.values()],
    notes: {
      proactive_messages: "Distinct offer/headsup messages released to the owner; human review decides worth.",
      repeated_notification_replies: "A diagnostic only: retry responses can repeat without presenting again. Host evidence decides actual duplicate notifications.",
      reflex_stop_decisions: "Acted decisions, not false-interruption or missed-stop counts.",
      background_cost_usd: "Known worker estimates only; unknown costs are counted separately, never treated as zero.",
      null_metrics: "Require manual review, main-turn usage data, or Android process evidence before pass/fail.",
    } }, null, 2));
} finally { db.close(); }
