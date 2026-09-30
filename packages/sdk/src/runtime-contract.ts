/** Selected runtime integration contract; implementation remains in the binding and router. */
export const RUNTIME_CONTRACT_V2 = {
  publicMember: "agent:main",
  sessions: { main: "separate-agent-instance", secondary: "separate-agent-instance" },
  tools: ["ash_describe", "ash_send", "ash_say", "ash_react", "ash_show"],
  workerInvocation: { method: "llm.stream", session: false, tools: [] },
  cancellation: { settlePendingImmediately: true, discardLateResults: true, normalizeTurnEnd: "cancelled" },
  managedFileWrites: { nativeWrite: "deny-and-direct-to-self", resultHook: "observe-only" },
} as const;
