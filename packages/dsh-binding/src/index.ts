// @ash/dsh-binding — how ash hosts DeepSeek Harness. ash core itself knows nothing about DSH;
// it drives agents through the AgentRuntime contract (packages/core/src/runtime.ts) and this
// package implements that contract with DSH's core, in-process.

export { DshHost, type DshHostOptions, userMessage } from "./host";
export { DshRuntime, DSH_CAPABILITIES, originLine } from "./runtime";
export { dshSettings } from "./settings";
export { dshPlugins, type PluginOps } from "./plugins";
export { dshWorkerModel } from "./workers";
