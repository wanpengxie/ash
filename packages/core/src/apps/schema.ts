// The app description (app.json) of contract ash-app/1, and its validation. docs/app.schema.json is the same schema,
// published for app authors; a test keeps the two identical.
import Ajv from "ajv";

export const APP_CONTRACT = "ash-app/1";
export const APP_ID_PATTERN = "^[a-z][a-z0-9-]{0,47}$";
const why = { type: "string", minLength: 1, maxLength: 200 };
const TOOL_NAME = "^[a-z][a-z0-9_.-]{0,63}$";
/** An app card's id; on the home screen the card is <app id>.<card id> (at most 64 characters, like every card id). */
export const APP_CARD_ID_PATTERN = "^[a-z][a-z0-9-]{0,14}$";
export const APP_CARD_SIZES = ["2x2", "4x2", "4x4"] as const;

export const APP_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://ash.invalid/schemas/ash-app-1.json",
  title: "Ash app description (ash-app/1)",
  type: "object",
  required: ["contract", "id", "name", "version", "summary", "publisher", "server"],
  additionalProperties: false,
  properties: {
    contract: { const: APP_CONTRACT },
    id: { type: "string", pattern: APP_ID_PATTERN, description: "Unique, lower case. Third parties prefix their publisher name, e.g. example-notes." },
    name: { type: "string", minLength: 1, maxLength: 40 },
    version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$" },
    icon: { type: "string", pattern: "^[A-Za-z0-9_-][A-Za-z0-9_.-]*\\.(?:png|svg|webp)$", description: "A file next to app.json." },
    summary: { type: "string", minLength: 1, maxLength: 200 },
    role: { type: "string", minLength: 1, maxLength: 200, description: "What this organ of ash is for and when Ash should use it, in one sentence; shown to the agent in every conversation." },
    publisher: { type: "string", minLength: 1, maxLength: 80 },
    server: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      description: "The app's MCP server, started inside the container over stdio with the app's folder as working directory.",
      properties: {
        command: { type: "string", minLength: 1, maxLength: 200 },
        args: { type: "array", maxItems: 32, items: { type: "string", maxLength: 500 } },
        env: { type: "object", maxProperties: 32, propertyNames: { pattern: "^[A-Z][A-Z0-9_]{0,63}$", not: { pattern: "^ASH_" } }, additionalProperties: { type: "string", maxLength: 2000 } },
      },
    },
    surfaces: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        required: ["id", "title", "resource"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
          title: { type: "string", minLength: 1, maxLength: 20 },
          resource: { type: "string", pattern: "^ui://[^\\s]{1,200}$" },
        },
      },
    },
    events: { type: "array", maxItems: 32, items: { type: "string", pattern: "^[a-z][a-z0-9_-]*(?:\\.[a-z0-9_-]+)+$", not: { enum: ["app.card", "app.activity"] } } },
    wake_events: { type: "array", maxItems: 32, items: { type: "string", pattern: "^[a-z][a-z0-9_-]*(?:\\.[a-z0-9_-]+)+$" },
      description: "Events (each also in events) that should wake Ash at once rather than wait for the next conversation; a few a day at most." },
    data_dir: { type: "string", pattern: "^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$", not: { enum: ["ui", "node_modules"] },
      description: "The folder (inside the app's folder) where the app keeps the owner's data; apps.reset empties it, apps.remove {keep_data} keeps it." },
    cards: {
      type: "array",
      maxItems: 8,
      description: "Home-screen cards the app draws from its own data: the tool returns the card (A2UI), taps go to the action tool.",
      items: {
        type: "object",
        required: ["id", "title", "size", "tool"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: APP_CARD_ID_PATTERN },
          title: { type: "string", minLength: 1, maxLength: 40 },
          size: { enum: [...APP_CARD_SIZES] },
          tool: { type: "string", pattern: TOOL_NAME, description: "A read-only tool of this app that returns the card: {components, root?, data?, sizes?, theme?}." },
          action: { type: "string", pattern: TOOL_NAME, description: "The tool a tap, toggle or choice on the card calls: {card, action, component?, item?, checked?, value?, context?}." },
          refresh_min: { type: "integer", minimum: 5, maximum: 1440, description: "Redraw at least this often (minutes; default 30), besides after every change." },
        },
      },
    },
    needs: {
      type: "array",
      maxItems: 16,
      items: {
        oneOf: [
          { type: "object", required: ["member", "words", "why"], additionalProperties: false, properties: {
            member: { type: "string", pattern: "^(?:device|app):[a-z0-9][a-z0-9_-]{0,47}$" },
            words: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,63}$" } },
            why } },
          { type: "object", required: ["notify", "why"], additionalProperties: false, properties: { notify: { const: true }, why } },
          { type: "object", required: ["widgets", "why"], additionalProperties: false, properties: { widgets: { const: true }, why } },
          { type: "object", required: ["card", "why"], additionalProperties: false, properties: { card: { const: true }, why } },
        ],
      },
    },
    tools: { type: "array", description: "Informational only: the server's tools/list is what counts." },
  },
} as const;

export interface AppCard { id: string; title: string; size: typeof APP_CARD_SIZES[number]; tool: string; action?: string; refresh_min?: number }
export type AppNeed = { member: string; words: string[]; why: string } | { notify: true; why: string } | { widgets: true; why: string } | { card: true; why: string };
export interface AppManifest {
  contract: typeof APP_CONTRACT;
  id: string;
  name: string;
  version: string;
  icon?: string;
  summary: string;
  /** What the app is for and when to use it: one sentence the agent always sees. */
  role?: string;
  publisher: string;
  server: { command: string; args?: string[]; env?: Record<string, string> };
  surfaces?: { id: string; title: string; resource: string }[];
  events?: string[];
  /** Declared events that wake the main agent at once. */
  wake_events?: string[];
  needs?: AppNeed[];
  /** The folder inside the app's folder that holds its data (apps.reset empties it). */
  data_dir?: string;
  /** Home-screen cards drawn from the app's data. */
  cards?: AppCard[];
}

/** The key a need is granted and revoked by: its member id, or notify / widgets / card. */
export const needKey = (need: AppNeed): string => "member" in need ? need.member : "notify" in need ? "notify" : "widgets" in need ? "widgets" : "card";

let compiled: ReturnType<Ajv["compile"]> | null = null;
export function validateManifest(raw: unknown): { ok: true; manifest: AppManifest } | { ok: false; error: string } {
  compiled ??= new Ajv({ strict: false, allErrors: true }).compile(APP_SCHEMA);
  if (!compiled(raw)) return { ok: false, error: (compiled.errors ?? []).slice(0, 5).map((item) => `${item.instancePath || "/"} ${item.message ?? "invalid"}`).join("; ") };
  const manifest = raw as AppManifest;
  const surfaces = manifest.surfaces ?? [];
  if (new Set(surfaces.map((item) => item.id)).size !== surfaces.length) return { ok: false, error: "duplicate surface id" };
  if (manifest.data_dir !== undefined && /^\.+$/.test(manifest.data_dir)) return { ok: false, error: "data_dir is a folder name" };
  const script = manifest.server.args?.[0];
  if (manifest.data_dir !== undefined && script && script.replace(/^\.\//, "").startsWith(`${manifest.data_dir}/`)) return { ok: false, error: "data_dir holds the server" };
  const cards = manifest.cards ?? [];
  if (new Set(cards.map((item) => item.id)).size !== cards.length) return { ok: false, error: "duplicate card id" };
  const keys = (manifest.needs ?? []).map(needKey);
  if (new Set(keys).size !== keys.length) return { ok: false, error: "each member or kind of need appears once" };
  if ((manifest.needs ?? []).some((need) => "member" in need && need.member === `app:${manifest.id}`)) return { ok: false, error: "an app does not need itself" };
  const undeclared = (manifest.wake_events ?? []).find((name) => !(manifest.events ?? []).includes(name));
  if (undeclared) return { ok: false, error: `wake_events ${undeclared} is not in events` };
  return { ok: true, manifest };
}

/** Compare dotted versions numerically; a pre-release or build suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split(/[-+]/)[0]!.split(".").map((item) => Number(item) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
