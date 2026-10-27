#!/usr/bin/env node
// Collision check for delegated writers. Works without git.
//   node owned-diff.cjs snap  <root> <snap.json>
//       Record size + sha256 of every file under <root> (skips .git, node_modules).
//   node owned-diff.cjs check <root> <snap.json> <owned-glob> [<owned-glob>...]
//       List files added, changed, or deleted since the snapshot. Exit 1 if any lies outside the owned globs.
//       Globs are relative to <root>, use /, and support * (one segment) and ** (any depth).
// Take one snapshot before dispatch; run check per worker with that worker's ownership list.
// Several workers on one snapshot: pass the union of the other workers' globs with --also so their files are not flagged.
//   node owned-diff.cjs check <root> <snap.json> <mine...> --also <others...>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKIP = new Set(['.git', 'node_modules']);

function scan(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const rel = path.relative(root, p).split(path.sep).join('/');
        out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      }
    }
  };
  walk(root);
  return out;
}

function toRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

const [cmd, root, snapFile, ...rest] = process.argv.slice(2);
if (cmd === 'snap' && root && snapFile) {
  const files = scan(root);
  fs.writeFileSync(snapFile, JSON.stringify({ root: path.resolve(root), at: new Date().toISOString(), files }));
  console.log(`snapshot ${Object.keys(files).length} files -> ${snapFile}`);
} else if (cmd === 'check' && root && snapFile && rest.length) {
  const cut = rest.indexOf('--also');
  const mine = (cut < 0 ? rest : rest.slice(0, cut)).map(toRegex);
  const also = (cut < 0 ? [] : rest.slice(cut + 1)).map(toRegex);
  const before = JSON.parse(fs.readFileSync(snapFile, 'utf8')).files;
  const now = scan(root);
  const touched = [];
  for (const [f, h] of Object.entries(now)) if (before[f] !== h) touched.push([before[f] ? 'changed' : 'added', f]);
  for (const f of Object.keys(before)) if (!(f in now)) touched.push(['deleted', f]);
  let bad = 0;
  for (const [kind, f] of touched.sort((a, b) => a[1].localeCompare(b[1]))) {
    const tag = mine.some((r) => r.test(f)) ? 'owned' : also.some((r) => r.test(f)) ? 'other-worker' : 'OUTSIDE';
    if (tag === 'OUTSIDE') bad++;
    console.log(`${tag}\t${kind}\t${f}`);
  }
  console.log(`${touched.length} touched, ${bad} outside ownership`);
  process.exit(bad ? 1 : 0);
} else {
  console.error('usage: owned-diff.cjs snap <root> <snap.json> | check <root> <snap.json> <glob...> [--also <glob...>]');
  process.exit(2);
}
