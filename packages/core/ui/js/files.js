import { appendMarkdown } from "./markdown.js";
import { readWorkspaceFile } from "./ui-transport.js";
import { workspaceFileUrl } from "./cards.js";

/** Resolve an ordinary Markdown path against the known Ubuntu workspaces, not the web app's URL. */
export function resolveFileLink(href, roots, base = { workspace: "home", path: "" }) {
  if (typeof href !== "string" || /[\\\x00-\x1f\x7f]/.test(href) || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return null;
  let path;
  try { path = decodeURIComponent(href.split("#")[0]); } catch { return null; }
  let workspace = base.workspace;
  if (path.startsWith("/")) {
    const root = [...roots].sort((a, b) => b.directory.length - a.directory.length)
      .find((root) => path.startsWith(root.directory.replace(/\/$/, "") + "/"));
    if (!root) return null;
    workspace = root.id; path = path.slice(root.directory.replace(/\/$/, "").length + 1);
  } else path = `${base.path.includes("/") ? base.path.slice(0, base.path.lastIndexOf("/") + 1) : ""}${path}`;
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  const ref = { workspace, path: parts.join("/") };
  return workspaceFileUrl(ref) ? ref : null;
}

export function fileContentUrl(ref, embedded = false) {
  if (!workspaceFileUrl(ref)) throw new Error("文件路径无效");
  return `${embedded ? "https://ash-files.invalid" : ""}/api/workspaces/${ref.workspace}/content/${ref.path.split("/").map(encodeURIComponent).join("/")}`;
}
const add = (parent, tag, text, cls) => {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls; parent.append(el); return el;
};

/** The file list and conversation links share this one viewer and the same live filesystem reads. */
export class Files {
  constructor(transport, { save = null, embedded = false } = {}) {
    this.transport = transport; this.save = save; this.embedded = embedded; this.generation = 0;
    this.root = add(document.body, "dialog", undefined, "files-view");
    this.root.setAttribute("aria-label", "文件");
    this.root.addEventListener("close", () => { this.generation++; this.release(); this.body?.replaceChildren(); });
  }
  release() { if (this.objectUrl) URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
  shell(title) {
    this.release(); this.root.replaceChildren(); this.generation++;
    const bar = add(this.root, "div", undefined, "files-bar");
    const close = add(bar, "button", "关闭", "btn gray"); close.type = "button"; close.onclick = () => this.root.close();
    add(bar, "strong", title);
    this.actions = add(bar, "div", undefined, "files-actions");
    this.note = add(this.root, "div", "", "files-note"); this.note.setAttribute("role", "status");
    this.body = add(this.root, "div", undefined, "files-body");
    if (!this.root.open) this.root.showModal();
    return this.generation;
  }
  async roots() {
    const response = await this.transport.request("/api/workspaces", { method: "GET" });
    if (!response.ok) throw new Error("无法读取文件目录");
    return response.json();
  }
  async browse(workspace = null, path = "") {
    const generation = this.shell(path || "文件");
    this.note.textContent = "正在读取…";
    try {
      const roots = await this.roots();
      if (generation !== this.generation) return;
      if (!workspace) workspace = roots.find((r) => r.id === "home")?.id ?? roots[0]?.id;
      if (!workspace) { this.note.textContent = "暂无工作区"; return; }
      const select = add(this.actions, "select"); select.setAttribute("aria-label", "工作区");
      for (const root of roots) { const option = add(select, "option", root.directory); option.value = root.id; }
      select.value = workspace; select.onchange = () => this.browse(select.value);
      const refresh = add(this.actions, "button", "刷新", "btn gray"); refresh.onclick = () => this.browse(workspace, path);
      if (path) { const back = add(this.body, "button", "← 上一级", "files-row"); back.onclick = () => this.browse(workspace, path.split("/").slice(0, -1).join("/")); }
      const response = await this.transport.request(`/api/workspaces/${workspace}/files?path=${encodeURIComponent(path)}`, { method: "GET" });
      if (!response.ok) throw new Error(response.status === 404 ? "目录不存在" : "目录无法读取");
      const entries = await response.json();
      if (generation !== this.generation) return;
      this.note.textContent = roots.find(r => r.id === workspace)?.directory + (path ? `/${path}` : "");
      if (!entries.length) add(this.body, "p", "此目录为空", "muted");
      for (const file of entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path))) {
        const row = add(this.body, "button", undefined, "files-row"); row.type = "button";
        add(row, "span", `${file.dir ? "▸ " : ""}${file.path.split("/").pop()}`);
        if (!file.dir) add(row, "small", `${Math.ceil(file.size / 1024)} KB`);
        row.onclick = () => file.dir ? this.browse(workspace, file.path) : this.open({ workspace, path: file.path });
      }
    } catch (error) { if (generation === this.generation) this.note.textContent = error.message || "文件无法读取"; }
  }
  async openLink(href, base) {
    try {
      const ref = resolveFileLink(href, await this.roots(), base);
      if (!ref) throw new Error("这个路径不在可读取的工作区内");
      await this.open(ref);
    } catch (error) { this.shell("打开文件"); this.note.textContent = error.message || "文件无法读取"; }
  }
  async open(ref) {
    const generation = this.shell(ref.name || ref.path.split("/").pop());
    this.note.textContent = ref.path;
    const directory = ref.path.split("/").slice(0, -1).join("/");
    const folder = add(this.actions, "button", "所在文件夹", "btn gray"); folder.onclick = () => this.browse(ref.workspace, directory);
    const download = add(this.actions, "button", "下载", "btn gray");
    download.onclick = async () => {
      download.disabled = true;
      try {
        if (this.save) {
          const result = await this.save(ref);
          if (!result.ok && !result.cancelled) throw new Error("保存失败");
          if (generation === this.generation) this.note.textContent = result.cancelled ? "已取消保存" : "文件已保存";
        } else {
          const blob = await readWorkspaceFile(this.transport, ref);
          const url = URL.createObjectURL(blob), link = document.createElement("a");
          link.href = url; link.download = ref.path.split("/").pop(); link.click();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
      } catch (error) { if (generation === this.generation) this.note.textContent = error.message || "下载失败"; }
      finally { download.disabled = false; }
    };
    try {
      if (!workspaceFileUrl(ref)) throw new Error("文件路径无效");
      const ext = ref.path.split(".").pop().toLowerCase();
      // Stat via the same directory API before embedding; missing HTML must not look like an empty successful reader.
      const listing = await this.transport.request(`/api/workspaces/${ref.workspace}/files?path=${encodeURIComponent(directory)}`, { method: "GET" });
      if (!listing.ok) throw new Error("文件目录无法读取");
      const file = (await listing.json()).find((item) => item.path === ref.path && !item.dir);
      if (!file) throw new Error("文件不存在或已被移动");
      if (file.size > 20 * 1024 * 1024) throw new Error("文件超过当前 20 MiB 阅读限制，仍可尝试下载");
      if (generation !== this.generation) return;
      if (["html", "htm"].includes(ext)) {
        this.note.textContent = `${ref.path} · HTML 阅读模式（不运行脚本）`;
        const frame = add(this.body, "iframe", undefined, "files-html");
        // Keep same-site file credentials for relative CSS/images; NEVER allow scripts alongside this.
        frame.title = ref.path.split("/").pop(); frame.setAttribute("sandbox", "allow-same-origin"); frame.referrerPolicy = "no-referrer";
        frame.src = fileContentUrl(ref, this.embedded);
        return;
      }
      if (!["md", "markdown", "txt", "json", "csv", "log", "js", "ts", "css", "py", "yaml", "yml", "xml", "png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
        add(this.body, "p", "这种格式暂未接入内置阅读器，请下载后打开。", "muted"); return;
      }
      const blob = await readWorkspaceFile(this.transport, ref);
      if (generation !== this.generation) return;
      if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
        this.objectUrl = URL.createObjectURL(blob);
        const img = add(this.body, "img", undefined, "files-image"); img.alt = ref.path; img.src = this.objectUrl;
      } else {
        const source = await blob.text();
        if (generation !== this.generation) return;
        if (["md", "markdown"].includes(ext)) appendMarkdown(this.body, source, { onFileLink: (href) => this.openLink(href, ref) });
        else add(this.body, "pre", source, "files-text");
      }
    } catch (error) { if (generation === this.generation) this.note.textContent = error.message || "文件无法打开"; }
  }
}
