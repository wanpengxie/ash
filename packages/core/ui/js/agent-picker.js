/** Explicit addressing: selecting one recipient never broadcasts or wakes the main agent. */
export function agentPicker(form, input, net, changed = () => {}) {
  let selected = { id: "agent:main", name: "Ash" };
  const control = document.createElement("button"); control.type = "button"; control.className = "agent-recipient"; control.textContent = "@ Ash";
  const panel = document.createElement("div"); panel.className = "agent-picker"; panel.hidden = true;
  const names = new Map([["agent:main", "Ash"]]);
  form.before(panel); form.prepend(control);
  async function open() {
    panel.hidden = false; panel.textContent = "正在读取 Agent…";
    try {
      const { agents } = await net.agentRequest("list"); panel.replaceChildren();
      for (const agent of agents) {
        names.set(agent.id, agent.name);
        const button = document.createElement("button"); button.type = "button";
        button.disabled = agent.available === false || agent.state === "stopped";
        button.textContent = `${agent.name} · ${agent.available === false ? "不可用" : agent.state === "working" ? "工作中" : agent.summary || "就绪"}`;
        button.title = button.textContent;
        button.onclick = () => { selected = agent; control.textContent = `@ ${agent.name}`; panel.hidden = true; input.value = input.value.replace(/^@\s*/, ""); input.placeholder = `跟 ${agent.name} 说点什么…`; input.focus(); };
        panel.append(button);
      }
    } catch { panel.textContent = "暂时无法读取名单，连上后重试"; }
  }
  control.onclick = () => { if (panel.hidden) void open(); else panel.hidden = true; };
  input.addEventListener("input", () => { if (input.value === "@") void open(); });
  return { target: () => selected.id, name: id => names.get(id) ?? id.replace(/^agent:/, ""),
    async refresh() { try { const { agents } = await net.agentRequest("list"); for (const agent of agents) names.set(agent.id, agent.name); changed(); } catch { /* retry on next registration */ } },
  };
}
