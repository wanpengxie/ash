// Produces release assets locally; never publishes them or modifies a user service.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, copyFileSync, chmodSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const version = '0.2.0', nodeVersion = '22.22.1';
const out = resolve('build/device'); mkdirSync(out, { recursive: true });
const targets = process.argv.includes('--all') ? [['linux','x64'],['linux','arm64'],['darwin','x64'],['darwin','arm64']] : [[process.platform,process.arch]];
// Preflight all Darwin artifacts before any download. A manifest from the host
// target is never sufficient for another architecture (including --all).
const listenerArtifacts = new Map();
for (const [platform, arch] of targets) {
  if (platform !== 'darwin') continue; // Linux inspector remains unsupported.
  try {
    const base = resolve('build/device-listener-native', `${platform}-${arch}`);
    const binary = join(base, 'ash-listener-evidence.node'), manifest = join(base, 'listener-evidence.json');
    for (const path of [binary, manifest]) {
      const s = lstatSync(path);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (s.mode & 0o022) || s.size < 1 || s.size > (path === binary ? 512 * 1024 : 4096)) throw new Error();
    }
    const bytes = readFileSync(binary), metadata = JSON.parse(readFileSync(manifest, 'utf8'));
    const cpu = arch === 'arm64' ? 0x0100000c : 0x01000007;
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu ||
        !metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).some(k => !['version','name','platform','arch','napi','sha256'].includes(k)) ||
        metadata.version !== 1 || metadata.name !== 'ash-listener-evidence' || metadata.platform !== platform || metadata.arch !== arch || metadata.napi !== 8 ||
        metadata.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error();
    listenerArtifacts.set(`${platform}-${arch}`, { bytes, metadata: JSON.stringify(metadata) + '\n' });
  } catch { throw new Error(`Verified native listener artifact missing or invalid for ${platform}-${arch}`); }
}
const sums = [];
for (const [platform,arch] of targets) {
  if (!['linux','darwin'].includes(platform) || !['x64','arm64'].includes(arch)) throw new Error('Unsupported platform');
  const stage = mkdtempSync(join(tmpdir(),'ash-device-package-')), dir = join(stage,'ash-device'); mkdirSync(join(dir,'bin'),{recursive:true});
  if (process.argv.includes('--local-node')) {
    if(platform!==process.platform||arch!==process.arch)throw new Error('Local Node only supports native target');
    copyFileSync(process.execPath,join(dir,'node'));
  } else {
    const asset = `node-v${nodeVersion}-${platform}-${arch}.tar.gz`, base = `https://nodejs.org/dist/v${nodeVersion}`;
    const manifest = await (await fetch(`${base}/SHASUMS256.txt`)).text();
    const checksum = manifest.split('\n').find(line=>line.endsWith('  '+asset))?.split(' ')[0];
    if (!checksum) throw new Error('Node release checksum missing');
    const response = await fetch(`${base}/${asset}`); if(!response.ok)throw new Error('Node download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if(createHash('sha256').update(bytes).digest('hex')!==checksum)throw new Error('Node checksum mismatch');
    const archive=join(stage,asset);writeFileSync(archive,bytes);execFileSync('tar',['-xzf',archive,'-C',stage]);
    copyFileSync(join(stage,asset.replace('.tar.gz',''),'bin/node'),join(dir,'node'));
    copyFileSync(join(stage,asset.replace('.tar.gz',''),'LICENSE'),join(dir,'NODE-LICENSE'));
  }
  const nativeDir = resolve('build/device-native', `${platform}-${arch}`);
  const helperPath = join(nativeDir, 'ash-state-lock'), helperManifestPath = join(nativeDir, 'native-helper.json');
  if (!lstatSync(helperPath).isFile() || lstatSync(helperPath).isSymbolicLink() || !lstatSync(helperManifestPath).isFile() || lstatSync(helperManifestPath).isSymbolicLink()) throw new Error('Native target lock helper is missing');
  const helperManifest = JSON.parse(readFileSync(helperManifestPath, 'utf8'));
  if (helperManifest.version !== 1 || helperManifest.name !== 'ash-state-lock' || helperManifest.platform !== platform || helperManifest.arch !== arch || helperManifest.sha256 !== createHash('sha256').update(readFileSync(helperPath)).digest('hex')) throw new Error('Native target lock helper mismatch');
  copyFileSync(helperPath, join(dir, 'ash-state-lock')); chmodSync(join(dir, 'ash-state-lock'), 0o755);
  copyFileSync(helperManifestPath, join(dir, 'native-helper.json')); chmodSync(join(dir, 'native-helper.json'), 0o644);
  const listener = listenerArtifacts.get(`${platform}-${arch}`);
  if (listener) {
    writeFileSync(join(dir, 'ash-listener-evidence.node'), listener.bytes, { mode: 0o644 });
    writeFileSync(join(dir, 'listener-evidence.json'), listener.metadata, { mode: 0o644 });
  }
  copyFileSync('packages/device/dist/ash-device.mjs',join(dir,'ash-device.mjs'));
  copyFileSync('packages/device/bin/ash-device',join(dir,'bin/ash-device'));chmodSync(join(dir,'bin/ash-device'),0o755);chmodSync(join(dir,'node'),0o755);
  writeFileSync(join(dir,'release.json'),JSON.stringify({version,platform,arch,node:nodeVersion,native_state_lock:1,native_listener_evidence:listener ? 8 : undefined}));
  const name=`ash-device-${platform}-${arch}.tar.gz`,target=join(out,name);execFileSync('tar',['-czf',target,'-C',stage,'ash-device']);
  sums.push(`${createHash('sha256').update(readFileSync(target)).digest('hex')}  ${name}`);console.log(target);
}
writeFileSync(join(out,'SHA256SUMS'),sums.join('\n')+'\n');copyFileSync('packages/device/install.sh',join(out,'install.sh'));
