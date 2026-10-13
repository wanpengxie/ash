// Native build only. Does not install a helper, change compiler settings, or start services.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const platform = process.platform, arch = process.arch;
if (!['darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported native lock-helper build target');
const target = `${platform}-${arch}`;
const output = resolve('build/device-native', target), dist = resolve('packages/device/dist');
mkdirSync(output, { recursive: true }); mkdirSync(dist, { recursive: true });
const temporary = join(output, `.ash-state-lock-${randomUUID()}`);
try {
  execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fstack-protector-strong', 'packages/device/native/state-lock.c', '-o', temporary], { stdio: 'inherit' });
  chmodSync(temporary, 0o755);
  const bytes = readFileSync(temporary);
  if (!bytes.length || bytes.length > 256 * 1024) throw new Error('Invalid helper size');
  const manifest = { version: 1, name: 'ash-state-lock', platform, arch, sha256: createHash('sha256').update(bytes).digest('hex') };
  renameSync(temporary, join(output, 'ash-state-lock'));
  writeFileSync(join(output, 'native-helper.json'), JSON.stringify(manifest) + '\n', { mode: 0o644 });
  copyFileSync(join(output, 'ash-state-lock'), join(dist, 'ash-state-lock')); chmodSync(join(dist, 'ash-state-lock'), 0o755);
  copyFileSync(join(output, 'native-helper.json'), join(dist, 'native-helper.json'));
  console.log(`Built ${target} descriptor lock helper.`);
} finally { rmSync(temporary, { force: true }); }
