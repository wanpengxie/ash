import { ManagedMarkdownEditor } from "./editor.js";

/** Identity files are read and changed only through the authenticated self member. */
export class IdentitySheet {
  constructor(root, options) {
    this.root = root;
    this.options = options;
    this.active = null;
    this.editor = null;
  }

  async open(path = "SOUL.md") {
    if (path !== "SOUL.md" && path !== "IDENTITY.md") throw new TypeError("unknown identity file");
    if (this.editor?.pending || this.editor?.pendingRollback ||
      this.editor?.loaded && this.editor.draft !== this.editor.content) throw new Error("先处理未确认修改或草稿，再切换文件。");
    const panel = document.createElement("section");
    const editor = new ManagedMarkdownEditor(panel, { ...this.options, path });
    await editor.load();
    const tabs = document.createElement("nav");
    for (const name of ["SOUL.md", "IDENTITY.md"]) {
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
    this.root.replaceChildren(tabs, panel);
    this.active = path;
    this.editor = editor;
    return editor;
  }
}
