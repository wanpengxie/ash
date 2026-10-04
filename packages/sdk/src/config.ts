import type { JsonSchema } from "./api";
import { schemaErrors } from "./schema";

export interface WorldConfigV2 {
  delivery: { quiet: string; dedupe_minutes: number };
  reflex: { jev: { url: string; key_credential: string }; threshold: number; timeout_ms: number };
  decision: { jev: { url: string; key_credential: string; model: string; timeout_ms: number };
    routes: { "conversation.control": { enabled: boolean; threshold: number }; "screen.reconcile": { enabled: boolean } } };
  workers: { model: null | { provider: string; model: string } };
  memory: { idle_minutes: number; every_minutes: number };
  heartbeat: { every_minutes: number };
  opener: { away_hours: number };
}

export const DEFAULT_WORLD_CONFIG_V2: WorldConfigV2 = {
  delivery: { quiet: "21:30-09:00", dedupe_minutes: 60 },
  reflex: { jev: { url: "", key_credential: "jev" }, threshold: 0.6, timeout_ms: 6000 },
  decision: { jev: { url: "", key_credential: "jev", model: "", timeout_ms: 6000 },
    routes: { "conversation.control": { enabled: true, threshold: 0.6 }, "screen.reconcile": { enabled: true } } },
  workers: { model: null },
  memory: { idle_minutes: 5, every_minutes: 60 },
  heartbeat: { every_minutes: 30 },
  opener: { away_hours: 6 },
};

const positive: JsonSchema = { type: "integer", minimum: 1 };
const nonnegative: JsonSchema = { type: "integer", minimum: 0 };
const model: JsonSchema = { type: "object", properties: { provider: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 } }, required: ["provider", "model"], additionalProperties: false };
export const WORLD_CONFIG_SCHEMA_V2: JsonSchema = {
  type: "object",
  properties: {
    delivery: { type: "object", properties: { quiet: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$" }, dedupe_minutes: nonnegative }, required: ["quiet", "dedupe_minutes"], additionalProperties: false },
    reflex: { type: "object", properties: { jev: { type: "object", properties: { url: { type: "string" }, key_credential: { type: "string", minLength: 1 } }, required: ["url", "key_credential"], additionalProperties: false }, threshold: { type: "number", minimum: 0, maximum: 1 }, timeout_ms: positive }, required: ["jev", "threshold", "timeout_ms"], additionalProperties: false },
    decision: { type: "object", properties: {
      jev: { type: "object", properties: { url: { type: "string" }, key_credential: { type: "string", minLength: 1 }, model: { type: "string" }, timeout_ms: positive },
        required: ["url", "key_credential", "model", "timeout_ms"], additionalProperties: false },
      routes: { type: "object", properties: {
        "conversation.control": { type: "object", properties: { enabled: { type: "boolean" }, threshold: { type: "number", minimum: 0, maximum: 1 } }, required: ["enabled", "threshold"], additionalProperties: false },
        "screen.reconcile": { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false },
      }, required: ["conversation.control", "screen.reconcile"], additionalProperties: false },
    }, required: ["jev", "routes"], additionalProperties: false },
    workers: { type: "object", properties: { model: { anyOf: [{ type: "null" }, model] } }, required: ["model"], additionalProperties: false },
    memory: { type: "object", properties: { idle_minutes: positive, every_minutes: positive }, required: ["idle_minutes", "every_minutes"], additionalProperties: false },
    heartbeat: { type: "object", properties: { every_minutes: positive }, required: ["every_minutes"], additionalProperties: false },
    opener: { type: "object", properties: { away_hours: positive }, required: ["away_hours"], additionalProperties: false },
  },
  required: ["delivery", "reflex", "workers", "memory", "heartbeat", "opener"],
  additionalProperties: true,
};

/** Fill only this protocol's settings; existing top-level application settings survive. */
export function resolveWorldConfigV2<T extends Record<string, unknown>>(input: T): T & WorldConfigV2 {
  const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (!plainObject(input)) throw new TypeError("config: expected object");
  const merged = { ...input, ...structuredClone(DEFAULT_WORLD_CONFIG_V2) } as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_WORLD_CONFIG_V2)) {
    const value = input[key];
    if (value === undefined) continue;
    if (!plainObject(value)) throw new TypeError(`${key}: expected object`);
    const section = { ...(merged[key] as Record<string, unknown>), ...value };
    if (key === "reflex" && Object.hasOwn(value, "jev")) {
      if (!plainObject(value.jev)) throw new TypeError("reflex.jev: expected object");
      section.jev = { ...DEFAULT_WORLD_CONFIG_V2.reflex.jev, ...value.jev };
    }
    merged[key] = section;
  }
  // Existing Android installations still write reflex; normalize it before applying the new section.
  const legacy = merged.reflex as WorldConfigV2["reflex"];
  const supplied = input.decision as Partial<WorldConfigV2["decision"]> | undefined;
  if (supplied?.jev !== undefined && !plainObject(supplied.jev)) throw new TypeError("decision.jev: expected object");
  if (supplied?.routes !== undefined && !plainObject(supplied.routes)) throw new TypeError("decision.routes: expected object");
  const routes = supplied?.routes;
  for (const id of ["conversation.control", "screen.reconcile"] as const)
    if (routes?.[id] !== undefined && !plainObject(routes[id])) throw new TypeError(`decision.routes.${id}: expected object`);
  merged.decision = { ...(merged.decision as object), jev: { ...DEFAULT_WORLD_CONFIG_V2.decision.jev,
    ...legacy.jev, timeout_ms: legacy.timeout_ms, ...supplied?.jev }, routes: { ...routes,
    "conversation.control": { enabled: true, threshold: legacy.threshold, ...routes?.["conversation.control"] },
    "screen.reconcile": { enabled: true, ...routes?.["screen.reconcile"] } } };
  const errors = schemaErrors(WORLD_CONFIG_SCHEMA_V2, merged);
  if (errors.length) throw new TypeError(errors.join("; "));
  return merged as T & WorldConfigV2;
}
