/**
 * The app contract `ash-app/1`: the shape of `app.json`, and how an app tool's MCP annotations become its effect and
 * risk (SPEC-02 §5.3). The runtime that starts apps compiles each tool with `appToolContract`.
 */
import { AGENT_ID_PATTERN, APP_NAME_PATTERN, SURFACE_ID_PATTERN, TOOL_NAME_PATTERN } from "./ids";
import { upstreamDoingLabel } from "./labels";
import { APP_CONTRACT } from "./versions";
import { DEFAULT_CALLERS, type Effect, type JsonSchema, type Risk, type WordContract } from "./word";

// ---------------------------------------------------------------------------------------------------------------------
// app.json
// ---------------------------------------------------------------------------------------------------------------------

export interface AppServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface AppSurface {
  id: string;
  title: string;
  /** `ui://...` */
  resource: string;
}
export interface AppCard {
  id: string;
  title: string;
  size: "2x2" | "4x2" | "4x4";
  /** A read-only tool that returns the card. */
  tool: string;
  /** The tool a tap, toggle or choice on the card calls. */
  action?: string;
  refresh_min?: number;
}
/** What the app asks the owner to allow at install time. */
export type AppNeed =
  | { member: string; words: string[]; why: string }
  | { notify: true; why: string }
  | { widgets: true; why: string }
  | { card: true; why: string }
  /** A connection or key the hub's vault keeps (its name): the app gets a working token with service:vault/token, nobody else does. */
  | { credential: string; why: string };
/** An event that wakes an agent at once. A plain name wakes the primary agent; `agent` (`agent:<name>`) names another one. */
export type AppWakeEvent = string | { event: string; agent?: string };

export interface AppJson {
  contract: typeof APP_CONTRACT;
  id: string;
  name: string;
  version: string;
  icon?: string;
  summary: string;
  role?: string;
  publisher: string;
  server: AppServer;
  surfaces?: AppSurface[];
  /** Events the app emits. */
  events?: string[];
  /** Events (each also in `events`) that wake an agent. */
  wake_events?: AppWakeEvent[];
  /** Events the app wants to hear in real time; the hub delivers each to the reserved tool `ash.on_event`. The owner approves them at install. */
  listens?: string[];
  data_dir?: string;
  cards?: AppCard[];
  needs?: AppNeed[];
}

// ---------------------------------------------------------------------------------------------------------------------
// the JSON Schema of app.json (docs/app.schema.json is generated from this; `npm run gen:app-schema`)
// ---------------------------------------------------------------------------------------------------------------------

const EVENT_NAME_PATTERN = "^[a-z][a-z0-9_-]*(?:\\.[a-z0-9_-]+)+$";
/** An event a `listens` entry names: an exact event (`sense.location`), or every event under a prefix (`sense.*`). */
export const LISTEN_PATTERN = "^[a-z][a-z0-9_-]*(?:\\.[a-z0-9_-]+)*\\.(?:[a-z0-9_-]+|\\*)$";
/** Who an app may ask to use in `needs`: a service, an agent, one hand (its 22-character id) or any (`device:*`), any agent (`agent:*`), another app. */
export const NEED_MEMBER_PATTERN = `^(?:device:(?:\\*|[A-Za-z0-9_-]{22})|service:[a-z][a-z0-9_-]{0,31}|agent:(?:\\*|[a-z][a-z0-9_-]{0,31})|app:[a-z][a-z0-9-]{0,47})$`;
const why: JsonSchema = { type: "string", minLength: 1, maxLength: 200 };
const needFlag = (flag: string): JsonSchema => ({
  type: "object", required: [flag, "why"], additionalProperties: false, properties: { [flag]: { const: true }, why },
});

/** `app.json` as JSON Schema (draft-07, as the file has always been). Keep it in step with `AppJson`; app.test.ts checks the field names. */
export const APP_SCHEMA: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://ash.invalid/schemas/ash-app-1.json",
  title: "Ash app description (ash-app/1)",
  type: "object",
  required: ["contract", "id", "name", "version", "summary", "publisher", "server"],
  additionalProperties: false,
  properties: {
    contract: { const: APP_CONTRACT },
    id: { type: "string", pattern: APP_NAME_PATTERN, description: "Unique, lower case. Third parties prefix their publisher name, e.g. example-notes." },
    name: { type: "string", minLength: 1, maxLength: 40 },
    version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$" },
    icon: { type: "string", pattern: "^[A-Za-z0-9_-][A-Za-z0-9_.-]*\\.(?:png|svg|webp)$", description: "A file next to app.json." },
    summary: { type: "string", minLength: 1, maxLength: 200 },
    role: { type: "string", minLength: 1, maxLength: 200, description: "What this organ of ash is for and when Ash should use it, in one sentence; shown to the agent in every conversation." },
    publisher: { type: "string", minLength: 1, maxLength: 80 },
    server: {
      type: "object", required: ["command"], additionalProperties: false,
      description: "The app's MCP server, started inside the container over stdio with the app's folder as working directory.",
      properties: {
        command: { type: "string", minLength: 1, maxLength: 200 },
        args: { type: "array", maxItems: 32, items: { type: "string", maxLength: 500 } },
        env: {
          type: "object", maxProperties: 32,
          propertyNames: { pattern: "^[A-Z][A-Z0-9_]{0,63}$", not: { pattern: "^ASH_" } },
          additionalProperties: { type: "string", maxLength: 2000 },
        },
      },
    },
    surfaces: {
      type: "array", maxItems: 16,
      items: {
        type: "object", required: ["id", "title", "resource"], additionalProperties: false,
        properties: {
          id: { type: "string", pattern: SURFACE_ID_PATTERN },
          title: { type: "string", minLength: 1, maxLength: 20 },
          resource: { type: "string", pattern: "^ui://[^\\s]{1,200}$" },
        },
      },
    },
    events: { type: "array", maxItems: 32, items: { type: "string", pattern: EVENT_NAME_PATTERN, not: { enum: ["app.card", "app.activity"] } } },
    wake_events: {
      type: "array", maxItems: 32,
      items: {
        oneOf: [
          { type: "string", pattern: EVENT_NAME_PATTERN },
          {
            type: "object", required: ["event"], additionalProperties: false,
            properties: {
              event: { type: "string", pattern: EVENT_NAME_PATTERN },
              agent: { type: "string", pattern: AGENT_ID_PATTERN, description: "The agent to wake, as agent:<name>; leave it out to wake the primary agent." },
            },
          },
        ],
      },
      description: "Events (each also in events) that should wake an agent at once rather than wait for the next conversation; a few a day at most. A plain name wakes the primary agent; {event, agent} wakes that agent.",
    },
    listens: {
      type: "array", maxItems: 32,
      items: { type: "string", pattern: LISTEN_PATTERN },
      description: "Events the app wants to hear in real time, such as sense.location, or sense.* for every event under a prefix. The hub delivers each to the app's reserved tool ash.on_event {word, body, from, at}; the owner approves the list at install.",
    },
    data_dir: {
      type: "string", pattern: "^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$", not: { enum: ["ui", "node_modules"] },
      description: "The folder (inside the app's folder) where the app keeps the owner's data; apps.reset empties it, apps.remove {keep_data} keeps it.",
    },
    cards: {
      type: "array", maxItems: 8,
      description: "Home-screen cards the app draws from its own data: the tool returns the card (A2UI), taps go to the action tool.",
      items: {
        type: "object", required: ["id", "title", "size", "tool"], additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,14}$" },
          title: { type: "string", minLength: 1, maxLength: 40 },
          size: { enum: ["2x2", "4x2", "4x4"] },
          tool: { type: "string", pattern: TOOL_NAME_PATTERN, description: "A read-only tool of this app that returns the card: {components, root?, data?, sizes?, theme?}." },
          action: { type: "string", pattern: TOOL_NAME_PATTERN, description: "The tool a tap, toggle or choice on the card calls: {card, action, component?, item?, checked?, value?, context?}." },
          refresh_min: { type: "integer", minimum: 5, maximum: 1440, description: "Redraw at least this often (minutes; default 30), besides after every change." },
        },
      },
    },
    needs: {
      type: "array", maxItems: 16,
      items: {
        oneOf: [
          {
            type: "object", required: ["member", "words", "why"], additionalProperties: false,
            properties: {
              member: { type: "string", pattern: NEED_MEMBER_PATTERN, description: "The member to use: a service (service:llm), an agent (agent:main, or agent:* for any agent), a hand (device:<hand_id>, or device:* for any), or another app (app:<id>)." },
              words: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", pattern: TOOL_NAME_PATTERN } },
              why,
            },
          },
          needFlag("notify"), needFlag("widgets"), needFlag("card"),
          {
            type: "object", required: ["credential", "why"], additionalProperties: false,
            properties: { credential: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$", description: "The name of a connection or key in the hub's vault (service:vault/list)." }, why },
          },
        ],
      },
    },
  },
};

/** The reserved tool the hub calls to deliver a `listens` event: `{word, body, from, at}`. */
export const ASH_ON_EVENT_TOOL = "ash.on_event";

/** Every wake event as `{event, agent?}`; no `agent` means the primary agent. */
export function wakeEvents(app: Pick<AppJson, "wake_events">): { event: string; agent?: string }[] {
  return (app.wake_events ?? []).map((item) => (typeof item === "string" ? { event: item } : { event: item.event, ...(item.agent ? { agent: item.agent } : {}) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// MCP annotations -> effect and risk
// ---------------------------------------------------------------------------------------------------------------------

/** The hints an MCP tool may carry (MCP specification, `ToolAnnotations`). */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * The first rule that matches wins. A missing hint counts as the MCP default: destructive and open-world, so a tool
 * with no annotations asks for approval. Only rules 1 and 4 make a tool safe, and the app has to say so itself.
 *   1. readOnlyHint === true               -> read / none   (other hints ignored)
 *   2. destructiveHint !== false           -> write / structure
 *   3. openWorldHint !== false             -> act / outward
 *   4. destructiveHint === false and openWorldHint === false -> write / none
 */
export function toolEffectRisk(annotations?: McpToolAnnotations | null): { effect: Effect; risk: Risk } {
  const a = annotations && typeof annotations === "object" ? annotations : {};
  if (a.readOnlyHint === true) return { effect: "read", risk: "none" };
  if (a.destructiveHint !== false) return { effect: "write", risk: "structure" };
  if (a.openWorldHint !== false) return { effect: "act", risk: "outward" };
  return { effect: "write", risk: "none" };
}

/** One tool as an app's MCP server lists it. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
}

/** The contract of one app tool (`appName` is the app's name for people, used in the label when the tool has no title). Runtime registration only checks the name and that the schema compiles. */
export function appToolContract(appId: string, tool: McpTool, appName?: string): WordContract {
  const { effect, risk } = toolEffectRisk(tool.annotations);
  const declared = tool.title ?? tool.annotations?.title;
  const title = declared ?? tool.name;
  return {
    member: `app:${appId}`,
    word: tool.name,
    kind: "request",
    direction: "in",
    description: tool.description?.trim() || title,
    input_schema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" },
    effect,
    risk,
    callers: [...DEFAULT_CALLERS],
    // Seen on approval cards and the island: the tool's own title, else the app's name; never the tool's raw name.
    label: { doing: upstreamDoingLabel({ ...(declared ? { title: declared } : {}), word: tool.name, ...(appName ? { owner: appName } : {}), ownerId: appId, noun: "功能" }) },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// system apps
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The apps that come with Ash (spec ARCH-APPS §3): their screens are native, part of the phone app; what they do is the
 * hub's words. `service:apps/apps.list` lists them with the installed apps (`kind: "system"`, `ui: "native"`), and
 * `person:owner/open {app}` opens them. `icon` names one of the shell's line icons. Add one line per system app.
 */
export interface SystemApp { id: string; name: string; summary: string; icon: string }
export const SYSTEM_APPS: readonly SystemApp[] = [
  { id: "codex", name: "Codex", summary: "电脑上的 Codex：会话、新对话和审批", icon: "laptop" },
];

/** A system app as `apps.list` shows it: always there, on, and the owner's. */
export const systemAppInfo = (a: SystemApp) => ({ id: a.id, name: a.name, summary: a.summary, icon: a.icon, kind: "system" as const, ui: "native" as const, version: "", enabled: true, granted: true, running: true });
