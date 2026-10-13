import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCreateSocket } from "./codex-create-socket";
import { CodexCreateTransport } from "../../src/collaboration/codex-create-transport";
import { CodexCreateAdapter } from "../../src/collaboration/codex-create";
import { CreateOperationStore } from "../../src/collaboration/create-operation-store";
import { CreateAuthorization } from "../../src/collaboration/create-authorization";
import { controlAuthorizationSnapshot } from "../../src/collaboration/control-authorization";
import { DeviceCreateService } from "../../src/collaboration/create-service";
export async function serviceFixture(t: { after(fn: () => Promise<void>): void }, deadlineMs = 1000) {
  const dir = await mkdtemp(join(tmpdir(), "ash-create-service-"));
  const socket = new FakeCreateSocket(); let now = Date.now(), paired: string | null = "owner", current = true, constructions = 0, closes = 0;
  socket.close = () => { closes++; };
  let grant = controlAuthorizationSnapshot({version:1,owner_id:"owner",endpoint_id:"endpoint",authorization_generation:1,allowed_actions:["create_work"],scope:{kind:"exact_cwd",cwd:"/project"}},"endpoint");
  const transport = new CodexCreateTransport({socket:"/fake",executable:"/fake/codex",pid:123,supportedVersions:["1.2.3"],timeoutMs:1000,verifyListener:()=>({socket:"/fake",executable:"/fake/codex",pid:123,version:"1.2.3",identity:"one"}),connectSocket:async()=>socket});
  const native = new CodexCreateAdapter({node_id:"node",endpoint_id:"endpoint",transport});
  const store = new CreateOperationStore(join(dir,"create.db"));
  const authorization = new CreateAuthorization({nodeId:"node",endpointId:"endpoint",pinnedOwnerId:()=>paired,authorization:()=>grant,now:()=>now});
  const service = new DeviceCreateService({node_id:"node",endpoint_id:"endpoint",store,authorization,native:()=>{constructions++;return native;},now:()=>now,deadlineMs});
  const context = {transportOwnerId:"owner",isCurrent:()=>current};
  const discovery = () => ({version:1,node_id:"node",endpoint_id:"endpoint",cwd:"/project",authorization_revision:grant.authorization_revision!});
  const request = () => ({version:1 as const,request_id:"request",operation_id:"operation",authorization_revision:grant.authorization_revision!,target:{node_id:"node",endpoint_id:"endpoint",project_id:"project",cwd:"/project"},title:"Title",input:{text:"first"},expires_at:now+10000});
  const apply = () => ({version:1,request:request(),expected_connector_epoch:native.connector_epoch});
  const lookup = () => ({version:1,target:request().target,authorization_revision:request().authorization_revision,operation_id:"operation"});
  t.after(async()=>{try{await service.close();}finally{store.close();await rm(dir,{recursive:true,force:true});}});
  return {socket,transport,native,store,service,authorization,context,discovery,request,apply,lookup,stats:()=>({constructions,closes}),setGrant:(g:typeof grant)=>{grant=g;},getGrant:()=>grant,revoke:()=>{grant={state:"grant_required",config:null,authorization_revision:null};},setPaired:(v:string|null)=>{paired=v;},setCurrent:(v:boolean)=>{current=v;},setNow:(v:number)=>{now=v;}};
}
