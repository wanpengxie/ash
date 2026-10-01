import { createHash } from "node:crypto";
import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import type { Member } from "../world/member";
import { WorldRouter, type TrustedRouteContext } from "../world/router";

const service: TrustedRouteContext = { member: "service:senses", transport: "service", transportPrincipal: "service:senses",
  local: true, remote: false, ownerProxy: false };

export interface SensesOptions {
  router: WorldRouter;
  heartbeat: () => Promise<string | null>;
  isPaused: () => boolean;
  opener: (slot: string) => void;
  proactive: (slot: string) => void;
}

/** Phone facts are already validated and recorded by the router. This member only applies wake rules. */
export class SensesMember implements Member {
  readonly id = "service:senses";
  readonly kind = "service" as const;
  readonly name = "Phone senses";
  readonly online = true;
  private readonly stop: () => void;

  constructor(private readonly options: SensesOptions) {
    this.stop = options.router.subscribe((message) => {
      if (message.from !== "device:phone" || message.to !== null || message.kind !== "event") return;
      if (this.options.isPaused()) return;
      const slot = createHash("sha256").update(message.id).digest("hex").slice(0, 32);
      if (message.word === "sense.screen" && message.body.state === "app_open" && Number(message.body.away_ms) >= 6 * 3_600_000)
        this.options.opener(`screen:${slot}`);
      if (message.word === "sense.calendar") {
        this.options.proactive(`calendar:${slot}`);
        if (message.body.kind === "upcoming") void this.calendarReminder(message).catch(() => {});
      }
    });
  }

  words(): readonly WordSpec[] { return []; }
  handle(): ResponseBody { return { ok: false, error: { code: "not_found", message: "senses do not accept direct calls" } }; }

  private async calendarReminder(message: Message): Promise<void> {
    const event = message.body.event as { title?: unknown; important?: unknown } | undefined;
    if (!event) return;
    const heartbeat = await this.options.heartbeat();
    if (this.options.isPaused()) return;
    const title = String(event.title ?? "").trim();
    const relevant = event.important === true || Boolean(title && heartbeat?.split("\n")
      .some((line) => line.trim() && !line.trim().startsWith("#") && line.includes(title)));
    if (!relevant) return;
    await this.options.router.send(service, { to: "agent:main", kind: "request", word: "wake",
      body: { reason: "calendar_reminder", context: { event } }, client_id: `sense:${message.id}`, wait: true });
  }

  close(): void { this.stop(); }
}
