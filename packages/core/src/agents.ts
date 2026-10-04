import { AGENT_ID } from "../../sdk/src/words";

/**
 * One agent in ash's world. agent:main is the assistant the owner talks with; every other agent is declared here or in
 * the config, and gets its own inbox and turns, its own session in the container, its own tool credential and workspace.
 */
export interface AgentDeclaration {
  id: string;
  name: string;
  /** What the other agents are told it does (agent_list). */
  summary: string;
  /** Its own job description, given to it with every turn. The main agent's comes from its persona and ash's rules. */
  brief?: string;
  /** The fixed ash tools it may use; absent means all of them. */
  tools?: readonly string[];
  /** The ash words it may reach through the meta tools, as "member/word" with * wildcards; absent means all. */
  words?: readonly string[];
  /** Seconds between scheduled wakes; absent means it only wakes when spoken to. */
  every?: number;
  enabled?: boolean;
  /** May create, change, start, stop and remove agents. Only the owner grants it; the main agent has it. */
  manage?: boolean;
}

export const MAIN_AGENT: AgentDeclaration = {
  id: "agent:main", name: "Ash",
  summary: "The assistant the owner talks with. The only agent that speaks to the owner; tell it what the owner should hear.",
  manage: true,
};

export const KEEPER_AGENT: AgentDeclaration = {
  id: "agent:keeper", name: "整理者",
  summary: "Keeps ash's records about the owner (MEMORY.md, USER.md, logs) accurate and tidy in the background. Ask it what is recorded, or tell it something worth keeping.",
  brief: [
    "你是 Ash 的后台整理者（agent:keeper）。主人不直接跟你说话；你在后台把 Ash 关于主人的记录整理得准确、精炼、好用。",
    "每次被定时唤醒时：",
    "1. 用 history_query 看最近的对话，重点是上次整理之后的部分。",
    "2. 用 capability_call 调 service:self 的 read，读 MEMORY.md 和 USER.md（需要时也读 memory/ 下的日志）。",
    "3. 合并重复的条目，改正过时或互相矛盾的条目，补上对话里出现过、但还没记下的长期事实。只记有依据的内容，不猜。",
    "4. 用 service:self 的 apply_plan（带 expected_hash）或 append 修改，每处修改写清原因。hash 变了就重新读一遍再改。",
    "5. 发现主人应该知道、或需要主人决定的事，用 agent_tell 告诉 agent:main，并说明依据；由它决定要不要、怎么跟主人说。你不能直接对主人说话。",
    "6. 没什么要改的就什么都不做，也不用汇报。",
    "别的 Agent 问你问题或告诉你事情时，用正文直接回答；要记下的就照上面的方法记。",
  ].join("\n"),
  tools: ["system_status", "timer_set", "timer_list", "timer_cancel", "history_query", "agent_list", "agent_describe", "agent_ask", "agent_tell",
    "capability_list", "capability_describe", "capability_call", "await_result", "list_pending", "cancel"],
  words: ["service:self/*", "service:clock/*"],
  every: 6 * 3600,
};

export interface ConfiguredAgent {
  id: string;
  name?: string;
  runtime?: string;
  summary?: string;
  brief?: string;
  tools?: string[];
  words?: string[];
  every?: number;
  enabled?: boolean;
  manage?: boolean;
}

/** The built-in agents: they can be changed and stopped, never removed. */
export const BUILT_IN_IDS = new Set(["agent:main", "agent:keeper"]);
const BUILT_IN = [MAIN_AGENT, KEEPER_AGENT];

/** The agents of this world: the configured ones over the built-in defaults; the keeper is on unless switched off. */
export function resolveAgents(configured: readonly ConfiguredAgent[] | undefined, withDefaults: boolean): AgentDeclaration[] {
  const out = new Map<string, AgentDeclaration>();
  for (const base of withDefaults ? BUILT_IN : [MAIN_AGENT]) out.set(base.id, { ...base });
  for (const item of configured ?? []) {
    if (!item || typeof item.id !== "string" || !AGENT_ID.test(item.id)) throw new Error(`invalid agent id: ${String(item?.id)}`);
    const base = out.get(item.id) ?? { id: item.id, name: item.id.slice(6), summary: "" };
    out.set(item.id, { ...base, ...(item.name ? { name: item.name } : {}), ...(item.summary ? { summary: item.summary } : {}),
      ...(item.brief ? { brief: item.brief } : {}), ...(item.tools ? { tools: item.tools } : {}), ...(item.words ? { words: item.words } : {}),
      ...(typeof item.every === "number" ? { every: item.every } : {}), ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
      ...(typeof item.manage === "boolean" ? { manage: item.manage } : {}) });
  }
  const agents = [...out.values()];
  if (!agents.some((agent) => agent.id === "agent:main")) throw new Error("the main agent is required");
  for (const agent of agents) if (agent.every !== undefined && (!Number.isSafeInteger(agent.every) || agent.every < 600)) throw new Error(`${agent.id}: every must be at least 600 seconds`);
  return agents;
}

/** Whether a declaration lets its agent reach member/word through the meta tools. */
export function wordAllowed(agent: Pick<AgentDeclaration, "words">, member: string, word: string): boolean {
  if (!agent.words) return true;
  const target = `${member}/${word}`;
  return agent.words.some((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(target));
}

/** The short name used for an agent's session and workspace: agent:keeper → keeper. */
export const agentName = (id: string) => id.slice("agent:".length);
