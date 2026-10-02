import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareDocuments, normalizeParagraph, scanPublicTerms } from './originality.mjs';

const run = (target, reference) => compareDocuments([{ path: 'draft.md', text: target }], [{ path: 'private.md', text: reference }], Buffer.alloc(16));

test('exactly twelve counted characters pass; thirteen are reported', () => {
  assert.equal(run('abcdefghijkl', 'abcdefghijkl').match_count, 0);
  const hit = run('abcdefghijklm', 'abcdefghijklm');
  assert.equal(hit.match_count, 1);
  assert.equal(hit.matches[0].length, 13);
});

test('Han characters count one code point each, with punctuation ignored', () => {
  const chars = '天地玄黄宇宙洪荒日月盈昃辰';
  assert.equal(normalizeParagraph(chars).length, 13);
  assert.equal(run(chars.slice(0, 12), chars.slice(0, 12)).match_count, 0);
  assert.equal(run('天地，玄黄 宇宙洪荒日月盈昃辰', chars).matches[0].length, 13);
});

test('English case, fullwidth letters, and whitespace normalize before counting', () => {
  const hit = run('ＡＢＣＤＥＦＧＨＩＪＫＬＭ', 'abc def GHIJKLM');
  assert.equal(hit.matches[0].length, 13);
});

test('paragraph boundaries prevent a joined thirteen-character hit', () => {
  assert.equal(run('abcdef\n\nghijklm', 'abcdefghijklm').match_count, 0);
});

test('one maximal match is reported, without raw text or paths', () => {
  const hit = run('abcdefghijklmnop', 'zzabcdefghijklmnopzz');
  assert.equal(hit.match_count, 1);
  assert.equal(hit.matches[0].length, 16);
  const json = JSON.stringify(hit);
  for (const secret of ['abcdefghijklmnop', 'private.md', 'draft.md']) assert.ok(!json.includes(secret));
});

test('term scan catches prose adjacency but ignores encoded substrings', () => {
  const term = 'FROG42';
  const scanned = scanPublicTerms([
    { path: 'a.md', text: `引入${term}的概念` },
    { path: 'b.json', text: `a9f${term}b3c` },
  ], [term], Buffer.alloc(16));
  assert.equal(scanned.scanned_files, 2);
  assert.equal(scanned.finding_count, 1);
  assert.ok(!JSON.stringify(scanned).includes(term));
});

test('empty comparison fails closed', () => {
  assert.throws(() => compareDocuments([], [{ path: 'r.md', text: 'abcdefghijklm' }]), /target and reference/);
  assert.throws(() => compareDocuments([{ path: 't.md', text: 'abcdefghijklm' }], []), /target and reference/);
});

test('term scan fails closed without a private term list', () => {
  assert.throws(() => scanPublicTerms([{ path: 'a.md', text: 'ordinary text' }], []), /private terms/);
  assert.throws(() => scanPublicTerms([], ['SYNTHETIC']), /no text files/);
});

test('CI CLI consumes env terms and refuses an absent secret', () => {
  const cwd = new URL('..', import.meta.url);
  const args = ['tools/originality.mjs', '--ci-terms'];
  const missing = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, ASH_PRIVATE_TERMS: '' } });
  assert.equal(missing.status, 2);
  assert.ok(!missing.stdout.includes('finding_count'));
  const present = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, ASH_PRIVATE_TERMS: ['UNLIKELY', 'TEST', 'TOKEN'].join('_') } });
  assert.equal(present.status, 0);
  assert.equal(JSON.parse(present.stdout).finding_count, 0);
});

test('local CLI reports a positive match without printing private text or paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ash-originality-'));
  try {
    const target = join(dir, 'target.md');
    const reference = join(dir, 'reference.md');
    const output = join(dir, 'result.json');
    const phrase = 'abcdefghijklmnop';
    writeFileSync(target, phrase);
    writeFileSync(reference, `prefix ${phrase} suffix`);
    const run = spawnSync(process.execPath, ['tools/originality.mjs', '--target', target, '--reference', reference, '--output', output], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, '');
    const report = readFileSync(output, 'utf8');
    assert.equal(JSON.parse(report).matches[0].length, 16);
    for (const secret of [phrase, target, reference]) assert.ok(!report.includes(secret));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local CLI passes a twelve-character overlap and fails closed on missing input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ash-originality-'));
  try {
    const target = join(dir, 'target.md');
    const reference = join(dir, 'reference.md');
    writeFileSync(target, 'abcdefghijkl');
    writeFileSync(reference, 'abcdefghijkl');
    const pass = spawnSync(process.execPath, ['tools/originality.mjs', '--target', target, '--reference', reference], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(pass.status, 0);
    assert.equal(JSON.parse(pass.stdout).match_count, 0);
    const missing = spawnSync(process.execPath, ['tools/originality.mjs', '--target', target, '--reference', join(dir, 'absent.md')], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.ok(!missing.stderr.includes(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('private sidecar maps opaque IDs to paths and paragraph start lines only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ash-originality-'));
  try {
    const target = join(dir, 'target.md');
    const reference = join(dir, 'reference.md');
    const output = join(dir, 'summary.json');
    const mapping = join(dir, 'private-map.json');
    writeFileSync(target, 'short\n\nabcdefghijklmnop');
    writeFileSync(reference, 'header\n\nabcdefghijklmnop');
    const run = spawnSync(process.execPath, ['tools/originality.mjs', '--target', target, '--reference', reference, '--output', output, '--private-map', mapping], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(run.status, 1);
    const summary = readFileSync(output, 'utf8');
    const sidecar = JSON.parse(readFileSync(mapping, 'utf8'));
    assert.ok(!summary.includes(target) && !summary.includes(reference));
    assert.equal(sidecar.matches[0].target_line, 3);
    assert.equal(sidecar.matches[0].reference_line, 3);
    assert.ok(sidecar.files.some(file => file.path === reference));
    assert.ok(!JSON.stringify(sidecar).includes('abcdefghijklmnop'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a whitespace-free code span is a machine name and does not count; a span with spaces still counts', () => {
  assert.equal(normalizeParagraph('看 `calendar.search` 是否可用').length, 5);
  assert.equal(normalizeParagraph('`do not copy this prose`').length, 'donotcopythisprose'.length);
});
