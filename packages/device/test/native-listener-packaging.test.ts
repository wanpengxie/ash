import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { DEVICE_VERSION } from '../src/install';

test('offline native-target archive contains verified fixed listener release', { skip: process.platform !== 'darwin', timeout: 40_000 }, async () => {
  const root = mkdtempSync('/tmp/ash-npkg.'), repository = process.cwd();
  const staging = join(root, 'staging'); mkdirSync(staging);
  const packageEnv = { ...process.env, TMPDIR: staging };
  const files = ['tools/build-device-state-lock.mjs', 'tools/build-device-listener-evidence.mjs', 'tools/package-device.mjs',
    'packages/device/native/state-lock.c', 'packages/device/native/listener-evidence.c', 'packages/device/bin/ash-device', 'packages/device/install.sh'];
  try {
    for (const file of files) { mkdirSync(join(root, file, '..'), { recursive: true }); copyFileSync(file, join(root, file)); }
    const run = (args: string[]) => execFileSync(process.execPath, args, { env: packageEnv, cwd: root, stdio: 'pipe', timeout: 15_000 });
    run(['tools/build-device-state-lock.mjs']); run(['tools/build-device-listener-evidence.mjs']);
    const dist = join(root, 'packages/device/dist'), native = join(root, 'build/device-listener-native', `${process.platform}-${process.arch}`);
    for (const file of ['ash-listener-evidence.node', 'listener-evidence.json']) assert.deepEqual(readFileSync(join(dist, file)), readFileSync(join(native, file)));
    // Build the real device entry, without invoking it against any user state.
    await build({ entryPoints: ['packages/device/src/main.ts'], outfile: join(dist, 'ash-device.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
      banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" }, logLevel: 'silent' });
    // Any unexpected download fails; --local-node is the only execution route.
    writeFileSync(join(root, 'no-network.mjs'), "globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};\n");
    run(['--import', './no-network.mjs', 'tools/package-device.mjs', '--local-node']);
    const archive = join(root, 'build/device', `ash-device-${process.platform}-${process.arch}.tar.gz`);
    const sums = readFileSync(join(root, 'build/device/SHA256SUMS'), 'utf8');
    assert(sums.includes(createHash('sha256').update(readFileSync(archive)).digest('hex')));
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert(entries.every(p => p.startsWith('ash-device/') && !p.split('/').includes('..')));
    assert(execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n').every(p => p.startsWith('-') || p.startsWith('d')), 'installer accepts only regular files and directories');
    const extracted = join(root, 'extracted'); mkdirSync(extracted);
    execFileSync('tar', ['-xzf', archive, '-C', extracted]);
    const release = join(extracted, 'ash-device'), bundledNode = join(release, 'node');
    // --local-node copies the local executable only. Homebrew's split Node22
    // requires its installed libnode; use a child-only library path for this
    // same-host test. This does NOT establish a portable/self-contained release.
    const localEnv = { ...process.env, DYLD_LIBRARY_PATH: resolve(dirname(realpathSync(process.execPath)), '../lib') };
    assert.equal(execFileSync(bundledNode, [join(release, 'ash-device.mjs'), '--version'], { env: localEnv, encoding: 'utf8', timeout: 15_000 }).trim(), DEVICE_VERSION);
    assert.equal(JSON.parse(readFileSync(join(release, 'release.json'), 'utf8')).native_listener_evidence, 8);
    // Runtime wiring is a separate change. Exercise the exact production loader
    // from the extracted release location, with the archived artifact pair.
    const probe = join(release, 'listener-probe.mjs');
    await build({ stdin: { contents: `import {inspectNativeUnixListener as inspect} from ${JSON.stringify(resolve('packages/device/src/collaboration/native-listener-evidence.ts'))}; const o=inspect({socket:process.argv[2],executable:process.argv[3],expectedPid:Number(process.argv[4])});if(!o.has_listener)throw Error('fixture listener missing');console.log('verified');`, resolveDir: repository },
      outfile: probe, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
    const fixture = join(root, 'fixture'), socketPath = join(root, 'own.socket');
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'packages/device/test/fixtures/listener-evidence-server.c', '-o', fixture], { stdio: 'pipe' });
    const server = spawn(fixture, [socketPath], { stdio: ['pipe', 'pipe', 'ignore'] });
    let client: ReturnType<typeof connect> | undefined;
    try {
      await once(server.stdout, 'data'); client = connect(socketPath); await once(client, 'connect');
      assert.equal(execFileSync(bundledNode, [probe, socketPath, fixture, String(server.pid)], { env: localEnv, encoding: 'utf8', timeout: 5000 }).trim(), 'verified');
      const binary = join(release, 'ash-listener-evidence.node'); renameSync(binary, binary + '.saved');
      const missing = spawnSync(bundledNode, [probe, socketPath, fixture, String(server.pid)], { env: localEnv, encoding: 'utf8', timeout: 5000 });
      assert.notEqual(missing.status, 0); assert.match(missing.stderr, /unsupported/);
    } finally {
      client?.destroy(); server.stdin.end('exit\n');
      const timeout = setTimeout(() => { if (server.exitCode === null) server.kill('SIGTERM'); }, 500);
      try { if (server.exitCode === null) await once(server, 'exit'); } finally { clearTimeout(timeout); }
    }
    const binary = join(native, 'ash-listener-evidence.node'); renameSync(binary, binary + '.saved');
    const missing = spawnSync(process.execPath, ['--import', './no-network.mjs', 'tools/package-device.mjs', '--local-node'], { env: packageEnv, cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /Verified native listener artifact missing or invalid/); assert(!missing.stderr.includes('NETWORK_FORBIDDEN'));
    renameSync(binary + '.saved', binary);
    const manifest = join(native, 'listener-evidence.json'), validManifest = readFileSync(manifest);
    const invalidAbi = JSON.parse(validManifest.toString()); invalidAbi.napi = 999;
    writeFileSync(manifest, JSON.stringify(invalidAbi));
    const abi = spawnSync(process.execPath, ['--import', './no-network.mjs', 'tools/package-device.mjs', '--local-node'], { env: packageEnv, cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(abi.status, 0); assert.match(abi.stderr, /Verified native listener artifact missing or invalid/); assert(!abi.stderr.includes('NETWORK_FORBIDDEN'));
    writeFileSync(manifest, validManifest);
    const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64', wrong = join(root, 'build/device-listener-native', `darwin-${otherArch}`); mkdirSync(wrong);
    copyFileSync(binary, join(wrong, 'ash-listener-evidence.node'));
    const metadata = JSON.parse(readFileSync(join(native, 'listener-evidence.json'), 'utf8')); metadata.arch = otherArch;
    writeFileSync(join(wrong, 'listener-evidence.json'), JSON.stringify(metadata));
    const cross = spawnSync(process.execPath, ['--import', './no-network.mjs', 'tools/package-device.mjs', '--all'], { env: packageEnv, cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(cross.status, 0); assert.match(cross.stderr, new RegExp(`Verified native listener artifact missing or invalid for darwin-${otherArch}`)); assert(!cross.stderr.includes('NETWORK_FORBIDDEN'));
    // Branch-only Linux simulation: no assertion that a Linux binary was built.
    run(['--input-type=module', '-e', "Object.defineProperty(process,'platform',{value:'linux'});await import('./tools/build-device-listener-evidence.mjs');"]);
    const linuxSkip = readFileSync(join(dist, 'ash-device.mjs'));
    assert(linuxSkip.length > 0); // Existing bundle survives unsupported helper skip.
    assert.throws(() => readFileSync(join(dist, 'listener-evidence.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
