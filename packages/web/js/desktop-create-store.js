const KEY = 'ash.desktop.create-outbox.v1';
const codes=[null,'invalid','too_large','permission_denied','expired','conflict','busy','storage_failure','unsupported','offline','stale_precondition','result_unknown'];
const ops = ['projects', 'apply', 'query', 'reconcile'];
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.:@/-]{0,255}$/.test(v);
const object = (v, keys) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const cwdValid = v => typeof v === 'string' && v.startsWith('/') && v.length<=4096 && !/[\u0000-\u001f]/.test(v) && !v.split('/').some(x=>x==='.' || x==='..') && (v==='/' || !v.endsWith('/')) && !v.includes('//');
const size = v => new TextEncoder().encode(JSON.stringify(v)).length;
const disk = () => { try { return globalThis.localStorage; } catch { return null; } };
export const createKey = t => JSON.stringify([t?.device_id,t?.endpoint_id,t?.authorization_revision,t?.scope?.cwd]);
export const sameCreateTarget = (a,b) => !!a && !!b && ['node_id','endpoint_id','project_id','cwd'].every(k => a[k] === b[k]);
export function createReady(t) {
  return t?.version === 1 && id(t.endpoint_id) && t.device_id === `device:${t.endpoint_id}` && t.grant_state === 'ready' && /^[a-f0-9]{64}$/.test(t.authorization_revision) && t.scope?.kind === 'exact_cwd' && cwdValid(t.scope.cwd) && ops.every(op => t.actions?.includes(op) && t.capabilities?.includes(op));
}
export function createProjectsValid(r,t) {
  return r?.complete === true && r.authorization_revision === t.authorization_revision && r.target?.node_id === t.endpoint_id && r.target.endpoint_id === t.endpoint_id && r.target.cwd === t.scope.cwd && id(r.connector_epoch) && id(r.native_interface_version) && Array.isArray(r.projects) && r.projects.length <= 1000 && r.projects.every(p => object(p,['project_id','cwd']) && id(p.project_id) && p.cwd === t.scope.cwd) && new Set(r.projects.map(p=>p.project_id)).size === r.projects.length;
}
export function createFactValid(f,r) {
  if (!object(f,['version','request_id','operation_id','authorization_revision','target','expires_at','status','create','name','first_input','work','native_client_message_id','reconciliation','error_code','observed_at']) || f.version !== 1 || f.status !== 'recorded' || f.request_id !== r.request_id || f.operation_id !== r.operation_id || f.authorization_revision !== r.authorization_revision || f.expires_at !== r.expires_at || !object(f.target,['node_id','endpoint_id','project_id','cwd']) || !sameCreateTarget(f.target,r.target) || (!Number.isSafeInteger(f.observed_at) || f.observed_at<0 || !codes.includes(f.error_code))) return false;
  const work = w => object(w,['node_id','endpoint_id','kind','native_id']) && w.node_id === r.target.node_id && w.endpoint_id === r.target.endpoint_id && w.kind === 'conversation' && id(w.native_id);
  if (f.work !== null && !work(f.work)) return false;
  for (const key of ['create','name','first_input']) {
    const s=f[key];
    if (!object(s,['status','attempt_id','connector_epoch','native_interface_version','started_at','observed_at','receipt','error_code']) || !['not_started','invoking','accepted','rejected','unknown'].includes(s.status) || !Number.isSafeInteger(s.observed_at) || s.observed_at > f.observed_at || s.observed_at<0 || !codes.includes(s.error_code)) return false;
    const idle=s.status==='not_started';
    if (['attempt_id','connector_epoch','native_interface_version'].some(k=>idle?s[k]!==null:!id(s[k])) || (idle?s.started_at!==null:(!Number.isSafeInteger(s.started_at) || s.started_at<0 || s.started_at>s.observed_at)) || (s.status==='accepted') !== (s.receipt!==null)) return false;
    if ((['not_started','invoking','accepted'].includes(s.status) && s.error_code!==null) || (s.status==='unknown' && s.error_code!=='result_unknown') || (s.status==='rejected' && (!s.error_code || s.error_code==='result_unknown'))) return false;
    if (s.receipt) {
      const p=s.receipt;
      if (!object(p,['stage','accepted_by','work',...(key==='first_input'?['native_turn_id','native_message_id','correlation']:[])]) || p.stage!==key || p.accepted_by!=='native' || !work(p.work) || p.work.native_id!==f.work?.native_id) return false;
      if (key==='first_input' && (!id(p.native_turn_id) || !['stable_message_id','uncertain'].includes(p.correlation) || (p.native_message_id!==null && !id(p.native_message_id)) || (p.correlation==='stable_message_id' && !id(p.native_message_id)))) return false;
    }
  }
  return (f.create.status==='accepted') === (f.work!==null) && (f.create.status==='accepted' || f.name.status==='not_started') && (f.name.status==='accepted' || f.first_input.status==='not_started') && (f.first_input.status==='not_started'?f.native_client_message_id===null:id(f.native_client_message_id)) && (f.reconciliation === null || (()=>{
    const p=f.reconciliation,receipt=f.first_input.receipt;
    return object(p,['source','lookup_scope','work','pages_observed','history_exhausted','connector_epoch','native_interface_version','observed_at','native_client_message_id','native_turn_id','native_message_id']) && p.source==='codex.saved_history' && p.lookup_scope==='bounded_history_pages' && work(p.work) && p.work.native_id===f.work?.native_id && Number.isSafeInteger(p.pages_observed) && p.pages_observed>=1 && p.pages_observed<=4 && typeof p.history_exhausted==='boolean' && id(p.connector_epoch) && p.native_interface_version===f.first_input.native_interface_version && typeof p.observed_at==='string' && Number.isFinite(Date.parse(p.observed_at)) && receipt?.correlation==='stable_message_id' && p.native_client_message_id===f.native_client_message_id && p.native_turn_id===receipt.native_turn_id && p.native_message_id===receipt.native_message_id;
  })());
}
// Receipt recovery can advance recorded evidence, never replace known native identity.
function advancesFact(previous, next) {
  if (previous.work && (!next.work || ['node_id','endpoint_id','kind','native_id'].some(k => previous.work[k] !== next.work[k]))) return false;
  if (previous.native_client_message_id !== null && next.native_client_message_id !== previous.native_client_message_id) return false;
  if (previous.reconciliation !== null && next.reconciliation === null) return false;
  const transitions = {
    not_started: ['not_started','invoking','accepted','rejected','unknown'],
    invoking: ['invoking','accepted','rejected','unknown'],
    unknown: ['unknown','accepted'],
    rejected: ['rejected'],
    accepted: ['accepted'],
  };
  for (const key of ['create','name','first_input']) {
    const a = previous[key], b = next[key];
    if (b.observed_at < a.observed_at || !transitions[a.status].includes(b.status)) return false;
    if (a.status !== 'not_started' && ['attempt_id','connector_epoch','native_interface_version','started_at'].some(k => a[k] !== b[k])) return false;
    if (a.status === 'rejected' && a.error_code !== b.error_code) return false;
    if (!a.receipt) continue;
    const old = a.receipt, receipt = b.receipt;
    if (!receipt || old.stage !== receipt.stage || old.accepted_by !== receipt.accepted_by) return false;
    if (key !== 'first_input') continue;
    if (old.native_turn_id !== receipt.native_turn_id || (old.native_message_id !== null && old.native_message_id !== receipt.native_message_id)) return false;
    if (old.correlation === 'stable_message_id' && receipt.correlation !== 'stable_message_id') return false;
    // A new message identity needs the reviewed stable mapping, not an uncertain guess.
    if (old.native_message_id === null && receipt.native_message_id !== null && receipt.correlation !== 'stable_message_id') return false;
  }
  return true;
}
// Submitted text stays with its scoped operation for at most 24 hours; recovery never replays it.
export class DesktopCreateStore {
  constructor({storage=disk(),endpoint=globalThis.location?.origin || 'local',limit=32,now=Date.now}={}) {this.now=now; this.storage=storage;this.endpoint=endpoint;this.limit=limit;this.scope=null;this.items=[];this.defaults={};this.persistent=!!storage; }
  bind(scope) {
    if (scope===this.scope) return;
    this.scope=scope;this.items=[];this.defaults={};
    try { const raw=this.storage?.getItem(KEY)||'null'; if(new TextEncoder().encode(raw).length>256*1024) throw Error('oversized store');const s=JSON.parse(raw); if(scope && s?.scope===scope && s.endpoint===this.endpoint && Array.isArray(s.items) && s.items.length<=this.limit) {this.items=s.items.filter(i=>this.valid(i)).map(i=>{if(i.submitted && (i.submitted.expires_at<=this.now() || ['create','name','first_input'].every(k=>i.fact?.[k].status==='accepted')))delete i.submitted;return i;});this.defaults=Object.fromEntries(Object.entries(s.defaults||{}).filter(([key,p])=>this.defaultValid(key,p)).slice(0,this.limit));} } catch {}
    this.save();
  }
  defaultValid(key,p) { try {const t=JSON.parse(key);return Array.isArray(t) && t.length===4 && id(t[1]) && t[0]===`device:${t[1]}` && /^[a-f0-9]{64}$/.test(t[2]) && cwdValid(t[3]) && object(p,['project_id','cwd']) && id(p.project_id) && p.cwd===t[3];}catch{return false;} }
  data(items=this.items,defaults=this.defaults) {return {endpoint:this.endpoint,scope:this.scope,items,defaults};}
  valid(i) { return object(i,['key','request','fact','submitted']) && (i.submitted===undefined || (object(i.submitted,['title','text','expires_at']) && typeof i.submitted.title==='string' && new TextEncoder().encode(i.submitted.title).length<=256 && typeof i.submitted.text==='string' && i.submitted.text.trim() && new TextEncoder().encode(i.submitted.text).length<=65536 && Number.isSafeInteger(i.submitted.expires_at) && i.submitted.expires_at<=this.now()+86400000)) && typeof i.key==='string' && this.defaultValid(i.key,{project_id:i.request?.target?.project_id,cwd:i.request?.target?.cwd}) && object(i.request,['version','request_id','operation_id','authorization_revision','target','expires_at']) && i.request.version===1 && id(i.request.request_id) && id(i.request.operation_id) && /^[a-f0-9]{64}$/.test(i.request.authorization_revision) && object(i.request.target,['node_id','endpoint_id','project_id','cwd']) && ['node_id','endpoint_id','project_id'].every(k=>id(i.request.target[k])) && cwdValid(i.request.target.cwd) && i.request.target.node_id===i.request.target.endpoint_id && JSON.parse(i.key)[1]===i.request.target.endpoint_id && JSON.parse(i.key)[2]===i.request.authorization_revision && Number.isSafeInteger(i.request.expires_at) && (i.fact===null || createFactValid(i.fact,i.request)); }
  save() {for(const i of this.items)if(i.submitted?.expires_at<=this.now())delete i.submitted;try { if(this.scope) this.storage?.setItem(KEY,JSON.stringify(this.data()));else this.storage?.removeItem(KEY); }catch {this.persistent=false;} }
  clear() {this.items=[];this.defaults={};this.save();}
  reconcile(targets) {const allowed=new Set(targets.filter(createReady).map(createKey));this.items=this.items.filter(i=>allowed.has(i.key));this.defaults=Object.fromEntries(Object.entries(this.defaults).filter(([key])=>allowed.has(key)));this.save();}
  list(t) {return this.items.filter(i=>i.key===createKey(t));}
  select(t,p) {const key=createKey(t),value={project_id:p.project_id,cwd:p.cwd},next={...this.defaults,[key]:value};if(!this.defaultValid(key,value) || Object.keys(next).length>this.limit || size(this.data(this.items,next))>256*1024) return false;this.defaults=next;this.save();return true;}
  selected(t,projects) {const p=this.defaults[createKey(t)];return projects.find(x=>x.project_id===p?.project_id && x.cwd===p.cwd)||null;}
  add(t,r) {const {version,request_id,operation_id,authorization_revision,target,expires_at}=r;const i={key:createKey(t),request:{version,request_id,operation_id,authorization_revision,target:{...target},expires_at},fact:null,submitted:{title:r.title,text:r.input?.text,expires_at:this.now()+86400000}}; if(!this.valid(i)||this.items.length>=this.limit || size(this.data([...this.items,i]))>256*1024) throw Error('capacity');this.items.push(i);this.save();return i;}
  accept(i,f) {if(f!==null && !createFactValid(f,i.request)) throw Error('invalid fact');if(!this.items.includes(i)) throw Error('stale operation');if(f && i.fact && f.observed_at<i.fact.observed_at) return;if(f && i.fact && !advancesFact(i.fact,f)) throw Error('regressive fact'); if(f) {const next=structuredClone(f);if(size(this.data(this.items.map(x=>x===i?{...x,fact:next}:x)))>256*1024) throw Error('capacity');i.fact=next;if(['create','name','first_input'].every(k=>next[k].status==='accepted'))delete i.submitted;}this.save();}
}
