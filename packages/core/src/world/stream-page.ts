import type { DatabaseSync } from "node:sqlite";
import {
  MESSAGE_SUMMARY_EVENT, SummaryPageBudgetV2, isMessageSummaryV2,
  type MessageSummaryV2, type StreamPageEndV2,
} from "../../../sdk/src/api";

type Row = Record<string, unknown>;
export interface StreamPageQuery { after?: number; before?: number; limit?: number }

// The SQL result contains projected metadata only. Raw attachment data never enters
// a JS row, and iteration stops at the first excluded row of the requested order.
const projected = `SELECT m.seq,m.id,m.ts,m."from",m."to",m.kind,m.word,m.reply_to,m.origin,m.turn,m.thread,
  CASE WHEN json_type(m.body,'$.attachments')='array' THEN json_set(json_remove(m.body,'$.attachments'),'$.attachments',
    (SELECT json_group_array(CASE WHEN json_type(a.value,'$.workspace')='text' AND json_type(a.value,'$.path')='text'
      THEN json_object('name',json_extract(a.value,'$.name'),'mime_type',json_extract(a.value,'$.mime_type'),
        'workspace',json_extract(a.value,'$.workspace'),'path',json_extract(a.value,'$.path'),'size',json_extract(a.value,'$.size'))
      ELSE json_object('name',json_extract(a.value,'$.name'),'mime_type',json_extract(a.value,'$.mime_type')) END)
     FROM json_each(m.body,'$.attachments') a)) ELSE m.body END AS body_summary,
  CASE WHEN m.word='say' AND json_type(m.body,'$.attachments')='array' THEN
    (SELECT json_group_array(json_object('index',CAST(a.key AS INTEGER),'name',json_extract(a.value,'$.name'),
      'mime_type',json_extract(a.value,'$.mime_type'),
      'size',(length(json_extract(a.value,'$.data')) / 4 * 3 - CASE substr(json_extract(a.value,'$.data'),-2)
        WHEN '==' THEN 2 ELSE CASE substr(json_extract(a.value,'$.data'),-1) WHEN '=' THEN 1 ELSE 0 END END)))
     FROM json_each(m.body,'$.attachments') a WHERE json_type(a.value,'$.data')='text') ELSE '[]' END AS inline_attachments
  FROM messages m WHERE m.seq`;

export function readSummaryPage(db: DatabaseSync, q: StreamPageQuery = {}): { page: MessageSummaryV2[]; end: StreamPageEndV2 } {
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
  const descending = q.before !== undefined;
  const statement = db.prepare(`${projected}${descending ? "<?" : ">?"} ORDER BY m.seq ${descending ? "DESC" : "ASC"} LIMIT ?`);
  const rows = statement.iterate(descending ? q.before! : q.after ?? 0, limit + 1) as Iterable<Row>;
  const budget = new SummaryPageBudgetV2();
  const page: MessageSummaryV2[] = [];
  let hasMore = false;
  for (const row of rows) {
    if (page.length === limit) { hasMore = true; break; }
    const inline = JSON.parse(String(row.inline_attachments)) as unknown[];
    const summary: MessageSummaryV2 = {
      seq: Number(row.seq), id: String(row.id), ts: Number(row.ts), from: String(row.from),
      to: row.to === null ? null : String(row.to), kind: row.kind as MessageSummaryV2["kind"], word: String(row.word),
      summary: true, body_summary: JSON.parse(String(row.body_summary)),
      ...(row.reply_to === null ? {} : { reply_to: String(row.reply_to) }),
      ...(row.origin === null ? {} : { origin: JSON.parse(String(row.origin)) }),
      ...(row.turn === null ? {} : { turn: String(row.turn) }),
      ...(row.thread == null ? {} : { thread: String(row.thread) }),
      ...(inline.length ? { inline_attachments: inline as MessageSummaryV2["inline_attachments"] } : {}),
    };
    if (!isMessageSummaryV2(summary)) throw new TypeError("invalid database summary projection");
    const frame = `id: ${summary.seq}\nevent: ${MESSAGE_SUMMARY_EVENT}\ndata: ${JSON.stringify(summary)}\n\n`;
    if (!budget.tryInclude(summary.seq, Buffer.byteLength(frame))) { hasMore = true; break; }
    page.push(summary);
  }
  if (descending) page.reverse();
  return { page, end: budget.end(hasMore) };
}
