import { getModel, type Api, type Model } from "@mariozechner/pi-ai";

/** DeepSeek's current Flash model (V4.1-Flash): reads images as well as text. Ash's default wherever no model is chosen. */
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";

/** pi-ai files DeepSeek's own API under "deepseek"; ash's agent profile calls the same route "deepseek-official". */
export const catalogProvider = (provider: string) => provider === "deepseek-official" ? "deepseek" : provider;

/**
 * DeepSeek models newer than pi-ai's bundled catalog, on the same OpenAI-compatible endpoint with the same request
 * rules as the catalog's DeepSeek entries. Rates are the Flash rates (USD per million tokens).
 */
const DEEPSEEK_ADDED: Record<string, Model<"openai-completions">> = {
  "deepseek-flash": {
    id: "deepseek-flash", name: "DeepSeek V4.1 Flash", api: "openai-completions", provider: "deepseek", baseUrl: "https://api.deepseek.com",
    compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
    reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
    input: ["text", "image"], cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    contextWindow: 1_000_000, maxTokens: 384_000,
  },
};

/** The pi-ai model for a provider and model id: the bundled catalog first, then DeepSeek models it does not list yet. */
export function resolveModel(provider: string, id: string): Model<Api> | undefined {
  const catalog = catalogProvider(provider);
  const known = getModel(catalog as "deepseek", id as "deepseek-v4-flash") as Model<Api> | undefined;
  if (known) return known;
  const added = catalog === "deepseek" && Object.hasOwn(DEEPSEEK_ADDED, id) ? DEEPSEEK_ADDED[id] : undefined;
  return added ? structuredClone(added) as Model<Api> : undefined;
}
