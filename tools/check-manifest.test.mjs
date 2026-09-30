import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checker = new URL('./check-manifest.mjs', import.meta.url);
const source = readFileSync(new URL('../android/app/src/main/java/ai/ash/host/cap/CapabilityPolicy.kt', import.meta.url), 'utf8');
const run = (policy) => spawnSync(process.execPath, [checker.pathname, policy], { encoding: 'utf8' });

test('every declared capability has an explicit risk and owner-facing label', () => {
  const result = spawnSync(process.execPath, [checker.pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /37 capabilities, 37 explicit classifications/);
});

test('CI fails closed when a capability policy is absent or has an unknown risk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ash-manifest-check-'));
  try {
    const missing = join(dir, 'missing.kt');
    writeFileSync(missing, source.replace(/^.*"calendar.create" to CapabilityPolicy.*\n/m, ''));
    const absent = run(missing);
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /missing risk\/label: calendar.create/);
    const invalid = join(dir, 'invalid.kt');
    writeFileSync(invalid, source.replace('"calendar.create" to CapabilityPolicy("outward"', '"calendar.create" to CapabilityPolicy("unsafe"'));
    const unsafe = run(invalid);
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /missing risk\/label: calendar.create/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
