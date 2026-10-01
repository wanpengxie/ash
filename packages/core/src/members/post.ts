import type { Message, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
export { PostMember, LedgerUiPresenter, isQuiet, quietEnd } from "./post-delivery";
export type { HostPresenter, UiPresenter, PostOptions, ScreenPresence } from "./post-delivery";

const visible = wordContract("service:post", "visible");
if (!visible) throw new Error("post visible contract unavailable");

/** Real foreground heartbeat intake; delivery words are added only by ASH-302. */
export class PostPresenceMember implements Member {
  readonly id = "service:post";
  readonly kind = "service" as const;
  readonly name = "Delivery presence";
  readonly online = true;
  constructor(private readonly markVisible: (screen: string) => void) {}
  words(): readonly WordSpec[] { return [visible!]; }
  handle(message: Message): void {
    if (message.kind === "event" && message.to === this.id && message.word === "visible" && message.from.startsWith("screen:"))
      this.markVisible(message.from);
  }
}
