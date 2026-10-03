import { ManagedFilesSheet, named } from "./editor.js";

/** Memory sheet preserves USER version and both files' snapshot history. */
export class MemorySheet extends ManagedFilesSheet {
  constructor(root, options) {
    const name = options?.name || "Ash";
    super(root, options, { files: ["USER.md", "MEMORY.md"],
      intro: `${named(name, false)}记得的关于你的事，以及她自己记下的笔记。她会自己整理；记错了，你可以直接改。` });
  }

  async open(path = "USER.md") {
    if (path !== "USER.md" && path !== "MEMORY.md") throw new TypeError("unknown memory file");
    return super.open(path);
  }
}
