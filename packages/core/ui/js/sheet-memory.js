import { ManagedMarkdownEditor } from "./editor.js";

/** Memory sheet preserves USER version and both files' snapshot history. */
export class MemorySheet {
  constructor(root, options) {
    this.root = root;
    this.options = options;
    this.active = null;
    this.editor = null;
    this.epoch = 0;
  }

  dispose() {
    this.epoch++;
    this.editor?.dispose();
    this.editor = null;
    this.active = null;
    this.root.replaceChildren();
  }

  async open(path = "USER.md") {
    if (path !== "USER.md" && path !== "MEMORY.md") throw new TypeError("unknown memory file");
    if (this.editor?.pending || this.editor?.pendingRollback ||
      this.editor?.loaded && this.editor.draft !== this.editor.content) throw new Error("先处理未确认修改或草稿，再切换文件。");
    const epoch = ++this.epoch;
    const panel = document.createElement("section");
    const editor = new ManagedMarkdownEditor(panel, { ...this.options, path });
    await editor.load();
    if (epoch !== this.epoch) { editor.dispose(); throw new Error("页面身份已变化，读取结果已丢弃。"); }
    const tabs = document.createElement("nav");
    for (const name of ["USER.md", "MEMORY.md"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = name;
      button.disabled = name === path;
      button.addEventListener("click", async () => {
        try { await this.open(name); }
        catch (error) { editor.status = error instanceof Error ? error.message : "切换失败"; editor.render(); }
      });
      tabs.append(button);
    }
    this.editor?.dispose();
    this.root.replaceChildren(tabs, panel);
    this.active = path;
    this.editor = editor;
    return editor;
  }
}
