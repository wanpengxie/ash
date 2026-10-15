/**
 * A release of the phone's packages on GitHub (`v<version>`: `app-<version>.apk` and/or `kernel-<version>.apk` and their
 * `SHA256SUMS`), as the host's `update.install` takes it. Only GitHub's release pages, no mirror. A private repository is
 * read through the API with a read-only token; the token is sent to api.github.com only (the asset redirects to a signed
 * storage address, which gets no token) and is never part of a word's body or the ledger.
 */
import { WordError } from "../../../../sdk/src/message";

export interface PhonePackage { package: string; url: string; sha256: string }
export interface PhoneRelease { version: string; packages: PhonePackage[] }

/** The asset each package is published as. */
const ASSETS: readonly [string, (version: string) => string][] = [
  ["ai.ash.agent", (v) => `app-${v}.apk`],
  ["ai.ash.kernel", (v) => `kernel-${v}.apk`],
];
const VERSION = /^\d+\.\d+\.\d+$/;

/** `<sha256>  <name>` lines (sha256sum's format; a `*` before the name is allowed). */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([a-f0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m) sums.set(m[2]!, m[1]!);
  }
  return sums;
}

export interface ReleaseOptions {
  /** `owner/name` of the repository the phone's packages are published in. */
  repo: string;
  /** Without one: the latest release. */
  version?: string;
  token: string | null;
  fetch?: typeof fetch;
}

/** Finds the release, reads its SHA256SUMS and names each package's address and checksum. */
export async function phoneRelease(o: ReleaseOptions): Promise<PhoneRelease> {
  const get = o.fetch ?? fetch;
  const version = o.version?.replace(/^v/, "");
  if (version !== undefined && !VERSION.test(version)) throw new WordError("bad_request", "version looks like 0.4.49");
  const ask = async (url: string, headers: Record<string, string>): Promise<Response> => {
    let res: Response;
    try { res = await get(url, { headers: { "user-agent": "ash-hub", ...headers }, redirect: "manual", signal: AbortSignal.timeout(30_000) }); }
    catch (error) { throw new WordError("unavailable", `GitHub cannot be reached from the phone (${error instanceof Error ? error.message : String(error)})`, { recovery_hint: "Check the phone's network (or its proxy) and try again." }); }
    // A redirect goes to signed storage: followed without the token.
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) return ask(new URL(res.headers.get("location")!, url).toString(), {});
    if (res.status === 404) throw new WordError("not_found", `no such release in ${o.repo}${version ? `: v${version}` : ""}`, { recovery_hint: o.token ? "Check the version on the repository's release page." : `If ${o.repo} is private, store a read-only GitHub token as GITHUB_TOKEN in the vault.` });
    if (res.status === 401 || res.status === 403) throw new WordError("forbidden", `GitHub refused (${res.status})`, { recovery_hint: "The token in the vault (GITHUB_TOKEN) cannot read this repository's releases, or it expired." });
    if (!res.ok) throw new WordError("unavailable", `GitHub answered ${res.status}`);
    return res;
  };

  let sums: Map<string, string>;
  let urlOf: (name: string) => string | undefined;
  let tag: string | undefined;
  if (o.token) {
    const auth = { authorization: `Bearer ${o.token}` };
    const release = await (await ask(`https://api.github.com/repos/${o.repo}/releases/${version ? `tags/v${version}` : "latest"}`, { ...auth, accept: "application/vnd.github+json" })).json() as { tag_name?: string; assets?: { name: string; url: string }[] };
    tag = release.tag_name;
    const assets = new Map((release.assets ?? []).map((a) => [a.name, a.url]));
    const sumsUrl = assets.get("SHA256SUMS");
    if (!sumsUrl) throw new WordError("not_found", `release ${tag ?? ""} has no SHA256SUMS`, { recovery_hint: "Publish SHA256SUMS (sha256sum app-*.apk kernel-*.apk) with the APKs." });
    sums = parseSums(await (await ask(sumsUrl, { ...auth, accept: "application/octet-stream" })).text());
    urlOf = (name) => assets.get(name);
  } else {
    const base = `https://github.com/${o.repo}/releases/${version ? `download/v${version}` : "latest/download"}`;
    sums = parseSums(await (await ask(`${base}/SHA256SUMS`, {})).text());
    urlOf = (name) => `${base}/${name}`;
  }
  // The version is the one the packages are named with (the latest release says it only there, without a token).
  const named = version ?? tag?.replace(/^v/, "") ?? [...sums.keys()].map((n) => /^(?:app|kernel)-(\d+\.\d+\.\d+)\.apk$/.exec(n)?.[1]).find(Boolean);
  if (!named || !VERSION.test(named)) throw new WordError("not_found", "the release does not say its version (app-<version>.apk or kernel-<version>.apk in SHA256SUMS)");
  // A release carries what changed: the app alone, the kernel alone, or both. Each package it lists is checked and installed.
  const packages = ASSETS.flatMap(([pkg, asset]) => {
    const name = asset(named);
    const sha256 = sums.get(name), url = urlOf(name);
    if (!sha256) return [];
    if (!url) throw new WordError("not_found", `release v${named} lists ${name} in SHA256SUMS but does not carry it`);
    return [{ package: pkg, url, sha256 }];
  });
  if (!packages.length) throw new WordError("not_found", `release v${named} carries neither app-${named}.apk nor kernel-${named}.apk`);
  return { version: named, packages };
}
