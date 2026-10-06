#!/usr/bin/env node
// Static CI guard for the phone capability registry. Runtime also fails closed on an unknown name.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const capDir = process.argv[3] || join(root, 'android/app/src/main/java/ai/ash/host/cap');
const policy = readFileSync(process.argv[2] || join(capDir, 'CapabilityPolicy.kt'), 'utf8');
const declared = [...policy.matchAll(/"([a-z]+\.[a-z_]+)"\s+to\s+CapabilityPolicy\("(none|outward|structure)",\s*"([^"]+)"\)/g)]
  .map((match) => ({ name: match[1], risk: match[2], label: match[3] }));
const names = [];
const errors = [];
const registry = readFileSync(join(capDir, 'Capabilities.kt'), 'utf8');
const registryBody = registry.match(/val\s+all\s*:\s*List<Capability>\s+by\s+lazy\s*\{([^{}]+)\}/)?.[1];
const entries = registryBody?.split('+').map((entry) => entry.trim()) || [];
if (!entries.length || entries.some((entry) => !/^[A-Z][A-Za-z0-9_]*\.list$/.test(entry)))
  errors.push('capability registry has dynamic or unrecognized module list');
const modules = entries.filter((entry) => /^[A-Z][A-Za-z0-9_]*\.list$/.test(entry)).map((entry) => `${entry.slice(0, -5)}.kt`);
if (modules.length !== new Set(modules).size) errors.push('duplicate capability registry module');
for (const file of modules) {
  let source;
  try { source = readFileSync(join(capDir, file), 'utf8'); }
  catch { errors.push(`${file}: registered module file missing`); continue; }
  const literal = [...source.matchAll(/\b(?:Cap|vcap)\s*\(\s*(?:name\s*=\s*)?"([a-z]+\.[a-z_]+)"/g)].map((match) => match[1]);
  names.push(...literal);
  const allCalls = [...source.matchAll(/\b(?:Cap|vcap)\s*\(/g)].length;
  const knownHelper = file === 'VScreenCapabilities.kt' ? 2 : 0; // vcap declaration and its Cap(name, ...) wrapper
  if (allCalls !== literal.length + knownHelper) errors.push(`${file}: dynamic or unrecognized capability name (${allCalls} calls, ${literal.length} literal, ${knownHelper} known helper)`);
}
// The screen helper's tools join the phone's manifest while it is connected (ScreenBridge), and Ash adds
// screen.screenshot on top of them: Ash's policy has to cover these as well.
const helper = readFileSync(join(root, 'android/screen/src/main/java/ai/ash/screen/ScreenCapabilities.kt'), 'utf8');
const helperNames = [...helper.matchAll(/\bCap\s*\(\s*(?:name\s*=\s*)?"([a-z]+\.[a-z_]+)"/g)].map((match) => match[1]);
if ([...helper.matchAll(/\bCap\s*\(/g)].length !== helperNames.length) errors.push('ScreenCapabilities.kt (helper): dynamic or unrecognized capability name');
names.push(...helperNames);
const ashTools = readFileSync(join(root, 'android/app/src/main/java/ai/ash/host/screen/ScreenshotTool.kt'), 'utf8');
names.push(...[...ashTools.matchAll(/override val name = "([a-z]+\.[a-z_]+)"/g)].map((match) => match[1]));
for (const name of names) if (names.indexOf(name) !== names.lastIndexOf(name)) errors.push(`duplicate capability: ${name}`);
for (const item of declared) {
  if (!item.label.trim()) errors.push(`empty label: ${item.name}`);
  if (declared.filter((other) => other.name === item.name).length !== 1) errors.push(`duplicate policy: ${item.name}`);
}
for (const name of names) if (!declared.some((item) => item.name === name)) errors.push(`missing risk/label: ${name}`);
for (const item of declared) if (!names.includes(item.name)) errors.push(`policy without capability: ${item.name}`);
if (!sourceHasFailClosed()) errors.push('runtime policy lookup must fail closed');
if (errors.length) { for (const error of errors) process.stderr.write(`${error}\n`); process.exitCode = 1; }
else process.stdout.write(`manifest policy complete: ${names.length} capabilities, ${declared.length} explicit classifications\n`);

function sourceHasFailClosed() {
  return registry.includes('CapabilityPolicies.require(c.name)') && policy.includes('requireNotNull(byName[name])');
}
