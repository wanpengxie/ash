import {Connection, GatewayClient} from 'ash-gateway/client/client';
import {deviceIdForKey} from 'ash-gateway/src/protocol';
import {join} from 'node:path';
import type {Identity, GatewayLine} from '../link';
import {LocalStateTransaction} from './local-state-transaction';
import {parseCurrentPairing} from './pairing';
import {MaterialProtocolError} from './material-types';
import {MaterialClient, MATERIAL_REQUEST_TYPE, MATERIAL_RESPONSE_TYPE, relayFrame, relayRecord, type MaterialRelayTransport} from './material-client';
import {MATERIAL_PROVIDER_REQUEST_TYPE, MATERIAL_PROVIDER_RESPONSE_TYPE} from './material-provider-protocol';
import {MATERIAL_IDENTITY_TYPE, MaterialLinkWork} from './material-link-bindings';
import {MaterialReceiverCoordinator} from './material-receiver-provider';
import {MaterialInputStaging} from './material-input-staging';
import {MaterialInputReader} from './material-input-reader';
import type {DeviceControlRuntime} from './control-runtime';
/** Signed material relay is separate from the hub's ash-link/1 tunnel. */
export class DeviceMaterialRelay {
 readonly work = new MaterialLinkWork(); readonly state: LocalStateTransaction;
 readonly staging: MaterialInputStaging; readonly reader: MaterialInputReader;
 private readonly gateway: GatewayClient; private conn: Connection | null = null;
 private transportEpoch = 0; private closed = false;
 private receiver?: MaterialReceiverCoordinator; private client: MaterialClient;
 constructor(private readonly options: {stateDir:string; gateway:string; identity:Identity}) {
  this.state = new LocalStateTransaction(options.stateDir, () => this.invalidate());
  this.gateway = new GatewayClient(options.gateway, options.identity.key);
  this.staging = new MaterialInputStaging({rootDir: join(this.state.stateDir, 'material-input-cache'), verifyRetirement(){throw new MaterialProtocolError('unsupported');}});
  this.reader = new MaterialInputReader({staging:this.staging,captureInput:(input,proof)=>this.receiver?this.receiver.captureInput(input,proof):Promise.reject(new MaterialProtocolError('unsupported'))});
  this.client = new MaterialClient({gateway:this.gateway,transport:this.transport(),observeUnfinished:this.work.observeUnfinished});
 }
 attach(line:GatewayLine, control:DeviceControlRuntime):void {
  this.receiver = new MaterialReceiverCoordinator({state:this.state,signer:this.options.identity.key,gateway:this.gateway,transport:this.transport(),control,endpointId:this.options.identity.id,observeUnfinished:this.work.observeUnfinished});
  line.onConnected = conn => {this.conn = conn; this.transportEpoch++; void this.work.run(()=>this.sendMaterialIdentity()).catch(()=>{}); void this.work.run(()=>this.receiver!.connected()).catch(()=>{});};
  line.onDisconnected = () => {this.conn = null; this.invalidate();};
  line.onFrame = frame => {
   if (![MATERIAL_IDENTITY_TYPE,MATERIAL_REQUEST_TYPE,MATERIAL_RESPONSE_TYPE,MATERIAL_PROVIDER_REQUEST_TYPE,MATERIAL_PROVIDER_RESPONSE_TYPE].includes(String(frame.type))) return;
   const captured=structuredClone(frame);void this.work.run(async()=>{if(captured.type===MATERIAL_IDENTITY_TYPE)return this.materialIdentity(captured);if(await this.receiver!.acceptFrame(captured))return;await this.client.acceptFrame(captured);}).catch(()=>{});
  };
 }
 invalidate():void {this.transportEpoch++;this.receiver?.invalidate();this.client?.invalidate();}
 get busy():number {return this.work.busy+(this.receiver?.busy??0)+this.client.inflight;}
 async close():Promise<void> {this.closed=true;this.invalidate();this.work.stop();this.client.close();const result=await this.work.drain();if(result.busy)throw new Error('Material relay is still draining');await this.receiver?.close();this.staging.close();this.state.close();}
  transport(): MaterialRelayTransport {
    const online = () => !this.closed && !!this.conn && this.conn.ws.readyState === WebSocket.OPEN;
    return {
      capture: async () => {
        const conn = this.conn, epoch = this.transportEpoch;
        this.work.current();
        if (!conn || !online()) throw new MaterialProtocolError('offline');
        const token = this.state.capture(), raw = token.files['paired.json']?.raw;
        const pair = raw ? parseCurrentPairing(raw) : null;
        if (!pair || pair.revoked) throw new MaterialProtocolError('permission_denied');
        const key = JSON.parse(raw!).owner_key as string;
        if (await deviceIdForKey(key) !== pair.ownerId) throw new MaterialProtocolError('permission_denied');
        this.state.assertCurrent(token);
        if (epoch !== this.transportEpoch || this.conn !== conn || !online()) throw new MaterialProtocolError('offline');
        return Object.freeze({local_id: this.options.identity.id, peer_id: pair.ownerId, public_key: key,
          pairing_id: `material:${pair.ownerId}:${this.options.identity.id}`, generation: `${epoch}:${token.epoch}:${token.revision}`});
      },
      current: peer => {
        if (!online() || peer.local_id !== this.options.identity.id) throw new MaterialProtocolError('permission_denied');
        const token = this.state.capture(), raw = token.files['paired.json']?.raw;
        const pair = raw ? parseCurrentPairing(raw) : null;
        if (peer.generation !== `${this.transportEpoch}:${token.epoch}:${token.revision}` || !pair || pair.revoked || pair.ownerId !== peer.peer_id || JSON.parse(raw!).owner_key !== peer.public_key) throw new MaterialProtocolError('permission_denied');
        return undefined;
      },
      send: envelope => {
        this.work.current();
        const token = this.state.capture(), raw = token.files['paired.json']?.raw;
        const pair = raw ? parseCurrentPairing(raw) : null;
        if (!online() || envelope.from !== this.options.identity.id || !pair || pair.revoked || envelope.to !== pair.ownerId) throw new MaterialProtocolError('offline');
        this.conn!.send(envelope); return undefined;
      },
    };
  }
  private async sendMaterialIdentity():Promise<void>{const transport=this.transport(),peer=await transport.capture();transport.current(peer);const envelope=await this.gateway.envelope(MATERIAL_IDENTITY_TYPE,peer.peer_id,{version:1,public_key:this.options.identity.key.publicKey},{ttlMs:29999});transport.current(peer);transport.send(envelope);}
  private async materialIdentity(frame:Record<string,unknown>):Promise<void>{const transport=this.transport(),peer=await transport.capture();transport.current(peer);const envelope=relayFrame(frame,MATERIAL_IDENTITY_TYPE,Date.now()),body=relayRecord(JSON.parse(envelope.payload),['version','public_key']);if(envelope.to!==peer.local_id||envelope.from!==peer.peer_id||body.version!==1||body.public_key!==peer.public_key)throw new MaterialProtocolError('permission_denied');if(!await GatewayClient.verifyEnvelope(envelope,peer.public_key))throw new MaterialProtocolError('permission_denied');transport.current(peer);relayFrame(envelope,MATERIAL_IDENTITY_TYPE,Date.now());if(envelope.reply_to===null){const response=await this.gateway.envelope(MATERIAL_IDENTITY_TYPE,peer.peer_id,{version:1,public_key:this.options.identity.key.publicKey},{ttlMs:Math.max(1,envelope.expires_at-Date.now()-1),replyTo:envelope.message_id});transport.current(peer);transport.send(response);}}
}
