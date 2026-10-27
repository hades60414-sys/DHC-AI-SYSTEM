// Rewrites the old host's absolute paths to the TAS (srv-main) layout in text files.
//   node tas-rewrite.cjs [--apply] <root> [<root>...]
// Without --apply it only reports what would change. Each mapping is matched as C:\x, C:/x, C:\\x (JSON) and /c/x (bash),
// in UTF-8 and, for the paths with Chinese, Big5 bytes too. Files still containing "olduser" afterwards are listed.
const fs = require('fs');
const path = require('path');

const MAP = [
  ['C:\\Users\\olduser\\Desktop\\Claude Code專案', 'D:\\TAS\\Claude Code專案'],
  ['C:\\Users\\olduser\\cc-hosts', 'D:\\TAS\\cc-hosts'],
  ['C:\\Users\\olduser\\cc-host', 'D:\\TAS\\cc-host'],
  ['C:\\Users\\olduser\\cc-web', 'D:\\TAS\\cc-web'],
  ['C:\\Users\\olduser\\ai-tools', 'D:\\TAS\\ai-tools'],
  ['C:\\Program Files\\nodejs\\node.exe', 'D:\\TAS\\node\\node.exe'],
  ['C:\\Users\\olduser', 'C:\\Users\\demo'],
  // Claude Code project slugs (session and memory folder names)
  ['C--Users-olduser-Desktop-Claude-Code--', 'D--TAS-Claude-Code--'],
  ['C--Users-olduser-', 'C--Users-demo-'],
];
const TEXT = /\.(cmd|bat|ps1|psm1|vbs|js|cjs|mjs|ts|json|md|toml|txt|env|xml|ya?ml|ini|cfg|sh)$|(^|[\\/])\.env$/i;
const SKIP_DIR = /^(node_modules|\.git|dist|dist-.*|clone-dist.*|stage-.*|_session_archive|\.tas-pack|backups|file-history|shell-snapshots|projects)$/i;
const SKIP_FILE = /\.(log|jsonl)$|\.bak-|\.bak$/i;

// Big5 bytes for the only non-ASCII characters in MAP ("專案").
const big5 = (s) => {
  const parts = s.split(/(專案)/);
  return Buffer.concat(parts.map((p) => (p === '專案' ? Buffer.from([0xb1, 0x4d, 0xae, 0xd7]) : Buffer.from(p, 'latin1'))));
};
const forms = (p) => {
  const fwd = p.replace(/\\/g, '/');
  return [p, fwd, p.replace(/\\/g, '\\\\'), '/' + fwd[0].toLowerCase() + fwd.slice(2)];
};
const PAIRS = [];
for (const [from, to] of MAP) {
  const f = forms(from), t = forms(to);
  for (let i = 0; i < f.length; i++) {
    PAIRS.push([Buffer.from(f[i], 'utf8'), Buffer.from(t[i], 'utf8')]);
    if (/專案/.test(from)) PAIRS.push([big5(f[i]), big5(t[i])]);
  }
}

function replaceAll(buf) {
  let n = 0;
  for (const [a, b] of PAIRS) {
    let i = buf.indexOf(a);
    if (i < 0) continue;
    const out = [];
    let last = 0;
    while (i >= 0) { out.push(buf.subarray(last, i), b); last = i + a.length; n++; i = buf.indexOf(a, last); }
    out.push(buf.subarray(last));
    buf = Buffer.concat(out);
  }
  return [buf, n];
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) yield* walk(p); }
    else if (e.isFile() && TEXT.test(e.name) && !SKIP_FILE.test(e.name)) yield p;
  }
}

const apply = process.argv.includes('--apply');
const roots = process.argv.slice(2).filter((a) => a !== '--apply');
let files = 0, hits = 0;
const left = [], utf16 = [];
for (const root of roots) {
  const list = fs.statSync(root).isDirectory() ? walk(root) : [root];
  for (const f of list) {
    const buf = fs.readFileSync(f);
    if (buf.includes(Buffer.from('b\0l\0p\0t\0w\0', 'latin1'))) { utf16.push(f); continue; }
    const [out, n] = replaceAll(buf);
    if (n) { files++; hits += n; if (apply) fs.writeFileSync(f, out); else console.log(`${n}\t${f}`); }
    if (out.includes(Buffer.from('olduser'))) left.push(f);
  }
}
console.log(JSON.stringify({ apply, files, replacements: hits, stillHasOlduser: left.length, utf16: utf16.length }));
if (left.length) console.log('STILL olduser:\n' + left.slice(0, 40).join('\n'));
if (utf16.length) console.log('UTF-16 (not changed):\n' + utf16.join('\n'));
