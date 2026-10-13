import {lstatSync,realpathSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {connectCodex} from './connect';
import {ensureControlConnection} from './control-connect-install';
import {callConnectionSetup,callMaterialSetup} from './material-ipc';

/** A single consent, followed by existing protected saves. There is deliberately
 * no rollback: a later failed save must not overwrite a concurrent decision. */
export async function connectProjectCollaboration(options:{stateDir:string;endpointId:string;project:string;computerName?:string;expiresInMinutes?:number;confirm(summary:string):Promise<boolean>;testing?:{ensure?:typeof ensureControlConnection;read?:typeof connectCodex;setup?:typeof callConnectionSetup;material?:typeof callMaterialSetup;now?:()=>number}}):Promise<{state:'cancelled'|'connected';expiresAt?:number;conversations?:number;messages?:number}> {
 const minutes=options.expiresInMinutes??1440;if(!Number.isSafeInteger(minutes)||minutes<1||minutes>10080)throw Error('Material duration must be 1..10080 minutes.');
 const project=realpathSync(options.project),stat=lstatSync(project,{bigint:true});if(!stat.isDirectory())throw Error('Choose an existing project directory.');
 const setup=options.testing?.setup??callConnectionSetup,material=options.testing?.material??callMaterialSetup;
 const expiresAt=(options.testing?.now??Date.now)()+minutes*60000;
 let owner='',readSaved=false,controlSaved=false,controlReused=false,materialSaved=false,attempted='',stage='shared connection';
 const currentProject=()=>{const fresh=lstatSync(project,{bigint:true});if(realpathSync(options.project)!==project||!fresh.isDirectory()||fresh.dev!==stat.dev||fresh.ino!==stat.ino)throw Error('Project directory changed; confirm again.');};
 const paired=(status:any)=>{currentProject();if(!status.precondition?.ownerId||owner&&status.precondition.ownerId!==owner)throw Error('Pairing changed; confirm again.');owner||=status.precondition.ownerId;return status;};
 const controlMatches=(status:any)=>status.control?.owner_id===owner&&status.control.scope?.kind==='exact_cwd'&&status.control.scope.cwd===project&&(status.control.expires_at===undefined||status.control.expires_at>(options.testing?.now??Date.now)())&&isDeepStrictEqual([...status.control.allowed_actions].sort(),['create_work','send_input','steer']);
 const checkedMaterial=async(operation:'material.status'|'material.prepare'|'material.apply',body:unknown)=>{const result=await material(options.stateDir,options.endpointId,operation,body);if(result?.error)throw Error(result.error);return result;};
 try{
  await (options.testing?.ensure??ensureControlConnection)({stateDir:options.stateDir,endpointId:options.endpointId,project});
  paired(await setup(options.stateDir,options.endpointId,'setup.status',{}));
  stage='project read';let readReceipt:any;
  const readSetup=(async(s:string,e:string,op:any,body:any)=>{const result=await (setup as any)(s,e,op,body);if(['setup.status','setup.apply'].includes(op))readReceipt=result.precondition;return result;}) as typeof callConnectionSetup;
  const read=await (options.testing?.read??connectCodex)({stateDir:options.stateDir,endpointId:options.endpointId,computerName:options.computerName,project,testing:{setupCall:readSetup},confirm:async()=>options.confirm(`Allow collaboration in this project?\nProject: ${project}\nPaired owner: ${owner}\nAsh may read saved conversations, create conversations, send messages and append to active turns in this project. It may receive text and images you actively send until ${new Date(expiresAt).toISOString()} (${minutes} minutes).\nThis replaces the previous read, control and material ranges. Other projects are excluded. No model task is started by this approval.`)});
  if(read.state==='cancelled')return {state:'cancelled'};readSaved=true;
  stage='project control preview';const before=paired(await setup(options.stateDir,options.endpointId,'setup.status',{}));
  if(!readReceipt||!isDeepStrictEqual(readReceipt,before.precondition))throw Error('Permissions changed after read verification; confirm again.');
  if(before.read?.allowedCwds.length!==1||before.read.allowedCwds[0]!==project)throw Error('Project read range changed; confirm again.');
  let saved=before;
  if(!controlMatches(before)){
  const preview=await setup(options.stateDir,options.endpointId,'setup.prepare',{selection:{kind:'control',allowedActions:['send_input','steer','create_work'],scope:{kind:'exact_cwd',cwd:project}}});
  const fresh=paired(await setup(options.stateDir,options.endpointId,'setup.status',{}));if(!isDeepStrictEqual(before.precondition,fresh.precondition))throw Error('Permissions changed before control save.');
  stage='project control save';attempted='control';saved=paired(await setup(options.stateDir,options.endpointId,'setup.apply',{preview_id:preview.preview_id,selection_hash:preview.selection_hash}));if(!controlMatches(saved))throw Error('Control save did not confirm the requested project.');controlSaved=true;attempted='';
  }else {controlSaved=true;controlReused=true;}
  stage='project material preview';const status=paired(await checkedMaterial('material.status',{}));const scope=paired(await setup(options.stateDir,options.endpointId,'setup.status',{}));if(!isDeepStrictEqual(saved.precondition,status.precondition)||!controlMatches(scope)||!isDeepStrictEqual(status.precondition,scope.precondition))throw Error('Project control range changed.');
  const materialPreview=await checkedMaterial('material.prepare',{selection:{kind:'project',cwd:project,expiresAt}});
  const materialFresh=paired(await checkedMaterial('material.status',{}));if(!isDeepStrictEqual(status.precondition,materialFresh.precondition))throw Error('Permissions changed before material save.');
  stage='project material save';attempted='material';const receipt=paired(await checkedMaterial('material.apply',{preview_id:materialPreview.preview_id,selection_hash:materialPreview.selection_hash}));
  if(receipt.material?.version!==2||receipt.material.owner_id!==owner||receipt.material.scope?.cwd!==project||receipt.material.expires_at!==expiresAt)throw Error('Material save did not confirm the requested project and deadline.');materialSaved=true;attempted='';
  return {state:'connected',expiresAt,conversations:read.conversations,messages:read.messages};
 }catch(error){throw Error(`${stage}: ${String(error)} Read ${readSaved?'verified':'not completed'}; project control ${controlReused?'existing permission reused':controlSaved?'saved':'not completed'}; material reception ${materialSaved?'saved':'not completed'}.${attempted?` ${attempted} save was attempted; its final state is unknown.`:''} Full project collaboration was not confirmed. Inspect with the same project command before retrying.`);}
}
