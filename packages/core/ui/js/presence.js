const FACE = Object.freeze({
  idle: "default", resting: "resting", listening: "listening", thinking: "thinking",
  working: "focused", done: "success", waiting_you: "listening",
});

const DEFAULT_TEXT = Object.freeze({
  idle: "在线", resting: "休息中", listening: "在听", thinking: "在想",
  working: "在忙", done: "", waiting_you: "等你一句话",
});

export function faceForStatus(state) { return Object.hasOwn(FACE, state) ? FACE[state] : null; }

/** The state and avatar come only from the projected agent status event. Connectivity is separate. */
export class PresenceBar {
  constructor(root = document, { onOpen } = {}) {
    this.bar = root.querySelector("#presence");
    this.state = root.querySelector("#state");
    this.avatar = root.querySelector("#face img");
    this.dot = root.querySelector("#dot");
    this.connection = root.querySelector("#connection");
    this.notice = root.querySelector("#presenceNotice");
    this.bar.addEventListener("click", () => {
      if (typeof onOpen === "function") onOpen();
      else this.notice.textContent = "人物页尚未接入";
    });
  }

  render(presence) {
    const face = faceForStatus(presence?.state);
    if (!face) {
      this.bar.dataset.state = "unknown";
      this.state.textContent = "状态待同步";
      this.state.title = "";
      this.avatar.src = "/avatars/default.webp";
      this.dot.className = "";
      return;
    }
    const value = typeof presence.text === "string" && presence.text ? presence.text : DEFAULT_TEXT[presence.state];
    this.bar.dataset.state = presence.state;
    this.state.textContent = value;
    this.state.title = value;
    this.avatar.src = `/avatars/${face}.webp`;
    this.dot.className = ["listening", "thinking", "working", "waiting_you"].includes(presence.state) ? "running" :
      ["idle", "done"].includes(presence.state) ? "idle" : "";
  }

  network(status, detail = "") {
    this.connection.dataset.transport = status;
    this.connection.textContent = detail || (status === "online" ? "已连接" : status === "connecting" ? "连接中…" : status === "send-error" ? "消息未送达，等待重试" : "离线，正在重连…");
  }
}
