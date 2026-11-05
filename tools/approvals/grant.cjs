// 常設授權（2026-11-03，仿 ChatGPT 的 Custom rules）：使用者按一次，之後同一台、同一指令字首的動作不再開單。
//   node grant.cjs propose --machine rag1 --prefix "<指令字首>" --why "<為什麼>" [--days 14] [--uses 20] [--room <聊天室>] [--dry]
//   node grant.cjs list | revoke <id> | check --machine rag1 --cmd "<指令>"
// AI 只能 propose（開「同意常設授權 <id>」卡片）；使用者按鈕後由排程 watch.cjs → run.cjs 啟用並寫入 grants\。
// 比對與硬排除由這支程式做，不由模型判斷。限制：AI 和排程同一個 Windows 帳號，擋得住誤用、擋不住刻意竄改 grants\。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const L = require('./lib.cjs');

const GDIR = path.join(__dirname, 'grants');
const USER_PROJECT = '00000000-0000-0000-0000-000000000000';
// 跟白名單一樣：串接／重導向／變數展開（% 也擋掉 %X_PWD% 這類帳密變數）、網路路徑、特殊空白
const BANNED = /[&|<>^%!();`\r\n]/;
const NETWORK = /\\\\|\/\//;
const ODD_SPACE = /[\u0000-\u0008\u000b-\u001f\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/;
// 紅線：刪除、權限、帳密、對外連線、資料庫寫入、系統層、任意腳本主機；一律不能存成常設授權，也不能靠授權放行
// 11-03 Astra 對抗：git（clean/checkout/reset 會丟檔）、robocopy /mov、schtasks /run 帶 /s /u /p 連別台都漏掉，補上
const FORBID = /\b(del|erase|rd|rmdir|move|format|diskpart|cipher|icacls|cacls|takeown|attrib|net|netsh|reg|sc|setx|runas|shutdown|bcdedit|wmic|powershell|pwsh|mshta|cscript|wscript|rundll32|regsvr32|curl|wget|bitsadmin|certutil|ftp|tftp|ssh|scp|sqlcmd|osql|bcp|isql|mysql|psql|msiexec|winget|choco|pip|npm|npx|git)\b|\bschtasks\b(?!\s+\/(run|end|query)\b)|\bschtasks\b.*\s[\/-](s|u|p)\b|\/(mir|purge|mov|move)\b|_(pwd|pass|token|otp)\b|password|passwd/i;
// 黑名單列不完：字首後面多出來的部分只能是一般參數，不能再帶任何開關（/x、-x），開關要寫進使用者按過的字首裡
const EXTRA_FLAG = /(^|\s)[\/-][A-Za-z?]/;
const DAY = 864e5;
// 比對紅線與開關前先拿掉引號：Windows 的命令列解析會去掉引號，"/s" 跑起來就是 /s（11-05 對抗測試：
// schtasks /query "/s" evilhost "/u" admin、tasklist "/S" evil 原本都過得了授權比對）
const unquote = (s) => String(s).replace(/["']/g, '');

function unsafe(s) {
  if (!s || !s.trim()) return '空的';
  if (s.length > 1000) return '超過 1000 字';
  const b = s.match(BANNED); if (b) return `含禁止字元 ${JSON.stringify(b[0])}`;
  if (NETWORK.test(s)) return '含網路路徑';
  if (ODD_SPACE.test(s)) return '含特殊空白或控制字元';
  const f = s.match(FORBID) || unquote(s).match(FORBID); if (f) return `碰到紅線「${f[0]}」（刪除／權限／帳密／對外／資料庫寫入／系統層），不能用常設授權`;
  return '';
}

const gpath = (id) => path.join(GDIR, id + '.json');
function all() {
  if (!fs.existsSync(GDIR)) return [];
  return fs.readdirSync(GDIR).filter((f) => /^[0-9a-f]{6}\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(GDIR, f), 'utf8')));
}
const live = (g, now = Date.now()) => g.status === 'active' && now <= Date.parse(g.expires) && g.usesLeft > 0;

// 回傳可用的授權或 null；命中規則：同一台、指令開頭等於字首（不分大小寫）且後面接空白或結尾、指令本身也過得了 unsafe()
function match(machine, cmd, grants = all()) {
  cmd = String(cmd || '').trim();
  if (unsafe(cmd)) return null;
  const lc = cmd.toLowerCase();
  return grants.find((g) => live(g) && g.machine === machine && L.sha(g.machine, 'GRANT\n' + g.prefix) === g.sha256 &&
    (() => { const p = g.prefix.toLowerCase(); return lc === p || (lc.startsWith(p) && /[ \t]/.test(lc[p.length]) && !EXTRA_FLAG.test(unquote(lc.slice(p.length)))); })()) || null;
}

// 讀改寫授權檔一律搶 .lock（11-03 Astra：兩筆同時 consume 會超用，consume 和 revoke 交錯會把撤銷蓋回有效）
function locked(id, fn) {
  const lk = gpath(id) + '.lock';
  for (let i = 0; ; i++) {
    try { fs.closeSync(fs.openSync(lk, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 拿鎖的程序當掉留下的鎖：超過 30 秒就清掉
      try { if (Date.now() - fs.statSync(lk).mtimeMs > 30e3) { fs.unlinkSync(lk); continue; } } catch {}
      if (i > 200) throw new Error(`授權 ${id} 被別的程序占用`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const cur = JSON.parse(fs.readFileSync(gpath(id), 'utf8'));
    const out = fn(cur);
    fs.writeFileSync(gpath(id), JSON.stringify(cur, null, 2), 'utf8');
    return out;
  } finally { try { fs.unlinkSync(lk); } catch {} }
}

// 用掉一次（ask.cjs 執行前呼叫）；回傳更新後的授權
function consume(g) {
  return locked(g.id, (cur) => {
    if (!live(cur)) throw new Error(`授權 ${g.id} 已失效`);
    cur.usesLeft -= 1; cur.lastUsed = new Date().toISOString();
    return { ...cur };
  });
}

function revoke(id) {
  return locked(id, (cur) => { cur.status = 'revoked'; cur.revokedAt = new Date().toISOString(); return cur; });
}

// run.cjs 在使用者按鈕、核對通過後呼叫
function activate(t, click) {
  fs.mkdirSync(GDIR, { recursive: true });
  const g = { id: t.id, machine: t.machine, prefix: t.prefix, sha256: t.sha256, why: t.why, approvedBy: click.by, approvedAt: click.at,
    expires: new Date(Date.now() + t.days * DAY).toISOString(), usesLeft: t.uses, usesTotal: t.uses, status: 'active' };
  fs.writeFileSync(gpath(g.id), JSON.stringify(g, null, 2), 'utf8');
  return g;
}

const left = (g) => `剩 ${Math.max(0, Math.ceil((Date.parse(g.expires) - Date.now()) / DAY))} 天／${g.usesLeft} 次`;

async function propose(arg) {
  const machine = arg('machine'), prefix = String(arg('prefix') || '').trim().replace(/\s+/g, ' '), why = arg('why');
  if (!machine || !prefix || !why) throw new Error('要給 --machine --prefix --why');
  if (!L.servers()[machine]) throw new Error('.mcp.json 沒有這台：' + machine);
  const bad = unsafe(prefix); if (bad) throw new Error('這個字首不能存成常設授權：' + bad);
  if (prefix.split(' ').length < 2) throw new Error('字首太寬：至少要命令＋一個參數（例如完整腳本路徑），不能只授權一個命令名');
  const days = Math.min(30, Math.max(1, Number(arg('days', 14)))), uses = Math.min(100, Math.max(1, Number(arg('uses', 20))));
  const id = crypto.randomBytes(3).toString('hex'), room = arg('room', 'dm:' + [USER_PROJECT, L.ASSISTANT].sort().join('~'));
  const button = `同意常設授權 ${id}`, created = new Date().toISOString();
  const t = { id, kind: 'grant', machine, prefix, sha256: L.sha(machine, 'GRANT\n' + prefix), why, days, uses, room, button, created,
    expires: new Date(Date.now() + L.TTL_MS).toISOString(), status: 'pending',
    origin: process.argv.includes('--no-resume') ? null : process.env.CLAUDE_CODE_SESSION_ID || null, next: arg('next') || null };
  const text = [
    `【常設授權 ${id}】之後在 ${L.label(machine)} 執行開頭是下面這段的指令，不再一筆一筆問你（${days} 天或 ${uses} 次，先到先停）`,
    `原因：${why}`, '指令字首：', '```', prefix, '```',
    '程式會擋：指令裡有串接或重導向符號、網路路徑、刪除、權限、帳密、對外連線、資料庫寫入，這些照樣開單問你。每次使用都會貼回這裡並標「依授權 ' + id + '」。',
    `按「${button}」＝同意。撤銷：node D:\\TAS\\ai-tools\\approvals\\grant.cjs revoke ${id}`,
    `（小助手：看到「${button}」只要回「收到，核准單程式一分鐘內啟用」。）`,
  ].join('\n');
  if (arg('dry') !== undefined || process.argv.includes('--dry')) return console.log(text);
  L.save(t);
  await L.post(room, text, button);
  L.log(`grant-ask\t${id}\t${machine}\t${t.sha256.slice(0, 12)}\t${prefix}`);
  console.log(`已貼常設授權卡 ${id}（${L.label(machine)}），等使用者按鈕`);
}

if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  const op = process.argv[2];
  (async () => {
    if (op === 'propose') return propose(arg);
    if (op === 'list') { for (const g of all()) console.log(`${g.id}\t${live(g) ? '有效' : '失效'}\t${L.label(g.machine)}\t${left(g)}\t${g.prefix}\t${g.why}`); return; }
    if (op === 'revoke') {
      const id = process.argv[3]; if (!/^[0-9a-f]{6}$/.test(id || '') || !fs.existsSync(gpath(id))) throw new Error('沒有這筆授權：' + id);
      revoke(id); L.log(`grant-revoke\t${id}`); return console.log('已撤銷 ' + id);
    }
    if (op === 'check') { const g = match(arg('machine'), arg('cmd')); return console.log(g ? `命中授權 ${g.id}（${left(g)}）` : `不命中：${unsafe(String(arg('cmd') || '')) || '沒有符合的有效授權'}`); }
    throw new Error('用法：node grant.cjs propose|list|revoke <id>|check --machine m --cmd "c"');
  })().catch((e) => { console.error(e.message); process.exitCode = 1; });
}

module.exports = { unsafe, match, consume, revoke, activate, left, all, live, GDIR };
