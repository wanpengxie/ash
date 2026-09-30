import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMIT = 12;
const WINDOW = LIMIT + 1;
const CONTENT_EXTENSIONS = /\.(?:md|txt|json|ya?ml)$/i;

/** Count Unicode letters and numbers, one code point each. Formatting does not count. */
export function normalizeParagraph(text) {
  return Array.from(text.normalize('NFKC').toLowerCase()).filter(char => /[\p{L}\p{N}]/u.test(char));
}

function paragraphLines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const records = [];
  let first = 1;
  let block = [];
  const flush = () => {
    const chars = normalizeParagraph(block.join('\n'));
    if (chars.length >= WINDOW) records.push({ line: first, chars });
    block = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (/^[\t ]*$/.test(lines[i])) {
      if (block.length) flush();
    } else {
      if (!block.length) first = i + 1;
      block.push(lines[i]);
    }
  }
  if (block.length) flush();
  return records;
}

function opaqueId(path, salt) {
  return createHash('sha256').update(salt).update('\0').update(path).digest('hex').slice(0, 16);
}

/** Inputs are {path,text}; output never contains text or paths. */
export function compareDocuments(targets, references, salt = randomBytes(16)) {
  if (!targets.length || !references.length) throw new Error('target and reference must each contain text files');
  const index = new Map();
  let targetParagraphs = 0;
  let referenceParagraphs = 0;
  const prepared = targets.map(doc => ({ id: opaqueId(doc.path, salt), paragraphs: paragraphLines(doc.text) }));
  for (const doc of prepared) {
    for (let paragraph = 0; paragraph < doc.paragraphs.length; paragraph++) {
      targetParagraphs++;
      const chars = doc.paragraphs[paragraph].chars;
      for (let start = 0; start <= chars.length - WINDOW; start++) {
        const gram = chars.slice(start, start + WINDOW).join('');
        const entries = index.get(gram) ?? [];
        entries.push({ doc, paragraph, start });
        index.set(gram, entries);
      }
    }
  }
  const matches = [];
  const seen = new Set();
  for (const ref of references) {
    const refId = opaqueId(ref.path, salt);
    const blocks = paragraphLines(ref.text);
    referenceParagraphs += blocks.length;
    for (let paragraph = 0; paragraph < blocks.length; paragraph++) {
      const right = blocks[paragraph].chars;
      for (let at = 0; at <= right.length - WINDOW; at++) {
        const gram = right.slice(at, at + WINDOW).join('');
        for (const hit of index.get(gram) ?? []) {
          const left = hit.doc.paragraphs[hit.paragraph].chars;
          let a = hit.start;
          let b = at;
          let endA = a + WINDOW;
          let endB = b + WINDOW;
          while (a > 0 && b > 0 && left[a - 1] === right[b - 1]) { a--; b--; }
          while (endA < left.length && endB < right.length && left[endA] === right[endB]) { endA++; endB++; }
          const key = [hit.doc.id, hit.paragraph, a, endA, refId, paragraph, b, endB].join(':');
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push({ target_id: hit.doc.id, target_paragraph: hit.paragraph + 1, reference_id: refId, reference_paragraph: paragraph + 1, length: endA - a });
        }
      }
    }
  }
  matches.sort((a, b) => b.length - a.length || a.target_id.localeCompare(b.target_id));
  return { threshold: LIMIT, counting: 'NFKC lowercase Unicode letters and numbers; whitespace and punctuation omitted; no cross-paragraph matches', target_files: targets.length, reference_files: references.length, target_paragraphs: targetParagraphs, reference_paragraphs: referenceParagraphs, match_count: matches.length, matches };
}

function privateMap(targets, references, salt, result) {
  const entries = [...targets.map(doc => ({ kind: 'target', ...doc })), ...references.map(doc => ({ kind: 'reference', ...doc }))];
  const matchedIds = new Set(result.matches.flatMap(match => [match.target_id, match.reference_id]));
  const files = entries.filter(doc => matchedIds.has(opaqueId(doc.path, salt))).map(doc => ({ kind: doc.kind, id: opaqueId(doc.path, salt), path: doc.path, paragraph_start_lines: paragraphLines(doc.text).map(block => block.line) }));
  return { files, matches: result.matches.map(match => ({
    target_id: match.target_id,
    target_line: files.find(file => file.id === match.target_id).paragraph_start_lines[match.target_paragraph - 1],
    reference_id: match.reference_id,
    reference_line: files.find(file => file.id === match.reference_id).paragraph_start_lines[match.reference_paragraph - 1],
    length: match.length,
  })) };
}

function textFiles(roots) {
  const files = [];
  const visit = path => {
    if (!existsSync(path)) throw new Error('input path does not exist');
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() && ['.git', 'node_modules', 'build', 'dist'].includes(entry.name)) continue;
        if (entry.isSymbolicLink()) continue;
        visit(join(path, entry.name));
      }
    } else if (stat.isFile() && CONTENT_EXTENSIONS.test(basename(path))) {
      const buffer = readFileSync(path);
      if (!buffer.includes(0)) files.push({ path: resolve(path), text: buffer.toString('utf8') });
    }
  };
  for (const root of roots) visit(root);
  return files;
}

function termPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'iu');
}

export function scanPublicTerms(files, terms, salt = randomBytes(16)) {
  if (!terms?.length) throw new Error('private terms are required');
  if (!files.length) throw new Error('public repository has no text files to scan');
  const findings = [];
  for (const file of files) {
    for (let i = 0; i < terms.length; i++) {
      if (termPattern(terms[i]).test(file.path) || termPattern(terms[i]).test(file.text)) findings.push({ file_id: opaqueId(file.path, salt), term_id: i + 1 });
    }
  }
  return { scanned_files: files.length, finding_count: findings.length, findings };
}

function trackedPublicFiles(root) {
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
  return names.flatMap(name => {
    if (lstatSync(join(root, name)).isSymbolicLink()) return [{ path: name, text: readlinkSync(join(root, name)) }];
    const buffer = readFileSync(join(root, name));
    return buffer.includes(0) ? [] : [{ path: name, text: buffer.toString('utf8') }];
  });
}

function parseArgs(args) {
  const opts = { targets: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--target') opts.targets.push(args[++i]);
    else if (arg === '--reference') opts.reference = args[++i];
    else if (arg === '--output') opts.output = args[++i];
    else if (arg === '--terms-file') opts.termsFile = args[++i];
    else if (arg === '--private-map') opts.privateMap = args[++i];
    else if (arg === '--ci-terms') opts.ciTerms = true;
    else throw new Error('unknown argument');
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  let result;
  if (opts.ciTerms) {
    if (opts.reference || opts.targets.length || opts.privateMap) throw new Error('CI term scan cannot use references, targets, or private mapping');
    const input = opts.termsFile ? readFileSync(opts.termsFile, 'utf8') : process.env.ASH_PRIVATE_TERMS;
    const terms = input?.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    result = scanPublicTerms(trackedPublicFiles(root), terms);
  } else {
    if (!opts.reference || !opts.targets.length) throw new Error('local comparison requires --reference and at least one --target');
    const targets = textFiles(opts.targets);
    const references = textFiles([opts.reference]);
    const salt = randomBytes(16);
    result = compareDocuments(targets, references, salt);
    if (opts.privateMap) {
      if (!opts.output || resolve(opts.privateMap) === resolve(opts.output)) throw new Error('private map requires a distinct summary output');
      writeFileSync(opts.privateMap, JSON.stringify(privateMap(targets, references, salt, result), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
  }
  const json = JSON.stringify(result, null, 2) + '\n';
  if (opts.output) writeFileSync(opts.output, json);
  else process.stdout.write(json);
  if ((result.match_count ?? result.finding_count) > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('originality check could not complete; verify inputs and repository state\n'); process.exitCode = 2; });
}
