/** The local context chip is a draft hint, not a control message or a new route. */
export function composerContext(root, input) {
  const clear = () => { root.replaceChildren(); root.hidden = true; };
  const askAbout = ({ turn, text }) => {
    input.value = text;
    clear();
    root.hidden = false;
    const chip = document.createElement("div");
    chip.className = "context-chip";
    chip.dataset.turn = turn;
    chip.textContent = "关于这件事";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "context-remove";
    remove.textContent = "移除";
    remove.addEventListener("click", clear);
    chip.append(remove);
    root.append(chip);
    input.focus();
  };
  return { clear, askAbout };
}
