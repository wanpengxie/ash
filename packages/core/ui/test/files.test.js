import assert from "node:assert/strict";
import test from "node:test";
import { resolveFileLink, fileContentUrl } from "../js/files.js";

const roots = [{ id: "home", directory: "/root/work" }, { id: "agent_writer", directory: "/root/agents/writer" }];
test("Markdown links and the file list use the same workspace/path, including helper files and relative references", () => {
  assert.deepEqual(resolveFileLink("/root/work/报告%20一.md", roots), { workspace: "home", path: "报告 一.md" });
  assert.deepEqual(resolveFileLink("/root/agents/writer/page.html", roots), { workspace: "agent_writer", path: "page.html" });
  assert.deepEqual(resolveFileLink("../guide.md", roots, { workspace: "home", path: "docs/chapter/a.md" }), { workspace: "home", path: "docs/guide.md" });
  assert.deepEqual(resolveFileLink("./report.html#result", roots), { workspace: "home", path: "report.html" });
  assert.equal(fileContentUrl({ workspace: "home", path: "报告 一/page.html" }), "/api/workspaces/home/content/%E6%8A%A5%E5%91%8A%20%E4%B8%80/page.html");
  assert.ok(fileContentUrl({ workspace: "home", path: "page.html" }, true).startsWith("https://ash-files.invalid/"));
});
test("file links never widen filesystem roots or become arbitrary URL/native API requests", () => {
  for (const path of ["/root/work-other/secret", "/etc/passwd", "../../private", "/root/work/../secret", "file:///etc/passwd", "javascript:alert(1)", "https://example.com/x", "//host/a", "%00.md", "a\\b", "#local", "%GG"])
    assert.equal(resolveFileLink(path, roots), null, path);
});
