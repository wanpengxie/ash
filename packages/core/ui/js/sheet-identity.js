import { ManagedFilesSheet, named } from "./editor.js";

/** Identity files are read and changed only through the authenticated self member. */
export class IdentitySheet extends ManagedFilesSheet {
  constructor(root, options) {
    const name = options?.name || "Ash";
    super(root, options, { files: ["SOUL.md", "IDENTITY.md"],
      intro: `这些决定了${named(name)}是谁、怎样和你相处。改之前想一想；改完她下一句话就会照新的来。`,
      extra: options?.extra });
  }

  async open(path = "SOUL.md") {
    if (path !== "SOUL.md" && path !== "IDENTITY.md") throw new TypeError("unknown identity file");
    return super.open(path);
  }
}
