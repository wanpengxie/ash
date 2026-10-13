import type { NativeInvocationClaim } from "../collaboration/delivery";
import type { PreparedMaterialInput } from "../collaboration/material-input-reader";
import type WebSocket from "ws";
export type Role = "gui" | "device";
export type Frame = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
export interface WorkGrant { work: Readonly<{ node_id: string; endpoint_id: string; kind: "conversation"; native_id: string }>; threadId: string; actions: ReadonlySet<"read" | "resume" | "send_input" | "steer" | "name">; expectedTurnId?: string; createOperationId?: string; preparedInput?: PreparedMaterialInput; claimInput?: NativeInvocationClaim }
export interface CreateGrant { operationId: string; cwd: string; projectId: string }
export interface RoleLease { role: Role; identity: string; generation: string; epoch: number; works: ReadonlyMap<string, WorkGrant>; create?: CreateGrant }
export interface RoleAuthority { acquire(role: Role, listenerIdentity: string): RoleLease; current(lease: RoleLease): boolean; epoch(lease: RoleLease): number; registerCreated?(lease: RoleLease, grant: CreateGrant, thread: { id: string; cwd: string; projectId?: string }): RoleLease }
export interface RegistryPort { epoch(): number; current(): boolean; resolve(server: unknown): "protected" | "nonprotected" | "unknown"; close(): void }
export interface NativeIdentity { identity: string; generation: string; version: string }
/** The supervisor verifies PID/executable/listener/credential custody; no credential is exposed by this port. */
export interface NativeFactory { identity(): NativeIdentity; current(identity: NativeIdentity): boolean; connect(identity: NativeIdentity, signal: AbortSignal): Promise<WebSocket> }
export interface ListenerPort { identity: string; role: Role; current(): boolean; close(): Promise<void> }
export interface ListenerFactory { open(role: Role, accept: (socket: WebSocket, listener: ListenerPort) => void, signal: AbortSignal): Promise<ListenerPort> }
export interface ProxyOptions { native: NativeFactory; registry: RegistryPort; roles: RoleAuthority; listeners: ListenerFactory; version: string; clientMethods: ReadonlySet<string>; serverMethods: ReadonlySet<string>; maxPayload?: number; maxConnections?: number; maxRetired?: number; timeoutMs?: number }
