import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authScope, loadAuthScopeKey } from "../../src/auth-scope";

function fixture(run: (dir: string, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ash-auth-scope-"));
  try { run(dir, join(dir, "screen-auth-scope.key")); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("scope key persists across restart and separates credentials without exposing their text", () => fixture((dir, path) => {
  const key = loadAuthScopeKey(dir);
  assert.equal(key.length, 32);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(loadAuthScopeKey(dir), key);
  const a = authScope(key, "token:credential-A");
  assert.match(a, /^v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(a, authScope(loadAuthScopeKey(dir), "token:credential-A"));
  assert.notEqual(a, authScope(key, "token:credential-B"));
  assert.ok(!a.includes("credential"));
  assert.equal(readFileSync(path).length, 32);
}));

test("existing malformed, world-readable, or symlink key fails closed without rotating", () => {
  fixture((dir, path) => {
    writeFileSync(path, Buffer.alloc(31), { mode: 0o600 });
    assert.throws(() => loadAuthScopeKey(dir));
    assert.equal(readFileSync(path).length, 31);
  });
  fixture((dir, path) => {
    writeFileSync(path, Buffer.alloc(32), { mode: 0o600 });
    chmodSync(path, 0o644);
    assert.throws(() => loadAuthScopeKey(dir));
    assert.equal(statSync(path).mode & 0o777, 0o644);
  });
  fixture((dir, path) => {
    const other = join(dir, "other");
    writeFileSync(other, Buffer.alloc(32), { mode: 0o600 });
    symlinkSync(other, path);
    assert.throws(() => loadAuthScopeKey(dir));
  });
});
