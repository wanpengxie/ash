const expected = ["ash_describe", "ash_send", "ash_say", "ash_react", "ash_show"];

/** Compare model-facing tool lists captured with the same fake device offline and online. */
export function auditToolSurface(offline: readonly string[], online: readonly string[], deviceAliases: readonly string[]): string[] {
  const errors: string[] = [];
  const expectedSet = new Set(expected);
  if (!offline.length || !online.length) errors.push("model-facing tool capture is empty");
  if (!deviceAliases.length) errors.push("no fake device aliases supplied");
  for (const [state, names] of [["offline", offline], ["online", online]] as const) {
    const ash = names.filter(name => name.startsWith("ash_"));
    if (new Set(names).size !== names.length) errors.push(`${state} tool list has duplicate names`);
    const missing = expected.filter(name => !ash.includes(name));
    const extra = ash.filter(name => !expectedSet.has(name));
    if (missing.length || extra.length || ash.length !== expected.length) errors.push(`${state} ash tool set differs from the five-tool contract`);
    for (const alias of deviceAliases) if (names.includes(alias)) errors.push(`${state} projects device tool ${alias}`);
  }
  const offlineSet = new Set(offline.filter(name => name.startsWith("ash_")));
  const onlineSet = new Set(online.filter(name => name.startsWith("ash_")));
  if (offlineSet.size !== onlineSet.size || [...offlineSet].some(name => !onlineSet.has(name))) errors.push("ash tool set changes with device availability");
  return errors;
}
