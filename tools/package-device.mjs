// Produces release assets locally; never publishes them or modifies a user service.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const version = '0.1.1', nodeVersion = '22.22.1';
const out = resolve('build/device'); mkdirSync(out, { recursive: true });
const targets = process.argv.includes('--all') ? [['linux','x64'],['linux','arm64'],['darwin','x64'],['darwin','arm64']] : [[process.platform,process.arch]];
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
  copyFileSync('packages/device/dist/ash-device.mjs',join(dir,'ash-device.mjs'));
  copyFileSync('packages/device/bin/ash-device',join(dir,'bin/ash-device'));chmodSync(join(dir,'bin/ash-device'),0o755);chmodSync(join(dir,'node'),0o755);
  writeFileSync(join(dir,'release.json'),JSON.stringify({version,platform,arch,node:nodeVersion}));
  const name=`ash-device-${platform}-${arch}.tar.gz`,target=join(out,name);execFileSync('tar',['-czf',target,'-C',stage,'ash-device']);
  sums.push(`${createHash('sha256').update(readFileSync(target)).digest('hex')}  ${name}`);console.log(target);
}
writeFileSync(join(out,'SHA256SUMS'),sums.join('\n')+'\n');copyFileSync('packages/device/install.sh',join(out,'install.sh'));
