// Explicitly read-only native diagnosis. Copies public policy/config into an
// isolated state with an empty journal; never opens the user's control journal.
import {mkdtempSync,realpathSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDeviceControlRuntime,captureControlTarget} from '../../packages/device/src/collaboration/control-runtime';
import {loadControlAuthorization} from '../../packages/device/src/collaboration/control-authorization';
import {currentPinnedOwnerId} from '../../packages/device/src/collaboration/pairing';
const state='/Users/ahaha/.ash-device/state',node='1cuA2gUEr5I-5l8RtPgDtg',owner='lEUvx84ekY4RDay1oKA3Ek';
const root=realpathSync(mkdtempSync(join(tmpdir(),'ash-readonly-material-target-')));
let runtime:ReturnType<typeof createDeviceControlRuntime>|undefined;
try {
 for(const file of ['paired.json','collaboration-control.json','collaboration-control-runtime.json'])copyFileSync(join(state,file),join(root,file));
 if(currentPinnedOwnerId(root)!==owner)throw Error('Pinned public owner changed');
 const grant=loadControlAuthorization(root,node);if(!grant.authorization_revision)throw Error('Control policy unavailable');
 runtime=createDeviceControlRuntime({stateDir:root,nodeId:node,endpointId:node,pinnedOwnerId:()=>currentPinnedOwnerId(root)});
 const start=performance.now();
 const proof=await captureControlTarget(runtime,{transportOwnerId:owner,isCurrent:()=>true},{endpoint_id:node,authorization_revision:grant.authorization_revision,action:'send_input',work:{node_id:node,endpoint_id:node,kind:'conversation',native_id:'01a13340-f7c8-7890-bcc2-740d374c71ba'}});
 try {proof.current();console.log(JSON.stringify({stage:'readonly_target_capture',ok:true,cwd:proof.cwd,native_id:proof.work.native_id,elapsed_ms:Math.round(performance.now()-start),recapture_check:await proof.check(),boundary:'production metadata thread/read only; isolated empty journal; no material/send/grant mutation'}));}
 finally{proof.release();}
}catch(error){console.log(JSON.stringify({stage:'readonly_target_capture',ok:false,code:(error as any).code??'diagnostic_error',message:(error as Error).message}));process.exitCode=1;}
finally{await runtime?.close();rmSync(root,{recursive:true,force:true});}
