import type { JsonSchema } from "./api";
import { schemaErrors } from "./schema";

export interface WorldConfigV2 {
  delivery: { quiet: string; dedupe_minutes: number };
  reflex: { jev: { url: string; key_credential: string }; threshold: number; timeout_ms: number };
  workers: { model: null | { provider: string; model: string } };
  memory: { idle_minutes: number; every_minutes: number };
  heartbeat: { every_minutes: number };
  opener: { away_hours: number };
}

export const DEFAULT_WORLD_CONFIG_V2: WorldConfigV2 = {
  delivery: { quiet: "21:30-09:00", dedupe_minutes: 60 },
  reflex: { jev: { url: "", key_credential: "jev" }, threshold: 0.6, timeout_ms: 3000 },
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
  const errors = schemaErrors(WORLD_CONFIG_SCHEMA_V2, merged);
  if (errors.length) throw new TypeError(errors.join("; "));
  return merged as T & WorldConfigV2;
}
