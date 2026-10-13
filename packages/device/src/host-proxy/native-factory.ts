import WebSocket from "ws";
import type { NativeFactory, NativeIdentity } from "./types";
import { NativeEvidence } from "./native-evidence";
/** Authenticates each one-to-one upstream connection without exposing capability material to the proxy API. */
export class AuthenticatedNativeFactory implements NativeFactory {
  constructor(private readonly evidence:NativeEvidence,private readonly timeoutMs=5000){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error("native connection bound unavailable");}
  identity():NativeIdentity{return this.evidence.attest();}
  current(identity:NativeIdentity):boolean{return this.evidence.current(identity);}
  connect(identity:NativeIdentity,signal:AbortSignal):Promise<WebSocket>{return this.evidence.connectAuthenticated(identity,signal,this.timeoutMs);}
}
