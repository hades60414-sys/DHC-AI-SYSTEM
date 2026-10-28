#!/usr/bin/env node
// Scan the repo for personal / company traces before publishing.
//
// Usage: node tools/scan-sensitive.mjs [--summary]
// Prints "file:line:hit" for every match and exits 1 when anything is found.
//
// Built-in rules are generic (user paths, private IPs, ".NN" host codes,
// emails, key-like strings). Organisation-specific words live in
// tools/scan-sensitive.local.json (git-ignored, so the deny list itself is
// never published). See tools/scan-sensitive.example.json for the format.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'tools/scan-sensitive.mjs';
const LOCAL_TERMS = 'tools/scan-sensitive.local.json';

const EXCLUDED_DIRS = ['node_modules/', 'dist/', 'dist-server/', 'public/excalidraw/'];
const EXCLUDED_FILES = new Set(['package-lock.json', SELF, LOCAL_TERMS]);

// Placeholder user names that are fine to publish (upstream tests use several of these).
const ALLOWED_USER_NAMES = new Set(['demo', 'public', 'default', 'username', '%username%', 'user', 'you', 'yourname', 'x', 'test', 'dev', 'victim', '...']);
const ALLOWED_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net', 'anthropic.com', 'users.noreply.github.com', 'github.com', 'cloudcli.ai'];

function listFiles() {
  const run = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const files = new Set([
    ...run(['-c', 'core.quotepath=off', 'ls-files']),
    ...run(['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard']),
  ]);
  return [...files].filter((f) =>
    !EXCLUDED_DIRS.some((d) => f.startsWith(d) || f.includes(`/${d}`))
    && !EXCLUDED_FILES.has(f)
    && !EXCLUDED_FILES.has(path.posix.basename(f)));
}

function loadLocalTerms() {
  const file = path.join(ROOT, LOCAL_TERMS);
  if (!existsSync(file)) {
    console.error(`[scan-sensitive] ${LOCAL_TERMS} not found; only generic rules are active.`);
    return [];
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(parsed.terms) ? parsed.terms.filter((t) => typeof t === 'string' && t.trim()) : [];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isLetter = (c) => /[A-Za-z]/.test(c || '');
const isUpper = (c) => /[A-Z]/.test(c || '');
const isLower = (c) => /[a-z]/.test(c || '');

// Short ASCII words (TSS, BSC ...) must not match inside ordinary words such as
// "obscure", but should match "tss.key", "TSSCLI" and camelCase "useTssStore".
function asciiWordBoundaryOk(line, start, end) {
  const left = line[start - 1];
  const right = line[end];
  const first = line[start];
  const last = line[end - 1];
  const leftOk = !isLetter(left) || (isLower(left) && isUpper(first));
  const rightOk = !isLetter(right) || isUpper(right) || (isLower(last) && isUpper(right));
  return leftOk && rightOk;
}

// True when the match sits inside a long base64 run (embedded images, hashes).
function insideBase64Run(line, start, end) {
  let a = start;
  let b = end;
  while (a > 0 && /[A-Za-z0-9+/]/.test(line[a - 1])) a -= 1;
  while (b < line.length && /[A-Za-z0-9+/]/.test(line[b])) b += 1;
  return b - a >= 40;
}

function buildTermRules(terms) {
  return terms.map((term) => {
    const ascii = /^[\x20-\x7e]+$/.test(term);
    const re = new RegExp(escapeRe(term), 'gi');
    const needsBoundary = ascii && /^[A-Za-z]+$/.test(term) && term.length <= 6;
    return {
      name: `term:${term}`,
      re,
      check: (line, m) => {
        const end = m.index + m[0].length;
        if (ascii && insideBase64Run(line, m.index, end)) return false;
        return !needsBoundary || asciiWordBoundaryOk(line, m.index, end);
      },
    };
  });
}

const userNameOk = (name) => !ALLOWED_USER_NAMES.has(name.toLowerCase()) && !name.startsWith('$') && !name.startsWith('<');

const GENERIC_RULES = [
  {
    name: 'win-user-path',
    re: /[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)([^\\/"'`\s,;:)]+)/gi,
    check: (_line, m) => userNameOk(m[1]),
  },
  {
    name: 'posix-c-user-path',
    re: /\/c\/Users\/([^/"'`\s,;:)]+)/gi,
    check: (_line, m) => userNameOk(m[1]),
  },
  {
    name: 'private-ip',
    re: /(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?![\d.])/g,
    check: null,
  },
  {
    // Host shorthand such as ".41" or ".120": a dot with 2-3 digits that is not
    // part of a version number / decimal and not followed by a unit or word.
    name: 'host-code',
    re: /(?<![\w.\])])\.(\d{2,3})(?![\w.%])/g,
    check: (line, m) => {
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + m[0].length);
      // Numeric literals: `opacity: .75`, `opacity=".72"`, SVG paths `0 0 .34 1.88`, CSS `0\.98`.
      if (/(?:[:=(,*+\-/<>?\\]\s*["']?|\d\s*)$/.test(before)) return false;
      if (/^\s*-?\d/.test(after)) return false;
      return true;
    },
  },
  {
    name: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    check: (_line, m) => {
      const domain = m[0].split('@')[1].toLowerCase();
      if (ALLOWED_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
      // npm specifiers ("pkg@1.2.3"), test placeholders ("a@x.com"), local hosts.
      if (/^\d/.test(domain) || /^[a-z]\.com$/.test(domain) || domain.endsWith('.local')) return false;
      return true;
    },
  },
  { name: 'key:sk-', re: /\bsk-[A-Za-z0-9_-]{20,}/g, check: null },
  { name: 'key:ghp_', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, check: (_line, m) => !/^gh[pousr]_x+$/i.test(m[0]) },
  {
    name: 'key:long-base64',
    re: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g,
    // Mixed case + digits, not a path, not an embedded PNG, not a UUID-bearing file name.
    check: (_line, m) => /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && /\d/.test(m[0]) && !m[0].includes('/')
      && !m[0].startsWith('iVBORw0KGgo') && !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(m[0]),
  },
];

function isBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i += 1) if (buf[i] === 0) return true;
  return false;
}

function main() {
  const summaryOnly = process.argv.includes('--summary');
  const rules = [...GENERIC_RULES, ...buildTermRules(loadLocalTerms())];
  const counts = new Map();
  let total = 0;

  for (const rel of listFiles()) {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const rule of rules) {
        rule.re.lastIndex = 0;
        for (const m of line.matchAll(rule.re)) {
          if (rule.check && !rule.check(line, m)) continue;
          total += 1;
          counts.set(rule.name, (counts.get(rule.name) || 0) + 1);
          if (!summaryOnly) console.log(`${rel}:${idx + 1}:${m[0]}`);
        }
      }
    });
  }

  if (total > 0) {
    console.error(`\n[scan-sensitive] ${total} hit(s):`);
    for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) console.error(`  ${name}: ${n}`);
    process.exit(1);
  }
  console.error('[scan-sensitive] clean.');
}

main();
