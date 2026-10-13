import type {Connection} from 'ash-gateway/client/client';
import {GatewayLine, loadIdentity} from '../../src/link';
import {startDevice, type DeviceConfig, type DeviceDeps, type RunningDevice} from '../../src/main';
import {currentPinnedOwnerId} from '../../src/collaboration/pairing';
import {startKernel, openTunnel, eventually, request, context} from '../kernel';
import {WordError} from '../../../sdk/src/message';
import type {CallResult} from '../../src/collaboration/compat';
import {realpathSync} from 'node:fs';
/** Only the relay road is isolated; the real HandClient handshake and calls cross an in-memory kernel socket. */
class FixtureGateway extends GatewayLine {
  override async pair() {}
  override async run() {this.connected=true;this.onConnected({ws:{readyState:WebSocket.OPEN},send() {},close() {}} as unknown as Connection);}
}
export interface ConnectedDevice extends RunningDevice {
  call(capability:string,args?:Record<string,unknown>,caller?:string):Promise<CallResult>;
  update(version:string,sha256:string):Promise<unknown>;
  disconnect():void;
  replacePeer(peer:string):Promise<void>;
}
export async function startConnectedDevice(config:DeviceConfig, _pair?:string, deps:DeviceDeps = {}):Promise<ConnectedDevice> {
  const kernel=await startKernel(), identity=await loadIdentity(config.stateDir), owner=currentPinnedOwnerId(config.stateDir);
  if (!owner) {await kernel.stop();throw new Error('Fixture requires a persisted owner pairing');}
  kernel.pair(identity);
  let device:RunningDevice;
  try {device=await startDevice(config,undefined,{...deps,ego:null,kimiPorts:[0],relay:true,relayFactory:(...args)=>new FixtureGateway(...args)});}
  catch(error){await kernel.stop();throw error;}
  let tunnel=openTunnel(kernel,device,identity.id,owner);await device.client.ready();
  await eventually(()=>kernel.hands.capabilities(identity.id).includes('collaboration.endpoint.describe'),'device manifest');
  const call=async(capability:string,args:Record<string,unknown>={},caller='person:owner'):Promise<CallResult>=>{
    const member=kernel.registry.members.get(`device:${identity.id}`)!;
    try {const result=await member.handle(request(`device:${identity.id}`,capability,args,caller),context({raw:args,caller:{member:caller,via:'human',local:false}}));return {ok:true,content:[],data:result?.data};}
    catch(error){return {ok:false,content:[],error:error instanceof Error?error.message:String(error),data:error instanceof WordError?error.detail??{code:error.code}:{code:'offline'}};}
  };
  return {...device,run:Promise.resolve(),call,async update(version,sha256){const result=await call('x.ash.update',{version,sha256},'service:devices');if(!result.ok)throw new Error(result.error);return result.data;},disconnect:()=>tunnel.cut(),
    async replacePeer(peer){tunnel.cut();await eventually(()=>device.client.state!=="ready","old tunnel closing");tunnel=openTunnel(kernel,device,identity.id,peer);await device.client.ready();},
    async close(){try{await device.close();}finally{await kernel.stop();}}};
}
