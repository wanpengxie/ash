// Emulator .probe only: upstream computer transport is fake. Production Core
// ResultFileService and Android bridge/transport/picker/write path are unchanged.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {ResultFileService} from '../../packages/core/src/collaboration/result-file-service';
const cfg=JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config')+1],'utf8'));
if(cfg.listen!=='127.0.0.1:14763'||!cfg.stateDir.includes('ai.ash.agent.probe/'))throw Error('isolated probe required');
const token='local_result_probe_owner_20261012';
const screen='local-result-screen';
const native=createHash('sha256').update(`${cfg.host.token}:home`).digest('hex');
const bytes=Buffer.from('# Android native result save\n\nLocal isolated fixed snapshot.\n中文字节核对。\n');
const sha=createHash('sha256').update(bytes).digest('hex');
const asset={kind:'asset',asset_id:'local-fixture',version:1,sha256:sha,byte_length:bytes.length,media_type:'text/markdown',display_name:'ash-native-result-20261012.md'};
const input={version:1,device_id:'device:pc',endpoint_id:'pc',authorization_generation:1,authorization_revision:'a'.repeat(64),action:'read_work',work:{node_id:'pc',endpoint_id:'pc',kind:'conversation',native_id:'fixture'},turn_id:'turn',source_message_id:'assistant',exact_href:'./ash-native-result-20261012.md'} as any;
const controller=new AbortController();
const svc=new ResultFileService({async resultCall(_input,cap,args:any){
 if(cap==='collaboration.result.prepare')return {version:1,state:'ready',export_id:'local-fixed-export',asset,expires_at:Date.now()+900000};
 return {version:1,export_id:'local-fixed-export',asset_id:asset.asset_id,asset_version:1,sha256:sha,byte_length:bytes.length,chunk_index:args.chunk_index,data_base64:bytes.subarray(args.chunk_index*40960,(args.chunk_index+1)*40960).toString('base64')};
}});
mkdirSync(cfg.stateDir,{recursive:true});
const ready=await svc.prepare(screen,input,controller.signal,()=>{});
writeFileSync(`${cfg.stateDir}/fixture-ready.json`,JSON.stringify(ready));
writeFileSync(`${cfg.stateDir}/fixture-expected.md`,bytes);
writeFileSync(`${cfg.stateDir}/ui-url`,`http://127.0.0.1:14763/?token=${token}`);
createServer(async(req,res)=>{
 const reply=(status:number,value:any)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 if(req.headers.authorization!==`Bearer ${token}`||req.headers['x-ash-native-ui']!==native)return reply(403,{ok:false});
 let raw='';for await(const part of req)raw+=part;
 const route=req.url?.split('?')[0];
 if(route==='/api/collaboration/result-files/native/snapshot'||route==='/api/collaboration/result-files/native/check'){
  try {
   if(req.method!=='POST'||req.headers['ash-screen']!==screen)throw Error('authority');
   const b=JSON.parse(raw);if(Object.keys(b).sort().join(',')!=='asset_version,save_id,sha256')throw Error('shape');
   const operation=route.endsWith('/snapshot')?'snapshot':'check';
   const result=await svc[operation](screen,b.save_id,b.asset_version,b.sha256,controller.signal,()=>{});
   appendFileSync(`${cfg.stateDir}/fixture-routes.jsonl`,JSON.stringify({operation,ok:true,native_auth:true,screen_bound:true,byte_length:bytes.length,sha256:sha})+'\n');
   reply(200,{ok:true,result});
  }catch{reply(403,{ok:false});}
 }else reply(200,{ok:true,result:{},space:'local-probe',items:[]});
}).listen(14763,'127.0.0.1');
