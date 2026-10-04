import type { Message, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
export { PostMember, LedgerUiPresenter, isQuiet, quietEnd } from "./post-delivery";
export type { HostPresenter, UiPresenter, PostOptions, ScreenPresence } from "./post-delivery";

const visible = wordContract("service:post", "visible");
const hidden = wordContract("service:post", "hidden");
if (!visible || !hidden) throw new Error("post presence contracts unavailable");

/** Real foreground heartbeat intake; delivery words are added only by ASH-302. */
export class PostPresenceMember implements Member {
  readonly id = "service:post";
  readonly kind = "service" as const;
  readonly name = "Delivery presence";
  readonly online = true;
  constructor(private readonly markVisible: (screen: string) => void, private readonly markHidden: (screen: string) => void = () => {}) {}
  words(): readonly WordSpec[] { return [visible!, hidden!]; }
  handle(message: Message): void {
    if (message.kind !== "event" || message.to !== this.id || !message.from.startsWith("screen:")) return;
    if (message.word === "visible") this.markVisible(message.from);
    else if (message.word === "hidden") this.markHidden(message.from);
  }
}
