import {connectCodex} from './setup/connect';
import {connectProjectCollaboration} from './setup/connect-project';
import {installControlConnection} from './setup/control-connect-install';
import {planSharedCodexLaunch,startSharedCodexLaunch} from './setup/shared-codex-launch';
import {createInterface} from 'node:readline/promises';
import {callConnectionSetup,callConnectionReady,callResultExportSetup} from './setup/material-ipc';
import {realpathSync} from 'node:fs';
import {DeviceKey} from 'ash-gateway/client/client';
import {callMaterialSetup,callReadSourceSetup} from './setup/material-ipc';
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEVICE_VERSION, installRelease, serviceDefinition } from "./install";
import type { startDevice, DeviceConfig } from "./main";
import { deviceLogger } from "./log";
import { loadIdentity } from "./link";
import { parseReadAuthorization, READ_AUTHORIZATION_MAX_BYTES } from "./collaboration/authorization";
import { loadCurrentPairing, parseCurrentPairing } from "./collaboration/pairing";
import { readLocalStateFile } from "./collaboration/local-state";
import { LocalStateError, LocalStateTransaction } from "./collaboration/local-state-transaction";
const exec = promisify(execFile);
export async function deviceCli(start: typeof startDevice, args = process.argv.slice(2)): Promise<void> {
  const option = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes("--version")) { console.log(DEVICE_VERSION); return; }
  const command = args[0]?.startsWith("--") ? "run" : args[0] ?? "help";
  const root = resolve(option("--root") ?? join(homedir(), ".ash-device")), configPath = resolve(option("--config") ?? join(root, "device.json"));
  if (command === "run") { const log = deviceLogger(join(dirname(configPath), "logs")); console.log = log; console.error = log; }
  // The bootstrap installs a wrapper without adding it to PATH. Use the running
  // release location: --root selects state and need not contain the executable.
  const executable = process.argv[1] && basename(process.argv[1]) === "ash-device.mjs"
    ? resolve(dirname(process.argv[1]), "bin", "ash-device")
    : join(root, "current", "bin", "ash-device");
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const stateArgs = `${args.includes('--root') ? ` --root ${quote(root)}` : ''}${args.includes('--config') ? ` --config ${quote(configPath)}` : ''}`;
  const connectCommand = `${quote(executable)} connect codex${stateArgs}`;
  const projectHandoff = () => {
    console.log('First enter the project you want to share (cd /path/to/project), then run:');
    console.log(connectCommand);
    console.log('This asks you to confirm read access to this project.');
  };
  const serviceFile = process.platform === "darwin" ? join(homedir(), "Library/LaunchAgents/ai.ash.device.plist") : join(homedir(), ".config/systemd/user/ash-device.service");
  if(command==='result-file'){
    const file=readLocalStateFile(configPath,READ_AUTHORIZATION_MAX_BYTES);if(!file)throw Error('Start the computer connector first.');
    const config=JSON.parse(file.raw) as DeviceConfig,key=readLocalStateFile(join(config.stateDir,'device.jwk'),16*1024);if(!key)throw Error('Computer identity is unavailable.');
    const signer=await DeviceKey.fromJwk(JSON.parse(key.raw));
    if(args.includes('--revoke')){await callResultExportSetup(config.stateDir,signer.id,'result-export.revoke',{});console.log('Result file access revoked.');return;}
    const pending=await callResultExportSetup(config.stateDir,signer.id,'result-export.pending',{}) as {pending_id:string;path:string;byte_length:number}[];
    if(!pending.length){console.log('No result file is waiting for approval. Tap its link in Ash first.');return;}
    if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Open a terminal and run ash-device result-file to confirm the file.');
    pending.forEach((p,i)=>console.log(`${i+1}. ${p.path} (${p.byte_length} bytes)`));
    const prompt=createInterface({input:process.stdin,output:process.stdout});
    try{const selected=pending.length===1?1:Number((await prompt.question('File number (empty to cancel): ')).trim());if(!Number.isInteger(selected)||selected<1||selected>pending.length)return;
      const item=pending[selected-1]!;if(!/^(y|yes)$/i.test((await prompt.question(`Allow Ash to save this file snapshot for 15 minutes? ${item.path} [y/N] `)).trim()))return;
      await callResultExportSetup(config.stateDir,signer.id,'result-export.approve',{pending_id:item.pending_id});console.log('File approved. Tap the same file link in Ash to save it.');
    }finally{prompt.close();}return;
  }
  if(command==='codex-shared'){
    const plan=await planSharedCodexLaunch();
    if(!args.includes('--start')){console.log(`Codex ${plan.version??'unknown'}: desktop=${plan.desktop}, shared=${plan.daemon}.`);console.log(`Save your work and quit Codex normally, then run: ${quote(executable)} codex-shared --start`);console.log('Recovery: quit Codex normally, then open -a /Applications/ChatGPT.app');return;}
    let prepareMissingSettings=false;
    if(plan.policy==='missing'&&plan.blockers.every(code=>code==='daemon_policy_missing')){
      if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Run codex-shared --start in an interactive terminal to confirm shared connection preparation.');
      console.log('Prepare a local shared connection for Codex, with remote control and automatic daemon updates turned off.');
      console.log('Codex will open with the shared service. Sending still needs connection verification.');
      const prompt=createInterface({input:process.stdin,output:process.stdout});
      try{prepareMissingSettings=/^(y|yes)$/i.test((await prompt.question('Prepare shared connection and open Codex? [y/N] ')).trim());}finally{prompt.close();}
      if(!prepareMissingSettings){console.log('Cancelled; no shared settings or launch changes made.');return;}
    }
    const result=await startSharedCodexLaunch(plan,{approved:true,prepareMissingSettings});
    if(result.state==='blocked')throw Error(`Shared connection: ${result.code}. Save your work and quit Codex normally before trying again.`);
    console.log(result.mode==='shared'?'Codex opened with the shared service. Desktop attachment must still be verified before sending.':'Codex opened normally because the shared launch failed. Sending is not connected.');return;
  }
  if(command==='material-scope'){
    const configFile=readLocalStateFile(configPath,READ_AUTHORIZATION_MAX_BYTES);if(!configFile)throw new Error('Device configuration is missing');const config=JSON.parse(configFile.raw) as DeviceConfig,key=readLocalStateFile(join(config.stateDir,'device.jwk'),16*1024);if(!key)throw new Error('Material scope: service_unavailable; start the connector first');const signer=await DeviceKey.fromJwk(JSON.parse(key.raw)),materialRoot=realpathSync(config.stateDir);const works=args.flatMap((arg,index)=>arg==='--allow-work'?[args[index+1]]:[]),clear=args.includes('--clear');if(clear&&works.length)throw new Error('material-scope uses --clear or --allow-work');
    try{if(!clear&&!works.length){console.log(JSON.stringify(await callMaterialSetup(materialRoot,signer.id,'material.status',{})));return;}
      const status=await callMaterialSetup(materialRoot,signer.id,'material.status',{});if(status.error)throw new Error('Material scope: '+status.error);if(!status.precondition)throw new Error('Material scope: unpaired');let selection:null|{grants:unknown[];expiresAt:number}=null;
      if(!clear){const minutes=Number(option('--expires-in-minutes'));if(!Number.isSafeInteger(minutes)||minutes<1||minutes>7*24*60||works.some(work=>typeof work!=='string'||!work)||works.length>32)throw new Error('material-scope requires --allow-work NATIVE_ID and --expires-in-minutes 1..10080');selection={expiresAt:Date.now()+minutes*60000,grants:works.map(native_id=>({action:'receive_input',source_node_id:status.precondition.ownerId,source_endpoint_id:'materials',target:{node_id:signer.id,endpoint_id:signer.id,kind:'conversation',native_id}}))};}
      const preview=await callMaterialSetup(materialRoot,signer.id,'material.prepare',{selection});if(preview.error)throw new Error('Material scope: '+preview.error);const applied=await callMaterialSetup(materialRoot,signer.id,'material.apply',{preview_id:preview.preview_id,selection_hash:preview.selection_hash});if(applied.error)throw new Error('Material scope: '+applied.error);console.log(clear?'Material receive_input scope cleared.':'Material receive_input scope saved.');return;
    }catch(error){if(String(error).includes('service_unavailable'))throw new Error('Material scope: service_unavailable; start the connector first');throw error;}
  }
  if(command==='connect'||command==='read-scope'){
    let connectProject: string | undefined;
    if(command==='connect'){
      if(args[1]!=='codex')throw Error('Use ash-device connect codex [--project PATH] [--control]');
      const seen=new Set<string>();
      for(let i=2;i<args.length;i++){
        const flag=args[i];
        if(!['--project','--config','--root','--control','--collaborate','--expires-in-minutes'].includes(flag)||seen.has(flag))throw Error(`Unexpected connect argument: ${flag}`);
        seen.add(flag);
        if(flag==='--control'||flag==='--collaborate')continue;
        const value=args[++i];
        if(!value||value.startsWith('--'))throw Error(`${flag} requires a value.`);
        if(flag==='--project')connectProject=value;
      }
      if(seen.has('--control')&&seen.has('--collaborate'))throw Error('Choose --control or --collaborate.');
      if(seen.has('--expires-in-minutes')&&!seen.has('--collaborate'))throw Error('--expires-in-minutes requires --collaborate.');
      if(seen.has('--collaborate')){const minutes=Number(option('--expires-in-minutes')??1440);if(!Number.isSafeInteger(minutes)||minutes<1||minutes>10080)throw Error('--expires-in-minutes must be 1..10080.');}
      connectProject??=process.cwd();
    }
    const file=readLocalStateFile(configPath,READ_AUTHORIZATION_MAX_BYTES);if(!file)throw Error('Pair this computer with Ash first: ash-device setup --gateway URL --pair CODE');
    const config=JSON.parse(file.raw) as DeviceConfig,pair=loadCurrentPairing(join(config.stateDir,'paired.json'));if(!pair||pair.revoked)throw Error('Pair this computer with Ash first.');
    if(command==='connect'&&args.includes('--control')){
      const key=readLocalStateFile(join(config.stateDir,'device.jwk'),16*1024);if(!key)throw Error('This paired computer has no device credential. Pair this computer again.');
      const signer=await DeviceKey.fromJwk(JSON.parse(key.raw));
      if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Run connect --control in an interactive terminal to select a conversation and confirm control permission.');
      const prompt=createInterface({input:process.stdin,output:process.stdout});
      try{
        const result=await installControlConnection({stateDir:config.stateDir,endpointId:signer.id,project:connectProject!,choose:async items=>{console.log('Loaded Codex conversations in this project:');items.forEach((item,index)=>console.log(`${index+1}. ${item.title} · ${item.work.native_id.slice(0,8)} · ${item.updated_at===null?'更新时间未知':new Date(item.updated_at).toLocaleString()}\n   ${item.cwd}`));const answer=(await prompt.question('Choose a conversation number, or press Enter to cancel: ')).trim();if(!answer)return null;if(!/^[1-9][0-9]*$/.test(answer))throw Error('Choose a displayed conversation number.');return Number(answer);},confirm:async summary=>{console.log(summary);return /^(y|yes)$/i.test((await prompt.question('Allow send and steer for this conversation? [y/N] ')).trim());}});
        console.log(result.state==='cancelled'?'Cancelled; no control permission save was attempted.':'Control permission saved for the selected conversation. Refresh Computers in Ash.');
      }finally{prompt.close();}
      return;
    }
    const signer=(await loadIdentity(config.stateDir)).key;let running:Awaited<ReturnType<typeof start>>|undefined;
    try{
      try{await callReadSourceSetup(config.stateDir,signer.id,'source.status',{});}catch(error){if(!String(error).includes('service_unavailable'))throw error;running=await start(config);console.log('Ash is running in this terminal. Keep it open to stay online.');}
      if(running){const deadline=Date.now()+30000;let ready=false;while(Date.now()<deadline){ready=await callConnectionReady(config.stateDir,signer.id,Math.min(1000,deadline-Date.now()));if(ready)break;await new Promise(resolve=>setTimeout(resolve,Math.min(100,Math.max(0,deadline-Date.now()))));}if(!ready)throw Error('Ash could not connect within 30 seconds. Check the gateway connection and try again.');}
      if(command==='read-scope'&&args.includes('--clear')){const p=await callConnectionSetup(config.stateDir,signer.id,'setup.prepare',{selection:{kind:'read',clear:true}});await callConnectionSetup(config.stateDir,signer.id,'setup.apply',{preview_id:p.preview_id,selection_hash:p.selection_hash});console.log('Desktop history read scope cleared.');}
      else{
        const projects=command==='connect'?[connectProject]:args.flatMap((arg,index)=>arg==='--allow-cwd'?[args[index+1]]:[]);if(projects.length!==1||!projects[0])throw Error('Use ash-device connect codex --project PATH to authorize one project.');
        const collaborating=command==='connect'&&args.includes('--collaborate');
        const result=await (collaborating?connectProjectCollaboration:connectCodex)({expiresInMinutes:Number(option('--expires-in-minutes')??1440),stateDir:config.stateDir,endpointId:signer.id,project:projects[0],computerName:config.name,confirm:async summary=>{if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Run connect in an interactive terminal to confirm read permission.');console.log(summary);const prompt=createInterface({input:process.stdin,output:process.stdout});try{return /^(y|yes)$/i.test((await prompt.question(collaborating?'Allow project collaboration? [y/N] ':'Allow read access? [y/N] ')).trim());}finally{prompt.close();}}});
        if(result.state==='cancelled'){console.log('Cancelled; no read, control or material permissions were saved.');await running?.close();return;}
        console.log(result.state==='empty'?'Connected. This project has no saved conversations yet. Refresh Computers in Ash.':'Connected. Saved conversations are readable; open or refresh Computers in Ash.');
        if(collaborating){
          const projectArg=args.includes('--project')?` --project ${quote(resolve(connectProject!))}`:'';
          console.log(`Project collaboration approved. Material reception expires at ${new Date((result as {expiresAt:number}).expiresAt).toISOString()}. Refresh Computers in Ash.`);
          console.log(`To renew for this project: ${quote(executable)} connect codex --collaborate${projectArg} --expires-in-minutes ${Number(option('--expires-in-minutes')??1440)}${stateArgs}`);
        }else if(command==='connect'){
          console.log('This project is readable. Sending permissions were not changed by this command.');
          const projectArg=args.includes('--project')?` --project ${quote(resolve(connectProject!))}`:'';
          console.log(`To allow sending, select a conversation and confirm: ${quote(executable)} connect codex --control${projectArg}${stateArgs}`);
        }
      }
      if(running){for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void running!.close();});await running.run;}
    }catch(error){await running?.close();throw error;}
    return;
  }
  if (command === "setup") {
    const gateway = option("--gateway"), pair = option("--pair");
    if (!gateway || !pair) throw new Error("setup requires --gateway URL --pair CODE");
    const url = new URL(gateway); if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS for the gateway");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const config: DeviceConfig = { gateway, name: option("--name") ?? hostname(),
      stateDir: join(root, "state"), workdir: resolve(option("--workdir") ?? join(homedir(), "ash-shared")), installRoot: root };
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log("Open Ash and approve this computer's pairing request. Choose what it may do: lend its abilities, be a body, run local agents, web access.");
    const running = await start(config, pair); await running.close();
    if (args.includes("--no-service")) {
      console.log(`Paired. Start with: ${quote(executable)} run --config ${quote(configPath)}${args.includes('--root') ? ` --root ${quote(root)}` : ''}`);
      console.log('Keep that terminal open. In another terminal:');
      projectHandoff(); return;
    }
    await mkdir(dirname(serviceFile), { recursive: true });
    await writeFile(serviceFile, serviceDefinition(root, process.platform, process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"), { mode: 0o600 });
    if (process.platform === "darwin") {
      const domain = `gui/${process.getuid!()}`;
      await exec("launchctl", ["bootout", domain, serviceFile]).catch(() => {});
      await exec("launchctl", ["bootstrap", domain, serviceFile]);
    } else {
      await exec("systemctl", ["--user", "daemon-reload"]); await exec("systemctl", ["--user", "enable", "--now", "ash-device.service"]);
      console.log("For service after logout, enable lingering if desired: loginctl enable-linger");
    }
    console.log("Ash device is paired and its user service is running."); projectHandoff(); return;
  }
  if (command === "status") {
    const file = readLocalStateFile(configPath, READ_AUTHORIZATION_MAX_BYTES);
    if (!file) throw new Error("Device configuration is missing");
    const config = JSON.parse(file.raw) as DeviceConfig;
    const pairing = loadCurrentPairing(join(config.stateDir, "paired.json"));
    console.log(JSON.stringify({ version: DEVICE_VERSION, configured: true, paired: !!pairing && !pairing.revoked, revoked: pairing?.revoked === true })); return;
  }
  if (command === "uninstall") {
    if (process.platform === "darwin") await exec("launchctl", ["bootout", `gui/${process.getuid!()}`, serviceFile]).catch(() => {});
    else await exec("systemctl", ["--user", "disable", "--now", "ash-device.service"]).catch(() => {});
    if (await access(serviceFile).then(() => true, () => false)) await rename(serviceFile, serviceFile + `.disabled-${Date.now()}`);
    console.log(`Service removed. Files, login keys and work are preserved in ${root}.`); return;
  }
  if (command === "update") {
    const version = option("--version-to"), hash = option("--sha256"); if (!version || !hash) throw new Error("update requires --version-to and --sha256");
    console.log(await installRelease(root, version, hash));
    console.log("Restart the ash-device user service to use the update."); return;
  }
  if (command !== "run") { console.log("ash-device setup --gateway URL --pair CODE [--name NAME] [--workdir PATH]\nash-device run | status | update --version-to VERSION --sha256 HASH | uninstall\nash-device connect codex [--project PATH] (defaults to the current directory; reads saved conversations)\nash-device connect codex --control [--project PATH] (defaults to the current directory; select and confirm sending)\nash-device connect codex --collaborate [--project PATH] [--expires-in-minutes 1..10080] (project collaboration; materials default to 24 hours)\nash-device codex-shared [--start]\nash-device read-scope --allow-cwd PATH | --clear\nash-device material-scope [--allow-work NATIVE_ID --expires-in-minutes MINUTES | --clear]\nash-device result-file [--revoke]"); return; }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const running = await start(config, option("--pair"), { restart: () => { void running.close().then(() => process.exit(0)); } });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void running.close().then(() => process.exit(0)); });
  await running.run;
  // The connection is over for good (revoked, or the hub speaks another protocol): leave the service stopped, not retrying.
  const paired = JSON.parse(await readFile(join(config.stateDir, "paired.json"), "utf8").catch(() => "{}"));
  console.log(paired.revoked ? "This computer was revoked by its owner; pair it again to reconnect." : "The connection to Ash ended and will not be retried.");
  await running.close();
  process.exit(paired.revoked ? 0 : 1);
}
