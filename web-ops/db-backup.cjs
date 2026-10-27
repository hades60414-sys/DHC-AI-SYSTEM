// Nightly consistent copy of CloudCLI main DB (VACUUM INTO) -> backups\auth-YYYYMMDD.db, keep newest 14.
// Only files matching /^auth-\d{8}\.db$/ in backups\ are ever pruned. Log: backups\db-backup.log
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SRC = 'D:/TAS/cc-web/data/auth.db';
const DIR = 'D:/TAS/cc-web/backups';
const KEEP = 14;
const LOG = path.join(DIR, 'db-backup.log');
const log = (m) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

try {
  fs.mkdirSync(DIR, { recursive: true });
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const dest = path.join(DIR, `auth-${ymd}.db`);
  const tmp = dest + '.tmp';
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  const db = new DatabaseSync(SRC, { readOnly: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  db.close();
  // verify the copy opens and integrity is ok before replacing today's file
  const chk = new DatabaseSync(tmp, { readOnly: true });
  const ok = chk.prepare('pragma integrity_check').get().integrity_check;
  chk.close();
  if (ok !== 'ok') throw new Error('integrity_check: ' + ok);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  fs.renameSync(tmp, dest);
  log(`OK ${dest} ${fs.statSync(dest).size} bytes`);
  const olds = fs.readdirSync(DIR).filter((f) => /^auth-\d{8}\.db$/.test(f)).sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - KEEP))) {
    fs.unlinkSync(path.join(DIR, f));
    log(`PRUNED ${f}`);
  }
} catch (e) {
  try { log(`FAIL ${e.message}`); } catch {}
  process.exitCode = 1;
}
