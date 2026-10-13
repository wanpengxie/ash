// Local native build only; never installs or changes a user service.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const platform = process.platform, arch = process.arch, napi = 8;
const args = process.argv.slice(2);
if (args.some((v, i) => i % 2 === 0 && !['--out', '--node-include'].includes(v)) || args.length % 2) throw new Error('Invalid build arguments');
const option = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const dist = resolve('packages/device/dist');
if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Listener evidence is unverified on this platform');
if (platform === 'linux') {
  // Preserve Linux packaging without claiming a verified Linux inspector.
  if (!option('--out')) for (const name of ['ash-listener-evidence.node', 'listener-evidence.json']) rmSync(join(dist, name), { force: true });
  console.log(JSON.stringify({ artifact: 'ash-listener-evidence', platform, arch, supported: false }));
  process.exit(0);
}
const include = resolve(option('--node-include') ?? join(dirname(realpathSync(process.execPath)), '../include/node'));
if (!existsSync(join(include, 'node_api.h'))) throw new Error('Installed Node-API headers are required; no download fallback');
const out = resolve(option('--out') ?? join('build/device-listener-native', `${platform}-${arch}`));
mkdirSync(out, { recursive: true });
const temporary = join(out, `.ash-listener-evidence-${randomUUID()}.node`);
try {
  execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fstack-protector-strong', '-bundle', '-undefined', 'dynamic_lookup', `-I${include}`, 'packages/device/native/listener-evidence.c', '-o', temporary], { stdio: 'inherit' });
  chmodSync(temporary, 0o644);
  const bytes = readFileSync(temporary);
  if (bytes.length < 1 || bytes.length > 512 * 1024) throw new Error('Invalid native module size');
  const manifest = { version: 1, name: 'ash-listener-evidence', platform, arch, napi, sha256: createHash('sha256').update(bytes).digest('hex') };
  renameSync(temporary, join(out, 'ash-listener-evidence.node'));
  writeFileSync(join(out, 'listener-evidence.json'), JSON.stringify(manifest) + '\n', { mode: 0o644 });
  if (!option('--out')) {
    mkdirSync(dist, { recursive: true });
    for (const name of ['ash-listener-evidence.node', 'listener-evidence.json']) {
      copyFileSync(join(out, name), join(dist, name)); chmodSync(join(dist, name), 0o644);
    }
  }
  console.log(JSON.stringify({ artifact: 'ash-listener-evidence', platform, arch, napi, built: true }));
} finally { rmSync(temporary, { force: true }); }
