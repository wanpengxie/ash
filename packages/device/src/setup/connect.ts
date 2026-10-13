import {realpathSync,lstatSync} from 'node:fs';
import {callConnectionSetup,callReadSourceSetup} from './material-ipc';
/** Native CLI orchestration. One confirmation covers the already discovered
 * source and canonical exact project; cancelling never applies either preview. */
export async function connectCodex(options:{stateDir:string;endpointId:string;project:string;computerName?:string;confirm(summary:string):Promise<boolean>;testing?:{sourceCall?:typeof callReadSourceSetup;setupCall?:typeof callConnectionSetup}}):Promise<{state:'cancelled'|'readable'|'empty';conversations?:number;messages?:number}> {
 const project=realpathSync(options.project),projectStat=lstatSync(project,{bigint:true});if(!projectStat.isDirectory())throw Error('Choose an existing project directory.');
 const sourceCall=options.testing?.sourceCall??callReadSourceSetup,setupCall=options.testing?.setupCall??callConnectionSetup;
 let saved=false,granted=false,sourceAttempted=false,grantAttempted=false,stage='connection status';
 try{
  const initial=await setupCall(options.stateDir,options.endpointId,'setup.status',{});if(!initial.precondition)throw Error('Pair this computer with Ash first.');const owner=initial.precondition.ownerId;
  stage='source status';let source=await sourceCall(options.stateDir,options.endpointId,'source.status',{});
  const existing=source.state==='configured';stage='source discovery';const display=existing?source:await sourceCall(options.stateDir,options.endpointId,'source.inspect',{});
  if(!await options.confirm(`Allow Ash to read saved Codex conversations in ${project}?\nComputer: ${options.computerName??'this paired computer'}\nSource: ${display.source_label??'Codex saved history'}.\nThis replaces the previous project read range; other projects will not be readable. No model task will be started.`))return {state:'cancelled'};
  // Display evidence is released before prompting. Confirming starts a new
  // bounded transaction, but may only select the same original physical source.
  stage='confirmation current';const confirmed=await setupCall(options.stateDir,options.endpointId,'setup.status',{});
  const confirmedProject=lstatSync(project,{bigint:true});
  if(confirmed.precondition?.ownerId!==owner||confirmed.precondition.revision!==initial.precondition.revision||realpathSync(options.project)!==project||!confirmedProject.isDirectory()||confirmedProject.dev!==projectStat.dev||confirmedProject.ino!==projectStat.ino)throw Error('Source, pairing, project or scope changed; run connect and confirm again.');
  if(existing){const freshSource=await sourceCall(options.stateDir,options.endpointId,'source.status',{});if(freshSource.state!=='configured'||freshSource.source_id!==source.source_id||freshSource.binding_revision!==source.binding_revision)throw Error('Saved source changed; confirm again.');source=freshSource;}
  else{stage='source discovery';const preview=await sourceCall(options.stateDir,options.endpointId,'source.prepare',{selection:{kind:'default'}});if(!display.confirmation_binding||preview.confirmation_binding!==display.confirmation_binding)throw Error('Codex source changed; run connect and confirm again.');
    stage='source save';sourceAttempted=true;source=await sourceCall(options.stateDir,options.endpointId,'source.apply',{preview_id:preview.preview_id,selection_hash:preview.selection_hash});saved=true;}
  if(source.state!=='configured'||typeof source.source_id!=='string'||typeof source.binding_revision!=='string')throw Error('Saved Codex source is unavailable.');
  stage='read scope status';const fresh=await setupCall(options.stateDir,options.endpointId,'setup.status',{});if(fresh.precondition?.ownerId!==owner)throw Error('Pairing changed; confirm again.');
  const already=fresh.read?.version===3&&fresh.read.source_id===source.source_id&&fresh.read.binding_revision===source.binding_revision&&fresh.read.allowedCwds.length===1&&fresh.read.allowedCwds[0]===project;
  if(!already){
  stage='read scope preview';const selected=await setupCall(options.stateDir,options.endpointId,'setup.prepare',{selection:{kind:'read',allowedCwds:[project]},source_binding:{source_id:source.source_id,binding_revision:source.binding_revision}});
  stage='read scope save';grantAttempted=true;const applied=await setupCall(options.stateDir,options.endpointId,'setup.apply',{preview_id:selected.preview_id,selection_hash:selected.selection_hash});granted=true;
  if(applied.read?.version!==3||applied.read.source_id!==source.source_id||applied.read.binding_revision!==source.binding_revision||applied.read.allowedCwds.length!==1||applied.read.allowedCwds[0]!==project)throw Error('Read scope changed during connection.');
  }
  stage='read verification';return await setupCall(options.stateDir,options.endpointId,'setup.verify-read',{project});
 }catch(error){const code=(error as any)?.code;const advice=code==='source_not_running'?'Open Codex with this project, then run this command again.':code==='ambiguous_source'?'Several distinct Codex sources require a source selection; no permission was changed.':code==='unsupported'?'This installed Codex version is not supported by this Ash build.':String(error);
  throw Error(`${stage}: ${advice}${granted?' Read scope was saved, but reading could not be verified.':grantAttempted?' Read permission save was attempted; its final state is unknown. Run the same connect command again to inspect the current state and confirm.':saved?' Source was saved; project read permission was not completed.':sourceAttempted?' Source save was attempted; source and previous read permission may have changed. Run the same connect command again to inspect the current state and confirm.':''}`);
 }
}
