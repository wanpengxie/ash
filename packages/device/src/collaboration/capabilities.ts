import type { CapabilitySpec } from "./compat";
import type { ReadAuthorizationSnapshot } from "./authorization";

export const COLLABORATION_LIST = "collaboration.work.list";
export const COLLABORATION_READ = "collaboration.work.read";
export const isCollaborationCapability = (name: string) => name.startsWith("collaboration.");
const page = { type: "object", additionalProperties: false, properties: { cursor: { type: "string", minLength: 1, maxLength: 1024 }, limit: { type: "integer", minimum: 1, maximum: 100 } } };
export function readCapabilities(authorization: ReadAuthorizationSnapshot): CapabilitySpec[] {
  if (authorization.state !== "ready") return [];
  return [COLLABORATION_LIST, COLLABORATION_READ].map(name => ({
    name, description: name === COLLABORATION_LIST ? "List authorized Codex saved conversations" : "Read an authorized Codex saved conversation page", risk: "none", timeout_ms: 30_000,
    input_schema: { type: "object", additionalProperties: false, required: name === COLLABORATION_LIST ? ["version", "endpoint_id", "authorization_revision"] : ["version", "endpoint_id", "authorization_revision", "work"], properties: {
      version: { const: 1 }, endpoint_id: { const: authorization.endpoint_id }, authorization_revision: { type: "string", pattern: "^[a-f0-9]{64}$" }, page,
      ...(name === COLLABORATION_READ ? { work: { type: "object", additionalProperties: false, required: ["node_id", "endpoint_id", "kind", "native_id"], properties: { node_id: { const: authorization.endpoint_id }, endpoint_id: { const: authorization.endpoint_id }, kind: { const: "conversation" }, native_id: { type: "string", minLength: 1, maxLength: 1024 } } } } : {}),
    } },
  }));
}

import { CONTROL_CAPABILITIES, type ControlManifestDto, type ControlOperation } from "./control-protocol";
export function controlOperation(name: string): ControlOperation | undefined {
  return (Object.keys(CONTROL_CAPABILITIES) as ControlOperation[]).find(operation => CONTROL_CAPABILITIES[operation] === name);
}
export function controlCapabilities(manifest: ControlManifestDto, nodeId: string): CapabilitySpec[] {
  const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$" };
  const work = { type: "object", additionalProperties: false, required: ["node_id", "endpoint_id", "kind", "native_id"], properties: { node_id: { const: nodeId }, endpoint_id: { const: manifest.endpoint_id }, kind: { const: "conversation" }, native_id: id } };
  const action = { enum: ["send_input", "steer"] };
  return (Object.keys(CONTROL_CAPABILITIES) as ControlOperation[]).map(operation => ({
    name: CONTROL_CAPABILITIES[operation], description: `Codex collaboration control ${operation}`, risk: operation === "apply" ? "outward" : "none", timeout_ms: 30_000,
    input_schema: { type: "object", additionalProperties: false,
      required: ["version", "endpoint_id", "authorization_revision", "work", ...(operation === "apply" ? ["request", "expected_connector_epoch"] : operation === "state" ? ["action"] : ["action", "operation_id"])],
      properties: { version: { const: 1 }, endpoint_id: { const: manifest.endpoint_id }, authorization_revision: { type: "string", pattern: "^[a-f0-9]{64}$" }, work,
        ...(operation === "apply" ? { expected_connector_epoch: id, request: { type: "object", additionalProperties: false, required: ["request_id", "operation_id", "work", "action", "input", "expires_at"], properties: { request_id: id, operation_id: id, work, action, input: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", minLength: 1 } } }, expected_turn_id: id, expires_at: { type: "integer", minimum: 1 } } } } : { action, ...(operation === "state" ? {} : { operation_id: id }) }),
      },
    },
  }));
}

import { CREATE_CAPABILITIES, type CreateOperation } from "./create-protocol";
import type { CreateManifestDto } from "./create-types";
export function createOperation(name: string): CreateOperation | undefined {
  return (Object.keys(CREATE_CAPABILITIES) as CreateOperation[]).find(operation => CREATE_CAPABILITIES[operation] === name);
}
export function createCapabilities(manifest: CreateManifestDto, nodeId: string): CapabilitySpec[] {
  if (manifest.grant_state !== "ready" || !manifest.scope) return [];
  const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$" };
  const scope = { node_id: { const: nodeId }, endpoint_id: { const: manifest.endpoint_id }, cwd: { const: manifest.scope.cwd } };
  const revision = { const: manifest.authorization_revision };
  const target = { type: "object", additionalProperties: false, required: ["node_id", "endpoint_id", "project_id", "cwd"], properties: { ...scope, project_id: id } };
  return manifest.actions.map(operation => ({ name: CREATE_CAPABILITIES[operation], description: `Codex collaboration create ${operation}`, risk: operation === "apply" ? "outward" : "none", timeout_ms: 30_000,
    input_schema: { type: "object", additionalProperties: false,
      required: operation === "projects" ? ["version", "node_id", "endpoint_id", "authorization_revision", "cwd"] : operation === "apply" ? ["version", "request", "expected_connector_epoch"] : ["version", "target", "authorization_revision", "operation_id"],
      properties: { version: { const: 1 }, ...(operation === "projects" ? { ...scope, authorization_revision: revision } : operation === "apply" ? {
        expected_connector_epoch: id, request: { type: "object", additionalProperties: false, required: ["version", "request_id", "operation_id", "authorization_revision", "target", "title", "input", "expires_at"], properties: {
          version: { const: 1 }, request_id: id, operation_id: id, authorization_revision: revision, target, title: { type: "string", minLength: 1, maxLength: 256 }, input: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", minLength: 1 } } }, expires_at: { type: "integer", minimum: 1 },
        } },
      } : { target, authorization_revision: revision, operation_id: id }) },
    },
  }));
}
