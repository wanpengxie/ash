import { createSelfScreenSender } from "./editor.js";

const DEFAULT_NAME = "Ash";

/** The display name is one field of the managed identity file, not a status guess. */
export function nameFromIdentity(content) {
  if (typeof content !== "string") return null;
  const lines = content.split(/\r?\n/);
  const names = lines.filter((line) => /^\s*[-*]\s*(?:名字|Name)\s*[：:]/iu.test(line));
  if (names.length !== 1) return null;
  const match = /^\s*[-*]\s*(?:名字|Name)\s*[：:]\s*(.*?)\s*$/iu.exec(names[0]);
  const name = match?.[1]?.split(/[（(]/u, 1)[0].trim();
  if (!name || [...name].length > 32 || /[\u0000-\u001f\u007f<>]/u.test(name)) return null;
  return name;
}

export class IdentityName {
  constructor(net, onName) {
    this.net = net;
    this.onName = onName;
    this.epoch = 0;
    this.name = DEFAULT_NAME;
    this.onName(this.name);
  }

  reset() {
    this.epoch++;
    this.name = DEFAULT_NAME;
    this.onName(this.name);
  }

  async refresh() {
    const epoch = ++this.epoch;
    const { token, screen, currentScope: scope, generation } = this.net;
    this.name = DEFAULT_NAME;
    this.onName(this.name);
    if (!token || !screen || !scope) return;
    try {
      const accepted = await createSelfScreenSender(this.net)({ to: "service:self", kind: "request", word: "read",
        body: { path: "IDENTITY.md" }, wait: true });
      if (epoch !== this.epoch || token !== this.net.token || screen !== this.net.screen ||
        scope !== this.net.currentScope || generation !== this.net.generation) return;
      const body = accepted.reply.body;
      if (body?.ok !== true || typeof body.result?.content !== "string") return;
      this.name = nameFromIdentity(body.result.content) || DEFAULT_NAME;
      this.onName(this.name);
    } catch { /* A missing or unavailable identity never preserves a prior account's name. */ }
  }

  changed(message, historical = false) {
    if (historical || message?.kind !== "event" || message.from !== "service:self" ||
      message.word !== "self.changed" || (message.body_summary || message.body)?.path !== "IDENTITY.md") return;
    void this.refresh();
  }
}
