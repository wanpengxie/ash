#!/usr/bin/env node
// Static CI guard for the phone capability registry. Runtime also fails closed on an unknown name.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const capDir = join(root, 'android/app/src/main/java/ai/ash/host/cap');
const modules = ['SystemCapabilities.kt', 'ScreenCapabilities.kt', 'ShellCapabilities.kt', 'VScreenCapabilities.kt', 'CalendarCapabilities.kt'];
const policy = readFileSync(process.argv[2] || join(capDir, 'CapabilityPolicy.kt'), 'utf8');
const declared = [...policy.matchAll(/"([a-z]+\.[a-z_]+)"\s+to\s+CapabilityPolicy\("(none|outward|structure)",\s*"([^"]+)"\)/g)]
  .map((match) => ({ name: match[1], risk: match[2], label: match[3] }));
const names = [];
const errors = [];
for (const file of modules) {
  const source = readFileSync(join(capDir, file), 'utf8');
  const literal = [...source.matchAll(/\b(?:Cap|vcap)\s*\(\s*(?:name\s*=\s*)?"([a-z]+\.[a-z_]+)"/g)].map((match) => match[1]);
  names.push(...literal);
  const allCalls = [...source.matchAll(/\b(?:Cap|vcap)\s*\(/g)].length;
  const knownHelper = file === 'VScreenCapabilities.kt' ? 2 : 0; // vcap declaration and its Cap(name, ...) wrapper
  if (allCalls !== literal.length + knownHelper) errors.push(`${file}: dynamic or unrecognized capability name (${allCalls} calls, ${literal.length} literal, ${knownHelper} known helper)`);
}
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
  const source = readFileSync(join(capDir, 'Capabilities.kt'), 'utf8');
  return source.includes('CapabilityPolicies.require(c.name)') && policy.includes('requireNotNull(byName[name])');
}
