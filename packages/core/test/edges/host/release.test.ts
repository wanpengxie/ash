import assert from "node:assert/strict";
import test from "node:test";
import { WordError } from "../../../../sdk/src/message";
import { parseSums, phoneRelease } from "../../../src/edges/host/release";

const A = "a".repeat(64), K = "b".repeat(64);
const SUMS = `${A}  app-0.4.49.apk\n${K}  kernel-0.4.49.apk\n`;

/** A fake GitHub: answers by address and records the headers each request carried. */
function github(routes: Record<string, { status: number; body?: string; location?: string }>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const r = routes[url] ?? { status: 404 };
    return new Response(r.body ?? null, { status: r.status, headers: r.location ? { location: r.location } : {} });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

test("SHA256SUMS is read as sha256sum writes it", () => {
  assert.deepEqual([...parseSums(`${A}  app-1.0.0.apk\n${K} *kernel-1.0.0.apk\nnot a line\n`)], [["app-1.0.0.apk", A], ["kernel-1.0.0.apk", K]]);
});

test("a public release: the download pages, the version named by the packages when the latest is asked", async () => {
  const gh = github({ "https://github.com/o/r/releases/latest/download/SHA256SUMS": { status: 200, body: SUMS } });
  const release = await phoneRelease({ repo: "o/r", token: null, fetch: gh.fetch });
  assert.deepEqual(release, { version: "0.4.49", packages: [
    { package: "ai.ash.agent", url: "https://github.com/o/r/releases/latest/download/app-0.4.49.apk", sha256: A },
    { package: "ai.ash.kernel", url: "https://github.com/o/r/releases/latest/download/kernel-0.4.49.apk", sha256: K },
  ] });
  assert.ok(gh.seen.every((s) => !s.headers.authorization));
});

test("a private release: the API with the token, which does not follow the redirect to storage", async () => {
  const gh = github({
    "https://api.github.com/repos/o/r/releases/tags/v0.4.49": { status: 200, body: JSON.stringify({ tag_name: "v0.4.49", assets: [
      { name: "SHA256SUMS", url: "https://api.github.com/repos/o/r/releases/assets/1" },
      { name: "app-0.4.49.apk", url: "https://api.github.com/repos/o/r/releases/assets/2" },
      { name: "kernel-0.4.49.apk", url: "https://api.github.com/repos/o/r/releases/assets/3" },
    ] }) },
    "https://api.github.com/repos/o/r/releases/assets/1": { status: 302, location: "https://objects.githubusercontent.com/sums?sig=x" },
    "https://objects.githubusercontent.com/sums?sig=x": { status: 200, body: SUMS },
  });
  const release = await phoneRelease({ repo: "o/r", version: "0.4.49", token: "ghp_t", fetch: gh.fetch });
  assert.deepEqual(release.packages.map((p) => [p.package, p.url, p.sha256]), [
    ["ai.ash.agent", "https://api.github.com/repos/o/r/releases/assets/2", A],
    ["ai.ash.kernel", "https://api.github.com/repos/o/r/releases/assets/3", K],
  ]);
  assert.deepEqual(gh.seen.map((s) => [new URL(s.url).host, s.headers.authorization ?? null]), [
    ["api.github.com", "Bearer ghp_t"], ["api.github.com", "Bearer ghp_t"], ["objects.githubusercontent.com", null],
  ]);
});

test("what is missing is said: no release, no package in SHA256SUMS, a token that cannot read; one package alone is a release", async () => {
  const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof WordError ? `${e.code}${e.recovery_hint?.includes("GITHUB_TOKEN") ? "+hint" : ""}` : String(e); } return "none"; };
  assert.equal(await code(phoneRelease({ repo: "o/r", version: "9.9.9", token: null, fetch: github({}).fetch })), "not_found+hint");
  // A release of the app alone is a release: only the app is installed.
  const appOnly = await phoneRelease({ repo: "o/r", version: "0.4.49", token: null, fetch: github({ "https://github.com/o/r/releases/download/v0.4.49/SHA256SUMS": { status: 200, body: `${A}  app-0.4.49.apk\n` } }).fetch });
  assert.deepEqual(appOnly.packages.map((p) => p.package), ["ai.ash.agent"]);
  assert.equal(await code(phoneRelease({ repo: "o/r", version: "0.4.49", token: null, fetch: github({ "https://github.com/o/r/releases/download/v0.4.49/SHA256SUMS": { status: 200, body: `${A}  notes.txt\n` } }).fetch })), "not_found");
  assert.equal(await code(phoneRelease({ repo: "o/r", token: "old", fetch: github({ "https://api.github.com/repos/o/r/releases/latest": { status: 401 } }).fetch })), "forbidden+hint");
  assert.equal(await code(phoneRelease({ repo: "o/r", version: "latest", token: null, fetch: github({}).fetch })), "bad_request");
});
