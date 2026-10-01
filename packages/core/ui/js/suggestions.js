const labels = Object.freeze({ activity: "活动", upcoming: "接下来", approvals: "审批", identity: "身份", memory: "记忆", settings: "设置", turn: "当前任务" });

export async function presentUiOpen(root, request, { open, respond }) {
  const target = request?.body_summary?.target ?? request?.body?.target;
  const mode = request?.body_summary?.mode ?? request?.body?.mode;
  if (!Object.hasOwn(labels, target) || !["perform", "suggest"].includes(mode)) return false;
  if (mode === "perform") { const opened = await open(target, request); await respond(request, opened); return true; }
  const chip = document.createElement("div");
  chip.className = "suggestion";
  const label = document.createElement("span");
  label.textContent = `Ash 建议查看${labels[target]}`;
  const show = document.createElement("button");
  show.type = "button";
  show.textContent = "打开";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  show.addEventListener("click", () => { chip.remove(); void open(target, request); });
  close.addEventListener("click", () => chip.remove());
  chip.append(label, show, close);
  root.replaceChildren(chip);
  // F-S29: acknowledgement describes this request, not a future local click.
  await respond(request, false);
  return true;
}
