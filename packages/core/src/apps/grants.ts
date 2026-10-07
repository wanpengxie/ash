// The owner's grants for apps: what each installed app may use of ash, stored in stateDir/app-grants.json.
// Every call an app makes is checked against this table; nothing here ever widens without the install approval.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { needKey, type AppNeed } from "./schema";

export interface AppGrant { version: string; granted_at: number; enabled: boolean; needs: AppNeed[] }
interface GrantFile { version: 1; apps: Record<string, AppGrant>; cards: Record<string, string[]> }

export class AppGrants {
  private data: GrantFile;
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.data = { version: 1, apps: {}, cards: {} };
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<GrantFile>;
        if (raw && typeof raw.apps === "object" && raw.apps) this.data.apps = raw.apps as Record<string, AppGrant>;
        if (raw && typeof raw.cards === "object" && raw.cards) this.data.cards = raw.cards as Record<string, string[]>;
      }
    } catch { /* an unreadable table grants nothing; the owner installs again */ }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  get(id: string): AppGrant | null { return Object.hasOwn(this.data.apps, id) ? structuredClone(this.data.apps[id]!) : null; }
  all(): Record<string, AppGrant> { return structuredClone(this.data.apps); }

  /** The owner approved the install: exactly these needs, from now on. */
  grant(id: string, version: string, needs: AppNeed[]): AppGrant {
    this.data.apps[id] = { version, granted_at: this.now(), enabled: true, needs: structuredClone(needs) };
    this.save();
    return this.get(id)!;
  }

  setEnabled(id: string, enabled: boolean): AppGrant | null {
    const grant = this.data.apps[id];
    if (!grant) return null;
    grant.enabled = enabled;
    this.save();
    return this.get(id);
  }

  /** Take back one need, or the whole app (no need given). Only ever narrows. */
  revoke(id: string, need?: string): AppGrant | null {
    const grant = this.data.apps[id];
    if (!grant) return null;
    if (need === undefined) { delete this.data.apps[id]; this.save(); return null; }
    grant.needs = grant.needs.filter((item) => needKey(item) !== need);
    this.save();
    return this.get(id);
  }

  /** May app:<id> call member/word? Only an enabled app, only a granted word. */
  allows(app: string, member: string, word: string): boolean {
    const grant = this.data.apps[app.replace(/^app:/, "")];
    return Boolean(grant?.enabled && grant.needs.some((need) => "member" in need && need.member === member && need.words.includes(word)));
  }

  has(id: string, kind: "notify" | "widgets" | "card"): boolean {
    const grant = this.data.apps[id];
    return Boolean(grant?.enabled && grant.needs.some((need) => needKey(need) === kind));
  }

  /** Rate limit by local day: at most `limit` of this kind per app per day. Records the use when allowed. */
  take(id: string, kind: string, limit: number): boolean {
    const day = new Date(this.now()).toLocaleDateString("sv-SE");
    const key = `${id}/${kind}`;
    const used = (this.data.cards[key] ?? []).filter((item) => item === day);
    if (used.length >= limit) return false;
    this.data.cards[key] = [...used, day];
    this.save();
    return true;
  }
}
