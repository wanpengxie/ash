import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { NativeListenerObservation } from '../src/collaboration/native-listener-evidence';

// Production code derives the module from its own code location. Tests bundle
// that exact loader into a temporary release; there is no helper-path injection.
test('fixed native release all-visible evidence and adversarial own fixtures', { skip: process.platform !== 'darwin', timeout: 40_000 }, async () => {
  const root = mkdtempSync('/tmp/ash-ne.'); chmodSync(root, 0o700);
  const artifact = join(root, 'artifact'), executable = join(root, 'fixture');
  try {
    execFileSync(process.execPath, ['tools/build-device-listener-evidence.mjs', '--out', artifact], { stdio: 'pipe' });
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'packages/device/test/fixtures/listener-evidence-server.c', '-o', executable], { stdio: 'pipe' });
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'packages/device/test/fixtures/listener-evidence-exec.c', '-o', executable+'.other'], { stdio: 'pipe' });
    let serial = 0;
    const release = async () => {
      const directory = join(root, `release-${++serial}`); mkdirSync(directory, { mode: 0o700 });
      for (const file of ['ash-listener-evidence.node', 'listener-evidence.json']) copyFileSync(join(artifact, file), join(directory, file));
      const loader = join(directory, 'loader.mjs');
      await build({ entryPoints: ['packages/device/src/collaboration/native-listener-evidence.ts'], outfile: loader, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
      const api = await import(pathToFileURL(loader).href);
      return { directory, inspect: api.inspectNativeUnixListener as (c: { socket: string; executable: string; expectedPid?: number }) => NativeListenerObservation };
    };
    const start = async (other = false) => {
      const path = join(root, `socket-${++serial}`);
      const server = spawn(other?executable+'.other':executable, other?[path,executable]:[path], { stdio: ['pipe', 'pipe', 'ignore'] });
      const lines = createInterface({ input: server.stdout }); const iterator = lines[Symbol.asyncIterator]();
      const line = async () => { const next = await iterator.next(); assert(!next.done, `fixture response required (directory=${existsSync(root)},binary=${existsSync(executable)},exit=${server.exitCode})`); return next.value; };
      assert.equal(await line(), other?'mapped-ready':'ready');
      const client = connect(path); await once(client, 'connect');
      const command = async (value: string) => { server.stdin.write(`${value}\n`); return line(); };
      const stop = async () => {
        client.destroy(); if (server.exitCode === null) { server.stdin.write('exit\n'); server.stdin.end(); }
        const timeout = setTimeout(() => { if (server.exitCode === null) server.kill('SIGTERM'); }, 500);
        try { if (server.exitCode === null) await once(server, 'exit'); } finally { clearTimeout(timeout); lines.close(); }
      };
      return { path, server, command, stop };
    };
    const installed = await release();
    const run = async (_name: string, check: () => Promise<void>) => { await check(); };
    await run('owner, PID incarnation, accepted clones, listener loss, FD reuse and inode replacement', async () => {
      const f = await start();
      try {
        const config = { socket: f.path, executable, expectedPid: f.server.pid! };
        const original = installed.inspect(config);
        assert(original.pid === f.server.pid && original.has_listener, 'own listener attested');
        assert.match(original.process_start, /^\d+:\d+$/);
        assert.equal(original.main_executable,realpathSync(executable));
        assert.match(original.listener_identity, /^[a-f0-9]{64}$/);
        assert.equal(installed.inspect(config).process_start, original.process_start);
        assert.equal(installed.inspect(config).listener_identity, original.listener_identity);
        for (const action of ['fork_listener', 'fork_accepted']) {
          await f.command(action); assert.throws(() => installed.inspect(config), { code: 'offline' });
          await f.command('drop'); assert(installed.inspect(config).has_listener);
        }
        // Keep the old listener live until the replacement is allocated. Two
        // simultaneous objects cannot reuse the same kernel address pair.
        await f.command('rebind'); const liveReplacement = installed.inspect(config);
        assert(liveReplacement.has_listener);
        assert.notEqual(liveReplacement.socket_identity, original.socket_identity);
        assert.notEqual(liveReplacement.listener_identity, original.listener_identity, 'distinct simultaneously allocated listening objects observed');
        await f.command('close'); const closed = installed.inspect(config);
        assert.equal(closed.has_listener, false); // Preserve original accepted-owner set.
        assert.notEqual(closed.listener_identity, liveReplacement.listener_identity, 'closed listener object absent from snapshot');
        await f.command('rebind'); const rebound = installed.inspect(config);
        assert.notEqual(rebound.socket_identity, liveReplacement.socket_identity, 'path replacement changes observed stat identity');
        assert(rebound.has_listener, 'listening resumes after close and rebind');
        assert.match(rebound.listener_identity, /^[a-f0-9]{64}$/);
        // A freed kernel address pair can be reused, so equal snapshot digests
        // here must not be interpreted as uninterrupted listener continuity.
        await f.command('reuse'); assert.equal(installed.inspect(config).has_listener, false);
        assert.throws(() => installed.inspect({ ...config, expectedPid: 2147483647 }), { code: 'offline' });
      } finally { await f.stop(); }
    });
    await run('Mach fileport remains an owner without numeric socket FDs', async () => {
      const f = await start();
      try { assert.equal(await f.command('fileport'), 'done'); assert(installed.inspect({ socket: f.path, executable, expectedPid: f.server.pid! }).has_listener); }
      finally { await f.stop(); }
    });
    await run('exec changes mapped executable without changing PID', async () => {
      const f = await start();
      try {
        const config = { socket: f.path, executable, expectedPid: f.server.pid! }; installed.inspect(config);
        await f.command('exec');
        // Poll only own fixture metadata; no arbitrary sleep or real daemon.
        const deadline = Date.now() + 1000; let rejected = false;
        while (!rejected && Date.now() < deadline) { try { installed.inspect(config); } catch (e) { rejected = (e as { code: string }).code === 'offline'; } if (!rejected) await new Promise(resolve => setTimeout(resolve, 5)); }
        assert(rejected, 'exec mismatch rejected');
      } finally { await f.stop(); }
    });
    await run('other main image mapping original is rejected, including same-PID inherited-listener exec', async () => {
      for (const direct of [true,false]) {
        const f=await start(direct);
        try {
          const config={socket:f.path,executable,expectedPid:f.server.pid!};
          const pid=f.server.pid!;
          if(!direct){
            installed.inspect(config);
            const transition=f.command('exec_mapped');
            // Race only this own child. A scan before exec may still accept the
            // original image; a scan observing a different/vanished image must
            // fail. This does not assert historical exec ABA exclusion.
            for(let i=0;i<16;i++){try{assert.equal(installed.inspect(config).main_executable,realpathSync(executable));}catch(error){assert.equal((error as {code:string}).code,'offline');}}
            assert.equal(await transition,'mapped-ready');assert.equal(f.server.pid,pid,'exec preserves the actual child PID');
          }
          const text=execFileSync('lsof',['-a','-p',String(pid),'-d','txt','-Fn'],{encoding:'utf8',timeout:5000});
          assert(text.split('\n').some(line=>{try{return line.startsWith('n')&&realpathSync(line.slice(1))===realpathSync(executable);}catch{return false;}}),'original is still actually mapped, not just an argv claim');
          assert.throws(()=>installed.inspect(config),{code:'offline'});
          const current=installed.inspect({...config,executable:executable+'.other'});
          assert.equal(current.main_executable,realpathSync(executable+'.other'));
          assert(current.has_listener,'original actual listener FD is retained across exec');
        } finally {await f.stop();}
        assert.throws(()=>installed.inspect({socket:f.path,executable,expectedPid:f.server.pid!}),{code:'offline'},'exited original PID never supplies evidence');
      }
    });
    await run('target process-info permission denial produces no proof', async () => {
      const f = await start();
      try {
        const helper = join(root, 'deny.mjs');
        writeFileSync(helper, `import {inspectNativeUnixListener as inspect} from ${JSON.stringify(pathToFileURL(join(installed.directory, 'loader.mjs')).href)};try{inspect({socket:process.argv[2],executable:process.argv[3],expectedPid:Number(process.argv[4])});process.exitCode=2;}catch(e){if(e.code!=='offline')process.exitCode=3;}`);
        execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny process-info*)', process.execPath, helper, f.path, executable, String(f.server.pid)], { stdio: 'pipe', timeout: 5000 });
      } finally { await f.stop(); }
    });
    await run('installed lsof owner and txt predicates match own visible fixture', async () => {
      const f = await start();
      try {
        const evidence = installed.inspect({ socket: f.path, executable });
        const output = execFileSync('lsof', ['-nP', '-a', '-U', '-Fpn', '--', f.path], { encoding: 'utf8', timeout: 5000 });
        const owners = new Set<number>(); let pid = 0;
        for (const line of output.split('\n')) {
          if (line.startsWith('p')) pid = Number(line.slice(1));
          if (line.startsWith('n')) { try { if (realpathSync(line.slice(1)) === realpathSync(f.path)) owners.add(pid); } catch { /* Same original canonicalization rule. */ } }
        }
        assert(owners.size === 1 && owners.has(evidence.pid), 'exact own visible owner set');
        const text = execFileSync('lsof', ['-a', '-p', String(evidence.pid), '-d', 'txt', '-Fn'], { encoding: 'utf8', timeout: 5000 });
        assert(text.split('\n').some(line => { try { return line.startsWith('n') && realpathSync(line.slice(1)) === realpathSync(executable); } catch { return false; } }), 'same mapped txt predicate');
      } finally { await f.stop(); }
    });
    await run('missing, tampered, symlink and ABI manifests never use cached proof', async () => {
      const f = await start();
      try {
        const config = { socket: f.path, executable, expectedPid: f.server.pid! };
        for (const mode of ['missing', 'tampered', 'symlink', 'abi', 'platform']) {
          const own = await release(); const binary = join(own.directory, 'ash-listener-evidence.node');
          if (mode === 'tampered') { own.inspect(config); writeFileSync(binary, Buffer.concat([readFileSync(binary), Buffer.from('fixture-change')])); }
          if (mode === 'missing') rmSync(binary);
          if (mode === 'symlink') { rmSync(binary); symlinkSync(join(artifact, 'ash-listener-evidence.node'), binary); }
          if (mode === 'abi' || mode === 'platform') {
            const path = join(own.directory, 'listener-evidence.json'), m = JSON.parse(readFileSync(path, 'utf8'));
            if (mode === 'abi') m.napi = 999; else m.platform = 'linux'; writeFileSync(path, JSON.stringify(m));
          }
          assert.throws(() => own.inspect(config), { code: 'unsupported' });
        }
        assert.throws(() => installed.inspect({ socket: 'relative', executable }), { code: 'invalid' });
      } finally { await f.stop(); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
