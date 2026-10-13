export type CheckState = "verified" | "missing" | "unknown" | "unavailable" | "incompatible";
export type LoginState = "signed_in" | "signed_out" | "unknown";
export interface SetupDiagnostics {
  /** Online protected assistant instance, not installer/service-registration proof. */
  installation: CheckState;
  pairing: "paired" | "unpaired";
  gateway: CheckState;
  client: CheckState;
  version: CheckState;
  socket: CheckState;
  source: CheckState;
  readCapability: CheckState;
  /** Current authorized native metadata interface verified; no input was executed. */
  controlCapability: CheckState;
  login: LoginState;
  readGrant: "configured" | "missing" | "invalid";
  controlGrant: "configured" | "missing" | "invalid";
}
export type DiagnosticEvidence = Partial<Omit<SetupDiagnostics, "pairing" | "readGrant" | "controlGrant">>;
const checks: readonly CheckState[] = ["verified", "missing", "unknown", "unavailable", "incompatible"];
/** Reconstruct a whitelist: probe exceptions, credentials, paths and arbitrary body fields never escape. */
export function setupDiagnostics(evidence: DiagnosticEvidence, grants: Pick<SetupDiagnostics, "pairing" | "readGrant" | "controlGrant">): SetupDiagnostics {
  const check = (value: unknown): CheckState => checks.includes(value as CheckState) ? value as CheckState : "unknown";
  return Object.freeze({ installation: check(evidence.installation), pairing: grants.pairing,
    gateway: check(evidence.gateway), client: check(evidence.client), version: check(evidence.version), socket: check(evidence.socket), source: check(evidence.source),
    readCapability: check(evidence.readCapability), controlCapability: check(evidence.controlCapability),
    login: ["signed_in", "signed_out", "unknown"].includes(evidence.login ?? "") ? evidence.login! : "unknown",
    readGrant: grants.readGrant, controlGrant: grants.controlGrant });
}
