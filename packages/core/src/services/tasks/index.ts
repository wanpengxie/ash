/** The task app's single durable state. All reminders use service:clock; no UI owns a timer. */
import { createHash, randomBytes } from "node:crypto";
import { isAgentId, OWNER_ID } from "../../../../sdk/src/ids";
import { WordError, type Caller, type HandleContext, type Message, type Reply, type WordResult } from "../../../../sdk/src/message";
import { wordsOf, TASK_STATUSES } from "../../../../sdk/src/words";
import type { Member, WordContract } from "../../../../sdk/src/word";
import type { Ledger } from "../../kernel/ledger";
import type { Router } from "../../kernel/types";
import { TASKS_ID, cardId, cardOf, followUpAt, isOpen, parseTime, type CardKind, type Task } from "./cards";

export { TASKS_ID, type Task } from "./cards";
type Body = Record<string, any>;
type Notice = { id: string; task_id: string; kind: CardKind | "report"; stamp: number; sent: number };
type Stored = { data: string; reminder_sent: number | null; follow_sent: number | null };
interface Options { ledger: Ledger; router: Pick<Router, "send">; now?: () => number; log?: (message: string, error?: unknown) => void }
const SELF: Caller = { member: TASKS_ID, via: "service", local: true };
const PREFIX = "tasks:";
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])) : value;
const fingerprint = (body: Body) => JSON.stringify(canonical(body));

export class TasksService implements Member {
  readonly id = TASKS_ID;
  readonly kind = "service" as const;
  readonly name = "Tasks";
  private readonly db;
  private readonly now;
  // Small writes and their effects are ordered; no revision numbers or compare-and-set protocol.
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly o: Options) {
    this.db = o.ledger.db(); this.now = o.now ?? Date.now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, client_key TEXT UNIQUE, client_body TEXT,
      reminder_sent INTEGER, follow_sent INTEGER);
      CREATE TABLE IF NOT EXISTS task_notices (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, stamp INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS task_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, change TEXT NOT NULL);`);
  }
  words(): WordContract[] { return wordsOf(TASKS_ID); }
  start(): Promise<void> { return this.serial(() => this.sync()); }
  /** Boot/stop never leaves an uncollected background job writing to a closed ledger. */
  async stop(): Promise<void> { await this.tail; }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result;
  }
  async handle(msg: Message, ctx: HandleContext): Promise<WordResult> {
    const b = (msg.body ?? {}) as Body;
    if (msg.word === "list") return { data: this.list(b) };
    if (msg.word === "get") return { data: { task: this.get(b.id), changes: this.db.prepare("SELECT at,by,change FROM task_changes WHERE task_id=? ORDER BY seq").all(b.id) } };
    return this.serial(async () => {
      switch (msg.word) {
        case "add": return { data: await this.add(b, ctx.caller) };
        case "done": return { data: { task: await this.update({ ...b, status: "done" }, ctx.caller) } };
        case "update": return { data: { task: await this.update(b, ctx.caller) } };
        case "task.due":
          if (ctx.caller.via !== "service" || ctx.caller.member !== TASKS_ID) throw new WordError("forbidden", "task.due is sent by the task service's own clock timers");
          await this.due(b); await this.sync(); return { data: { accepted: true } };
        case "task.sync": await this.sync(); return { data: { accepted: true } };
        default: throw new WordError("not_found", `no task word ${msg.word}`);
      }
    });
  }
  private row(id: string): Stored | undefined { return this.db.prepare("SELECT data,reminder_sent,follow_sent FROM tasks WHERE id=?").get(id) as Stored | undefined; }
  private get(id: string): Task {
    const row = this.row(id); if (!row) throw new WordError("not_found", `no task ${id}`); return JSON.parse(row.data);
  }
  private list(b: Body) {
    const limit = b.limit ?? 200;
    const rows = this.db.prepare("SELECT seq,data FROM tasks ORDER BY seq DESC").all() as {seq: number;data: string}[];
    const filtered = rows.map(r => ({ ...r, task: JSON.parse(r.data) as Task })).filter(r =>
      (!b.subject || r.task.subject === b.subject) && (!b.assignee || r.task.assignee === b.assignee) && (!b.thread || r.task.thread === b.thread) &&
      (b.status === "all" || (b.status === "closed" ? !isOpen(r.task) : isOpen(r.task))));
    // A seq cursor keeps equally timed completions from disappearing between pages.
    if ((b.status ?? "open") === "open") filtered.sort((a,b) =>
      (a.task.due_at ?? a.task.remind_at ?? Infinity) - (b.task.due_at ?? b.task.remind_at ?? Infinity) || b.seq-a.seq);
    else filtered.sort((a,b) => b.task.updated_at-a.task.updated_at || b.seq-a.seq);
    const start=b.before ? filtered.findIndex(r=>r.seq===b.before)+1 : 0;
    const page = filtered.slice(start, start+limit);
    return { tasks: page.map(r => r.task), ...(filtered.length > start+limit ? {next_before: page.at(-1)!.seq} : {}) };
  }
  private source(b: Body, caller: Caller): Task["source"] {
    let message = b.source?.message as string | undefined;
    if (!message && caller.turn) {
      const started = this.db.prepare(`SELECT body FROM messages WHERE word='turn.started' AND turn=? ORDER BY seq LIMIT 1`).get(caller.turn) as {body: string}|undefined;
      if (started) {
        const ids = JSON.parse(started.body).ids as string[] | undefined;
        message = ids?.find(id => this.o.ledger.get(id)?.from === OWNER_ID);
      }
    }
    if (!message) return null;
    const original = this.o.ledger.get(message);
    if (!original) throw new WordError("not_found", "the source conversation message no longer exists");
    return { message, ...(caller.turn ? {turn: caller.turn} : {}), ...(isAgentId(caller.member) ? {agent: caller.member} : {}) };
  }
  private async primary(): Promise<string | null> {
    const reply = await this.send("service:agents", "list", {});
    if (!reply.ok) return null;
    return ((reply.result?.data as {agents?: {id: string;primary?: boolean}[]})?.agents ?? []).find(a => a.primary)?.id ?? null;
  }
  private validate(task: Task): void {
    task.title = task.title.trim();
    if (!task.title || task.title.length > 200) throw new WordError("bad_request", "title must contain 1–200 characters");
    if (task.subject !== "owner" && task.subject !== "ash") throw new WordError("bad_request", "subject must be owner or ash");
    if (!(TASK_STATUSES as readonly string[]).includes(task.status)) throw new WordError("bad_request", "unknown task status");
    if (task.assignee !== OWNER_ID && !isAgentId(task.assignee)) throw new WordError("bad_request", "assignee must be person:owner or an agent id");
  }
  private notice(task: Task, kind: Notice["kind"], stamp: number) {
    const id = kind === "report" ? `task.${task.id}.report.${stamp.toString(36)}` : cardId(task.id, kind, stamp);
    this.db.prepare("INSERT OR IGNORE INTO task_notices(id,task_id,kind,stamp) VALUES(?,?,?,?)").run(id,task.id,kind,stamp);
  }
  private change(task: Task, change: string, by: string) {
    this.db.prepare("INSERT INTO task_changes(task_id,at,by,change) VALUES(?,?,?,?)").run(task.id,this.now(),by,change);
  }
  private async event(task: Task, change: string, by: string) {
    try {
      const r = await this.o.router.send({to:null,kind:"event",word:"task.changed",body:{id:task.id,change,by,task}},SELF);
      if (!r.ok) this.o.log?.("task event failed", r.error);
    } catch(error) { this.o.log?.("task event pending refresh",error); }
  }
  private async add(b: Body, caller: Caller) {
    if(b.remind_in !== undefined && b.remind_at !== undefined) throw new WordError("bad_request","give remind_at or remind_in, not both");
    const capturedSource = this.source(b,caller);
    // An agent retrying the same capture in the same agent turn must not make a new task.
    // No time-window/title guessing: deliberately separate items can always use separate client_id values.
    const captureKey = caller.turn;
    const key = b.client_id ? `${caller.member}:${b.client_id}` : captureKey
      ? `${caller.member}:capture:${captureKey}:${createHash("sha256").update(fingerprint(b)).digest("hex")}` : null;
    if (key) {
      const old = this.db.prepare("SELECT data,client_body FROM tasks WHERE client_key=?").get(key) as {data:string;client_body:string}|undefined;
      if (old) {
        if(old.client_body!==fingerprint(b)) throw new WordError("conflict","client_id was already used for different task content; use the original content to reconcile");
        await this.sync(); return {task:this.get(JSON.parse(old.data).id),created:false};
      }
    }
    const subject = b.subject ?? "owner";
    const primary = subject === "ash" && !isAgentId(caller.member) ? await this.primary() : null;
    const now = this.now();
    const task: Task = {id:`t_${randomBytes(9).toString("base64url")}`,title:b.title,note:b.note ?? "",subject,
      assignee:b.assignee ?? (subject === "ash" ? (isAgentId(caller.member) ? caller.member : primary) : OWNER_ID),
      status:b.status ?? "todo", due_at:parseTime(b.due_at,"due_at") ?? null,
      remind_at:b.remind_in ? now+b.remind_in*60_000 : parseTime(b.remind_at,"remind_at") ?? null,
      source:capturedSource,thread:b.thread ?? null,result:null,created_by:caller.member,created_at:now,updated_by:caller.member,updated_at:now,done_at:null};
    this.validate(task);
    this.o.ledger.tx(() => {
      this.db.prepare("INSERT INTO tasks(id,data,client_key,client_body) VALUES(?,?,?,?)").run(task.id,JSON.stringify(task),key,fingerprint(b));
      this.change(task,"added",caller.member); this.notice(task,"noted",now);
    });
    await this.event(task,"added",caller.member); await this.sync(); return {task:this.get(task.id),created:true};
  }
  private async update(b: Body, caller: Caller) {
    if(b.remind_in !== undefined && b.remind_at !== undefined) throw new WordError("bad_request","give remind_at or remind_in, not both");
    const old = this.get(b.id); const now=this.now();
    const task:Task={...old};
    for (const key of ["title","note","subject","assignee","status","result","thread"] as const) if(b[key]!==undefined) (task as any)[key]=b[key];
    for (const key of ["due_at","remind_at"] as const) if(b[key]!==undefined) task[key]=parseTime(b[key],key)!;
    if(b.remind_in!==undefined) task.remind_at=now+b.remind_in*60_000;
    this.validate(task);
    if(caller.via === "agent") {
      if((task.status === "done" || task.status === "dropped") && !task.result?.trim())
        throw new WordError("bad_request","give result: what you completed, or why you could not do it");
      if(task.status === "waiting" && !task.note.trim())
        throw new WordError("bad_request","give note: who or what you are waiting for");
    }
    if(JSON.stringify(old)===JSON.stringify(task)) {await this.sync();return this.get(task.id);}
    task.updated_by=caller.member;task.updated_at=now;
    task.done_at=isOpen(task)?null:(isOpen(old)?now:old.done_at);
    const change=task.status===old.status?"updated":task.status==="done"?"done":task.status==="dropped"?"dropped":!isOpen(old)?"reopened":"updated";
    this.o.ledger.tx(()=>{
      this.db.prepare(`UPDATE tasks SET data=?,reminder_sent=CASE WHEN ? THEN NULL ELSE reminder_sent END,
        follow_sent=CASE WHEN ? THEN NULL ELSE follow_sent END WHERE id=?`).run(JSON.stringify(task),Number(task.remind_at!==old.remind_at || (!isOpen(old)&&isOpen(task))),Number(task.due_at!==old.due_at || (!isOpen(old)&&isOpen(task))),task.id);
      this.change(task,change,caller.member);
      this.db.prepare("UPDATE task_notices SET sent=2 WHERE task_id=? AND sent=1").run(task.id);
      if(!isOpen(task)&&isOpen(old)&&(task.source !== null || isAgentId(old.assignee) || isAgentId(task.assignee))) this.notice(task,"report",now);
    });
    await this.event(task,change,caller.member); await this.sync(); return this.get(task.id);
  }
  private async due(b: Body) {
    const row=this.row(b.id);if(!row)return;
    const task=JSON.parse(row.data) as Task;
    const at=b.kind==="remind"?task.remind_at:followUpAt(task);
    if(!isOpen(task)||at===null||at!==b.at||this.now()<at)return;
    const field=b.kind==="remind"?"reminder_sent":"follow_sent";
    if(row[field]===at)return;
    this.o.ledger.tx(()=>{
      this.notice(task,b.kind==="remind"?"remind":"follow",at);
      this.db.prepare(`UPDATE tasks SET ${field}=? WHERE id=?`).run(at,task.id);
    });
  }
  private async send(to:string,word:string,body:unknown,reply_to?:string):Promise<Reply>{
    try { return await this.o.router.send({to,kind:"request",word,body,...(reply_to?{reply_to}:{})},SELF); }
    catch(error) { return {ok:false,error:{code:"unavailable",message:error instanceof Error?error.message:String(error)}}; }
  }
  private async syncTimers():Promise<boolean>{
    // A single durable maintenance timer also repairs transient delivery failures. It does not poll any screen.
    const listed=await this.send("service:clock","list",{});
    if(!listed.ok) {this.o.log?.("task reminders pending clock recovery",listed.error);return false;}
    const have=(listed.result?.data as {timers?: {id:string;label:string;created_by:string}[]})?.timers ?? [];
    const want=new Map<string,{at?:number;every?:number;word:string;body:unknown}>();
    want.set(`${PREFIX}sync`,{every:60,word:"task.sync",body:{}});
    for(const row of this.db.prepare("SELECT data,reminder_sent,follow_sent FROM tasks").all() as Stored[]){
      const task=JSON.parse(row.data) as Task;if(!isOpen(task))continue;
      for(const kind of ["remind","due"] as const){
        const at=kind==="remind"?task.remind_at:followUpAt(task);
        if(at===null||(kind==="remind"?row.reminder_sent:row.follow_sent)===at)continue;
        want.set(`${PREFIX}${task.id}:${kind}:${at}`,{at:Math.max(at,this.now()+1000),word:"task.due",body:{id:task.id,kind,at}});
      }
    }
    for(const t of have.filter(t=>t.created_by===TASKS_ID&&t.label.startsWith(PREFIX))){
      if(want.has(t.label)) want.delete(t.label); else await this.send("service:clock","cancel",{id:t.id});
    }
    let ready=true;
    for(const [label,t] of want){const r=await this.send("service:clock","set",{...t,to:TASKS_ID,label});if(!r.ok){ready=false;this.o.log?.("task timer pending",r.error);}}
    return ready;
  }
  private async sync():Promise<void>{
    const timersReady=await this.syncTimers();
    // Know whether the reminder was actually arranged before showing a confirmation card.
    await this.refreshDelivery(timersReady);
    const primary=await this.primary();
    for(const n of this.db.prepare("SELECT * FROM task_notices WHERE sent=0 ORDER BY rowid LIMIT 100").all() as Notice[]){
      const task=this.get(n.task_id);
      // A cancelled, completed or rescheduled item must never send an old reminder after reconnection.
      if((n.kind==="remind"&&(!isOpen(task)||task.remind_at!==n.stamp))||(n.kind==="follow"&&(!isOpen(task)||followUpAt(task)!==n.stamp))){this.mark(n);continue;}
      let r:Reply;
      if(n.kind==="report"){
        if(isOpen(task)){this.mark(n);continue;}
        r=await this.send(OWNER_ID,"show",{id:n.id,...cardOf(task,"noted",this.now(),primary)},task.source?.message);
        if(!r.ok&&r.error.code==="conflict")r={ok:true};
      }else if(n.kind!=="noted"&&isAgentId(task.assignee)){
        r=await this.send(task.assignee,"wake",{lane:"back",reason:n.kind==="remind"?"task_reminder":"task_overdue",context:{task,source:task.source,instruction:"Use service:tasks/done with a result when finished; if blocked, update status waiting and note the reason. The hub posts the result card to the source conversation; do not duplicate it."}});
      }else{
        const card=cardOf(task,n.kind,this.now(),primary);
        r=await this.send(OWNER_ID,"show",{id:n.id,...card,kind:n.kind==="noted"?"reply":"due"},task.source?.message);
        // Same stable card id: recovery after a crash between show and mark must not make another card.
        if(!r.ok&&r.error.code==="conflict") r={ok:true};
      }
      if(r.ok){
        const change=n.kind==="remind"?"reminded":n.kind==="follow"?"followed_up":null;
        this.o.ledger.tx(()=>{this.mark(n);if(change)this.change(task,change,TASKS_ID);});
        if(change)await this.event(task,change,TASKS_ID);
      }else this.o.log?.(`task delivery pending ${n.id}`,r.error);
    }
    // Card refreshes are durable too: a crash after updating the task must not leave its old card actionable forever.
    for(const n of this.db.prepare("SELECT * FROM task_notices WHERE sent=2 ORDER BY rowid LIMIT 100").all() as Notice[]){
      const task=this.get(n.task_id);
      const r=await this.send(OWNER_ID,"card.update",{id:n.id,...cardOf(task,n.kind==="report"?"noted":n.kind,this.now(),primary)});
      if(r.ok || r.error.code==="not_found")this.mark(n);
    }
    await this.refreshDelivery(timersReady);
  }
  private async refreshDelivery(timersReady:boolean):Promise<void>{
    for(const row of this.db.prepare("SELECT data,reminder_sent,follow_sent FROM tasks").all() as Stored[]){
      const task=JSON.parse(row.data) as Task;
      const needsClock=isOpen(task) && ((task.remind_at!==null && row.reminder_sent!==task.remind_at) ||
        (task.due_at!==null && row.follow_sent!==followUpAt(task)));
      const pending=this.db.prepare("SELECT 1 FROM task_notices WHERE task_id=? AND sent!=1 LIMIT 1").get(task.id);
      const delivery:NonNullable<Task["delivery"]>={saved:true,reminders:needsClock?(timersReady?"ready":"pending"):"none",conversation:pending?"pending":"ready"};
      if(JSON.stringify(task.delivery)!==JSON.stringify(delivery)){
        const reminderChanged=task.delivery?.reminders!==delivery.reminders;
        task.delivery=delivery;
        this.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(task),task.id);
        if(reminderChanged)this.db.prepare("UPDATE task_notices SET sent=2 WHERE task_id=? AND sent=1").run(task.id);
        await this.event(task,"updated",TASKS_ID);
      }
    }
  }
  private mark(n:Notice){this.db.prepare("UPDATE task_notices SET sent=1 WHERE id=?").run(n.id);}
}
