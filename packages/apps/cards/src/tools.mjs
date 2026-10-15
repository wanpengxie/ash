// The five tools and the one screen of 卡片, as MCP shapes. Each tool is one word of the hub's service:cards (docs/CARD-RUNTIME.md §4),
// called through the app's way back into Ash (capability_call); cards.list adds each card's app name from service:apps/apps.list.
export const UI_MIME = "text/html;profile=mcp-app";
const CARDS = "service:cards";
const id = { type: "string", minLength: 1, description: "The card's id (from cards.list)." };
const byId = { type: "object", properties: { id }, required: ["id"], additionalProperties: false };
const change = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const TOOLS = [
  { name: "cards.list", title: "看运行中的卡片", description: "The cards in the conversation that are not closed: summary text, whose app (app_name), state (active, idle, dormant), pinned, live sources, last seen and used; and the limits.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: "ui://cards/home" } } },
  { name: "cards.sleep", title: "让卡片休眠", description: "Put a card to sleep now: its live data stops and is kept as it is. Seeing or using it wakes it.",
    inputSchema: byId, annotations: change },
  { name: "cards.wake", title: "唤醒卡片", description: "Wake a sleeping card: its app is started, its live data runs again and it is drawn fresh.",
    inputSchema: byId, annotations: change },
  { name: "cards.close", title: "收起卡片", description: "Close a card: a static picture of it stays in the conversation; its live data and buttons stop.",
    inputSchema: byId, annotations: change },
  { name: "cards.pin", title: "固定卡片", description: "Pin a card (pinned true) so it never sleeps and keeps its live data running off screen; pinned false lets it sleep again.",
    inputSchema: { type: "object", properties: { id, pinned: { type: "boolean" } }, required: ["id", "pinned"], additionalProperties: false }, annotations: change },
];

export const RESOURCES = [{ uri: "ui://cards/home", name: "运行中的卡片", mimeType: UI_MIME }];

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const failed = (message) => ({ content: [{ type: "text", text: message }], isError: true });
/** A word's answer through capability_call is `{content, data}`: the data (or the JSON text when there is no data). */
export function dataOf(result) {
  if (result && typeof result === "object" && result.data && typeof result.data === "object") return result.data;
  const text = Array.isArray(result?.content) ? result.content.find((item) => item?.type === "text")?.text : undefined;
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}
const word = async (ash, name, body) => dataOf(await ash.call(CARDS, name, body));
const need = (value) => { if (typeof value !== "string" || !value) throw new Error("要说是哪张卡片"); return value; };

/** service:cards/list, each card with its app's name (when the app list can be read; otherwise without). */
export async function listCards(ash) {
  const [listed, apps] = await Promise.all([word(ash, "list", {}), ash.call("service:apps", "apps.list", {}).then(dataOf, () => ({}))]);
  const names = new Map((Array.isArray(apps.apps) ? apps.apps : []).map((app) => [app.id, app.name]));
  const cards = (Array.isArray(listed.cards) ? listed.cards : []).map((card) => ({ ...card, ...(card.app && names.has(card.app) ? { app_name: names.get(card.app) } : {}) }));
  return { cards, limits: listed.limits ?? {} };
}

/** ash: the app's client (ash.mjs), or a fake with the same call(member, word, body). */
export async function callTool(ash, name, args) {
  try {
    switch (name) {
      case "cards.list": return ok(await listCards(ash));
      case "cards.sleep": return ok(await word(ash, "sleep", { id: need(args.id) }));
      case "cards.wake": return ok(await word(ash, "wake", { id: need(args.id) }));
      case "cards.close": return ok(await word(ash, "close", { id: need(args.id) }));
      case "cards.pin": return ok(await word(ash, "pin", { id: need(args.id), pinned: args.pinned === true }));
      default: return failed(`unknown tool ${name}`);
    }
  } catch (error) { return failed(error?.ownerText ?? (error instanceof Error ? error.message : String(error))); }
}

/** pages: { home } — the whole page, made by tools/gen-cards-ui.mjs; self-contained, no network. */
export function readResource(uri, pages) {
  if (uri !== "ui://cards/home") throw new Error(`unknown resource ${uri}`);
  return { contents: [{ uri, mimeType: UI_MIME, text: pages.home, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } } }] };
}
