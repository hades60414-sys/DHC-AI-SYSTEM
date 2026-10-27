// Log rotation for cc-web / cc-hosts logs. Run daily from morning-check.ps1 (06:00).
// A log over MAX bytes (default 5 MB) is COPIED to <name>.<yyyyMMdd>.old and then truncated in place
// (a running process may hold the file open on Windows, so rename is not safe). Keeps 3 .old per log.
// Never touches names matching SKIP (credentials / vault / tokens / env / databases).
// Usage: node log-rotate.cjs [--dry] [--max <bytes>] [--dirs "dir1;dir2"]   Log: D:/TAS/cc-web/log-rotate.log
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const DRY = args.includes('--dry');
const MAX = Number(opt('--max') || 5 * 1024 * 1024);
const KEEP = 3;
const DIRS = (opt('--dirs') || 'D:/TAS/cc-web;D:/TAS/cc-web/deid-proxy;D:/TAS/cc-web/probe;D:/TAS/cc-hosts').split(';');
const SKIP = /vault|token|cred|secret|passw|\.env|auth|\.db/i;
const LOGFILE = 'D:/TAS/cc-web/log-rotate.log';
const log = (m) => { const l = `${new Date().toISOString()} ${DRY ? '[dry] ' : ''}${m}`; console.log(l); try { fs.appendFileSync(LOGFILE, l + '\n'); } catch {} };

const d = new Date();
const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

for (const dir of DIRS) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { log(`skip dir ${dir}: ${e.message}`); continue; }
  for (const name of names) {
    if (!/\.(log|jsonl)$/i.test(name) || SKIP.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size <= MAX) continue;
      const dest = `${file}.${ymd}.old`;
      if (fs.existsSync(dest)) { log(`skip ${file}: ${dest} already exists`); continue; }
      if (DRY) { log(`would rotate ${file} (${st.size} bytes) -> ${dest}`); continue; }
      fs.copyFileSync(file, dest);
      if (fs.statSync(dest).size !== st.size && fs.statSync(dest).size < st.size) throw new Error('copy shorter than source, not truncating');
      fs.truncateSync(file, 0);
      log(`rotated ${file} (${st.size} bytes) -> ${dest}`);
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const olds = fs.readdirSync(dir).filter((f) => new RegExp(`^${escaped}\\.\\d{8}\\.old$`).test(f)).sort();
      for (const f of olds.slice(0, Math.max(0, olds.length - KEEP))) { fs.unlinkSync(path.join(dir, f)); log(`pruned ${path.join(dir, f)}`); }
    } catch (e) {
      log(`FAILED ${file}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
