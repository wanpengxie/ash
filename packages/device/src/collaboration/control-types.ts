export * from "../../../sdk/src/collaboration/control-types";
import type { NativeInvocationClaim } from "./delivery";
import type { PreparedMaterialInput } from "./material-input-reader";
import type { AuthenticatedPrincipal,ControlRequest,NativeOutcome } from "../../../sdk/src/collaboration/control-types";
export interface Invocation {
  principal: AuthenticatedPrincipal;
  request: ControlRequest;
  attempt_id: string;
  connector_epoch: string;
  native_client_message_id: string;
  native_interface_version: string;
  /** Private reader-issued proof; never serialized in control envelopes or journal. */
  prepared_input?: PreparedMaterialInput;
  claim_proof?: NativeInvocationClaim;
}
/** No real connector is wired here. Integrators must validate their native interface separately. */
export interface ControlAdapter {
  connector_epoch: string;
  native_interface_version: string;
  invoke(invocation: Invocation): Promise<NativeOutcome>;
}
