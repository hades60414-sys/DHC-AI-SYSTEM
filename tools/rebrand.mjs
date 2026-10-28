#!/usr/bin/env node
// Rename a short brand word across the repo (strings, storage keys, event names, CSS ids, comments),
// keeping its case: FOO -> BAR, foo -> bar, Foo -> Bar. Matches whole words only, plus camelCase
// parts ("useFooStore") and acronym runs ("FOOCLI"), never inside ordinary words.
//
// Usage: node tools/rebrand.mjs <from> <to> [--dry]

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = [/^node_modules\//, /^dist\//, /^dist-server\//, /^public\/excalidraw\//, /^package-lock\.json$/, /^CHANGELOG\.md$/, /^tools\//];

const isLetter = (c) => /[A-Za-z]/.test(c || '');
const isUpper = (c) => /[A-Z]/.test(c || '');
const isLower = (c) => /[a-z]/.test(c || '');

// Same boundary rule as tools/scan-sensitive.mjs.
function boundaryOk(text, start, end) {
  const left = text[start - 1];
  const right = text[end];
  const leftOk = !isLetter(left) || (isLower(left) && isUpper(text[start]));
  const rightOk = !isLetter(right) || isUpper(right) || (isLower(text[end - 1]) && isUpper(right));
  return leftOk && rightOk;
}

function keepCase(match, to) {
  if (match === match.toUpperCase()) return to.toUpperCase();
  if (match === match.toLowerCase()) return to.toLowerCase();
  return to[0].toUpperCase() + to.slice(1).toLowerCase();
}

const [from, to] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!from || !to || !/^[A-Za-z]+$/.test(from)) {
  console.error('Usage: node tools/rebrand.mjs <from> <to> [--dry]');
  process.exit(2);
}
const dry = process.argv.includes('--dry');
const re = new RegExp(from, 'gi');

const files = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((f) => !SKIP.some((skip) => skip.test(f)));

let changed = 0;
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  let stat;
  try { stat = statSync(abs); } catch { continue; }
  if (!stat.isFile()) continue;
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) continue;
  const before = buf.toString('utf8');
  const after = before.replace(re, (match, offset) => (boundaryOk(before, offset, offset + match.length) ? keepCase(match, to) : match));
  if (after !== before) {
    changed += 1;
    if (!dry) writeFileSync(abs, after);
    console.log(rel);
  }
}
console.error(`[rebrand] ${changed} file(s) ${dry ? 'would change' : 'changed'}.`);
