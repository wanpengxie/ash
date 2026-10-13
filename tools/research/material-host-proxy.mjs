import {randomUUID} from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import {WebSocket,WebSocketServer} from 'ws';
export function classifyFrame(v){if(!v||Array.isArray(v)||typeof v!=='object'||('method'in v&&('result'in v||'error'in v))||('result'in v&&'error'in v))throw Error('invalid frame');if('id'in v&&!['string','number'].includes(typeof v.id))throw Error('id type');if(typeof v.id==='number'&&!Number.isFinite(v.id))throw Error('id number');if('method'in v){if(typeof v.method!=='string')throw Error('method');return'id'in v?'request':'notification'}if('id'in v&&('result'in v||'error'in v))return'response';throw Error('unknown frame')}
export function depth(v,n=0){if(n>24)throw Error('depth');if(v&&typeof v==='object')for(const x of Object.values(v))depth(x,n+1)}
export function normalizeServer(id){if(typeof id!=='string'||id.length>256)throw Error('server identity');return id.normalize('NFKC').toLowerCase().replace(/^plugin[:/]+/,'')}
const deviceMethods=new Set(['initialize','thread/read','thread/resume','turn/start','turn/interrupt']);
const methodPolicy=new Map([
  ['initialize','initialize'],['thread/start','control'],['thread/resume','control'],
  ['turn/start','control'],['turn/interrupt','control'],
  ...['thread/read','thread/list','thread/loaded/list','thread/turns/list','thread/items/list','thread/timeline/list','model/list','mcpServerStatus/list'].map(m=>[m,'read']),
  ['config/mcpServer/reload','registry-refresh'],
  ...['mcpServer/tool/call','mcpServer/resource/read','mcpServer/event/stream/start','mcpServer/event/stream/stop'].map(m=>[m,'mcp-direct']),
]);
export function clientMethodPolicy(method){return methodPolicy.get(method)??'deny';}
const paramsPolicy={
  initialize:['clientInfo','capabilities'], 'thread/start':['dynamicTools'],
  'thread/resume':['threadId'],'thread/read':['threadId','includeTurns'],
  'turn/start':['threadId','input','clientUserMessageId'], 'turn/interrupt':['threadId','turnId'],
};
export function authorize(method,params,binding,registry,known){
  if(!known.has(method))throw Error('unknown client method');
  const policy=clientMethodPolicy(method);if(policy==='deny')throw Error('unreviewed client method denied');
  if(binding.role==='device'&&!deviceMethods.has(method))throw Error('device method denied');
  if(policy==='control'&&!registry.current())throw Error('Ash admission unavailable');
  const allowed=paramsPolicy[method];if(allowed&&Object.keys(params??{}).some(k=>!allowed.includes(k)))throw Error('runtime/config override denied');
  if(params?.dynamicTools!==undefined&&!(binding.role==='gui'&&method==='thread/start'&&registry.allowDynamic?.(params.dynamicTools)))throw Error('unregistered dynamic tools');
  if(binding.role==='device'&&method!=='initialize'&&typeof params?.threadId!=='string')throw Error('device params denied');
  if(policy==='mcp-direct'){
    if(registry.resolve(params?.server)!=='nonprotected'||binding.role!=='gui')throw Error('protected or unresolved MCP direct denied');
    if(typeof params?.threadId!=='string')throw Error('MCP work required');
  }
  if(binding.role==='device'&&params?.threadId&&!binding.works.has(params.threadId))throw Error('work scope denied');
  return true;
}
export async function createMaterialHostProxy({nativeUrl,nativeCredentialProvider,roles,protectedMcpRegistry:registry,knownMethods,knownServerMethods,limits={},onGenerationChange=()=>{},record=()=>{}}){
  if(typeof registry.epoch!=='function'||typeof roles.epoch!=='function')throw Error('monotonic registry/role epoch ports required');
  if(!(knownMethods instanceof Set)||!(knownServerMethods instanceof Set))throw Error('fixed client/server schema method sets required');
  const maxPayload=limits.maxPayload??1048576,maxInflight=limits.maxInflight??32,maxQueue=limits.maxQueue??2097152,maxRetired=limits.maxRetired??128;let generation=1,serial=0,closed=false,poisoned=false;const instance=randomUUID(),connections=new Set(),listeners=[],serverRequests=new Map(),retiredRequests=new Set();
  const retire=key=>{if(retiredRequests.has(key))return true;if(retiredRequests.size>=maxRetired)return false;retiredRequests.add(key);return true};
  const status=()=>({generation:instance+':'+generation,epoch:generation,ready:!closed&&!poisoned&&registry.current(),poisoned,connections:connections.size,pendingServerRequests:serverRequests.size,retiredServerRequests:retiredRequests.size,queuedFrames:[...connections].reduce((n,c)=>n+c.queued.length,0),registryEpoch:registry.epoch()});
  function fence(c){if(closed||poisoned||c.generation!==generation||c.down.readyState!==WebSocket.OPEN)throw Error('generation/connection closed');roles.current(c.binding)}
  function send(c,ws,m,operationCurrent){fence(c);operationCurrent?.();const data=JSON.stringify(m);if(ws.readyState!==WebSocket.OPEN||ws.bufferedAmount+Buffer.byteLength(data)>maxQueue)throw Error('backpressure');fence(c);operationCurrent?.();ws.send(data)}
  function shutdown(c){
    if(c.dead)return;let capacity=false;
    for(const [k,q]of serverRequests)if(q.owner===c){if(!retire(k))capacity=true;serverRequests.delete(k)}
    c.dead=true;connections.delete(c);c.queued.length=0;c.requests.clear();
    try{c.down.terminate()}finally{c.up?.terminate()}
    if(capacity)invalidate('server response tombstone capacity');
  }
  const invalidate=reason=>{
    let capacity=reason==='server response tombstone capacity';
    for(const key of serverRequests.keys())if(!retire(key))capacity=true;
    if(capacity)poisoned=true;
    generation++;serverRequests.clear();
    try{record({kind:'generation',generation,reason,poisoned});onGenerationChange(instance+':'+generation)}finally{for(const c of [...connections])shutdown(c)}
  };
  async function listen(socketPath,role){await fs.rm(socketPath,{force:true});const server=http.createServer((q,s)=>{s.writeHead(404);s.end()});const wss=new WebSocketServer({noServer:true,maxPayload,perMessageDeflate:false});server.on('upgrade',(req,socket,head)=>{try{if(closed||poisoned)throw Error('proxy unavailable');if(req.url!=='/rpc')throw Error('path');const binding=roles.authenticate({role,socketPath});roles.current(binding);wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req,binding))}catch{socket.destroy()}});
    wss.on('connection',(down,req,binding)=>{const c={id:++serial,generation,binding,down,up:null,requests:new Map(),queued:[],dead:false};connections.add(c);record({kind:'downstream_connected',connection:c.id,role:binding.role,generation});down.on('error',e=>{record({kind:'downstream_transport_error',code:e.code,reason:e.message});shutdown(c)});down.on('close',()=>shutdown(c));let initialized=false;const queued=c.queued;
      function capture(v){return{registryEpoch:registry.epoch(),roleEpoch:roles.epoch(binding),generation,method:v.method,params:v.params};}
      function serverResponseFence(q){fence(c);if(q.owner!==c||binding.role!=='gui'||q.generation!==generation||q.registryEpoch!==registry.epoch()||q.roleEpoch!==roles.epoch(binding)||!registry.current())throw Error('stale server response lease');}
      function operationFence(lease){fence(c);if(lease.generation!==generation||lease.registryEpoch!==registry.epoch()||lease.roleEpoch!==roles.epoch(binding))throw Error('stale operation lease');authorize(lease.method,lease.params,binding,registry,knownMethods)}
      down.on('message',data=>{try{const v=JSON.parse(String(data));depth(v);const kind=classifyFrame(v);fence(c);if(kind==='notification'){if(v.method!=='initialized'||!initialized)throw Error('notification denied');send(c,c.up,v);return}
        if(kind==='response'){const q=[...serverRequests.values()].find(x=>x.downId===v.id&&x.owner===c&&x.generation===generation);if(!q||binding.role!=='gui')throw Error('unowned server response');serverResponseFence(q);if(!retire(q.key)){invalidate('server response tombstone capacity');return}send(c,c.up,{...v,id:q.nativeId},()=>serverResponseFence(q));serverRequests.delete(q.key);record({kind:'server_response_forwarded',owner:c.id,method:q.method});return}
        authorize(v.method,v.params,binding,registry,knownMethods);if(c.requests.size>=maxInflight)throw Error('inflight');if(c.requests.has(v.id)||queued.some(q=>q.value.id===v.id))throw Error('duplicate client id');if(!c.up||c.up.readyState!==WebSocket.OPEN){if(queued.length>=2)throw Error('startup queue');queued.push({value:v,lease:capture(v)});return}forward(v,capture(v));
      }catch(e){record({kind:'proxy_rejection',connection:c.id,role:binding.role,reason:e.message});let id;try{id=JSON.parse(String(data)).id}catch{}if(id!==undefined&&down.readyState===WebSocket.OPEN){try{fence(c)}catch{shutdown(c);return}down.send(JSON.stringify({id,error:{code:-32001,message:e.message}}))}}});
      function forward(v,lease){operationFence(lease);if(v.method==='config/mcpServer/reload'){if(serverRequests.size)throw Error('pending server requests prevent configuration reload');registry.beginRefresh();generation++;serverRequests.clear();for(const peer of connections)peer.generation=generation;record({kind:'generation',generation,reason:'registry reload'});onGenerationChange(instance+':'+generation);lease=capture(v)}const id='cr:'+instance+':'+generation+':'+c.id+':'+(++serial);c.requests.set(v.id,{nativeId:id,method:v.method,generation,lease});try{operationFence(lease);send(c,c.up,{...v,id},()=>operationFence(lease))}catch(e){c.requests.delete(v.id);throw e}if(v.method==='initialize')initialized=true}
      void(async()=>{try{const credential=await nativeCredentialProvider();fence(c);const up=new WebSocket(nativeUrl,{headers:{Authorization:'Bearer '+credential},maxPayload,perMessageDeflate:false});c.up=up;up.on('error',()=>shutdown(c));up.on('close',()=>shutdown(c));up.on('open',()=>{try{for(const q of queued.splice(0))forward(q.value,q.lease)}catch(e){record({kind:'queued_dispatch_rejection',reason:e.message});shutdown(c)}});up.on('message',data=>{try{fence(c);const v=JSON.parse(String(data));depth(v);const kind=classifyFrame(v);
        if(kind==='response'){const entry=[...c.requests].find(([,q])=>q.nativeId===v.id);if(!entry)throw Error('unmatched native response');const[id,q]=entry;c.requests.delete(id);if(q.generation!==generation)throw Error('stale request generation');operationFence(q.lease);if(q.method==='config/mcpServer/reload'&&!v.error)registry.finishRefresh();if(binding.role==='device'&&v.result?.thread?.id&&!binding.works.has(v.result.thread.id))throw Error('response work scope');send(c,down,{...v,id},()=>operationFence(q.lease));return}
        if(kind==='request'){if(!knownServerMethods.has(v.method))throw Error('unknown native server request');if(binding.role!=='gui')return;const key=JSON.stringify([v.id,v.method,v.params?.threadId??null,v.params?.turnId??null]);if(serverRequests.has(key)||retiredRequests.has(key))return;if(serverRequests.size>=maxInflight)throw Error('server inflight');const downId='sr:'+instance+':'+generation+':'+(++serial);serverRequests.set(key,{key,generation,registryEpoch:registry.epoch(),roleEpoch:roles.epoch(binding),owner:c,nativeId:v.id,downId,method:v.method});send(c,down,{...v,id:downId});record({kind:'server_request_owner',method:v.method,owner:c.id,nativeId:v.id,downId});return}
        if(binding.role==='device'){const tid=v.params?.threadId??v.params?.thread?.id;if(!tid||!binding.works.has(tid))return;if(['item/started','item/completed'].includes(v.method)&&v.params?.item?.type==='mcpToolCall')return}
        if(v.method==='item/started'&&v.params?.item?.type==='mcpToolCall')record({kind:'native_mcp_item',admissionEligible:registry.current(),registryEpoch:registry.epoch(),generation:instance+':'+generation,threadId:v.params.threadId,turnId:v.params.turnId,item:v.params.item});send(c,down,v);
      }catch(e){record({kind:'proxy_native_rejection',reason:e.message});shutdown(c)}})
      }catch(e){record({kind:'proxy_startup_rejection',reason:e.message});shutdown(c)}})();
    });await new Promise((r,j)=>{server.once('error',j);server.listen(socketPath,r)});await fs.chmod(socketPath,0o600);listeners.push({server,wss,socketPath});return socketPath;
  }
  async function close(){if(closed)return;invalidate('close');closed=true;for(const l of listeners){l.wss.clients.forEach(c=>c.terminate());await new Promise(r=>l.server.close(r));await fs.rm(l.socketPath,{force:true})}listeners.length=0}
  return{listen,close,status,invalidate};
}
