// 免核准白名單：判斷一行 CMD 能不能不開單直接執行；也是白名單的編輯工具（改前自動備份）。
//   node whitelist.cjs list | add "<字首>" | remove "<字首>" | check "<指令>"
// 保守設計：先擋所有串接／重導向／變數展開字元，再比對命令字首（整個字、不分大小寫），sqlcmd 另加 SELECT 檢查。
const fs = require('node:fs'), path = require('node:path');

const FILE = path.join(__dirname, 'whitelist.txt');
const BAK = path.join(__dirname, 'whitelist.bak');
// & | 串接與管線；< > 重導向；^ 跳脫；% ! 變數展開；( ) 區塊；; 分隔；` 和換行
const BANNED = /[&|<>^%!();`\r\n]/;
// \\ 與 // 是網路路徑（會對外連線、送出認證）
const NETWORK = /\\\\|\/\//;
// 寫入、執行、區塊／流程控制（BEGIN…END、WHILE 可在 SELECT 後夾帶別的語句）、會改狀態的讀取（RECEIVE、NEXT VALUE FOR）
const SQL_WRITE = /\b(into|insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|deny|backup|restore|dbcc|shutdown|kill|waitfor|openrowset|opendatasource|openquery|begin|end|while|if|goto|receive|send|next|enable|disable|set|declare|use|go|reconfigure|checkpoint|bulk|writetext|updatetext|raiserror|throw|xp_\w*|sp_\w*)\b/i;
const LOCAL_SQL = /^(\.|localhost|127\.0\.0\.1)(\\\w+)?(,\d+)?$/i;

const readRules = () => fs.readFileSync(FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));

// 依空白切字，雙引號內不切；回傳去掉引號的字
function tokens(cmd) {
  const out = [];
  for (const m of cmd.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// sqlcmd：只收 -Q "<單一 SELECT>"；-i 讀檔、-o 寫檔、-q 互動、-z/-Z 改密碼一律不收
function sqlcmdOk(cmd, toks) {
  if (cmd.split('"').length % 2 === 0) return '引號沒成對';
  if (toks.some((t) => t.startsWith('--'))) return 'sqlcmd 不收 -- 旗標';
  const flags = toks.slice(1).filter((t) => /^[-/]/.test(t)).map((t) => t.slice(1, 2));
  if (flags.some((f) => f !== 'Q' && 'ioqz'.includes(f.toLowerCase()))) return 'sqlcmd 只收 -Q，不收 -i/-o/-q/-z';
  const qi = toks.findIndex((t) => t === '-Q' || t === '/Q');
  if (qi < 0 || toks.filter((t) => t === '-Q' || t === '/Q').length !== 1) return 'sqlcmd 要剛好一個 -Q';
  const q = (toks[qi + 1] || '').trim();
  if (!/^select\b/i.test(q)) return 'sqlcmd -Q 要以 SELECT 開頭';
  if (SQL_WRITE.test(q)) return 'SQL 含寫入或執行關鍵字';
  if (/(\[[^\]]*\]|[\w#@$]+)\s*\.\s*(\[[^\]]*\]|[\w#@$]*)\s*\.\s*(\[[^\]]*\]|[\w#@$]*)\s*\.\s*(\[[^\]]*\]|[\w#@$]+)/.test(q)) return 'SQL 含四段式名稱（連結伺服器）';
  if (/:!!|^\s*:/m.test(q)) return 'SQL 含 sqlcmd 指令';
  // -S 只收本機（.、localhost、127.0.0.1，可帶執行個體名或埠號）
  for (let i = 1; i < toks.length; i++) {
    if (!/^[-/]S/.test(toks[i])) continue;
    const v = toks[i].length > 2 ? toks[i].slice(2) : toks[i + 1] || '';
    if (!LOCAL_SQL.test(v)) return 'sqlcmd -S 只收本機';
  }
  return '';
}

// 回傳 { ok, rule, reason }
function check(cmd, rules = readRules()) {
  cmd = String(cmd || '').trim();
  if (!cmd) return { ok: false, reason: '空指令' };
  if (cmd.length > 1000) return { ok: false, reason: '超過 1000 字' };
  const bad = cmd.match(BANNED);
  if (bad) return { ok: false, reason: `含禁止字元 ${JSON.stringify(bad[0])}（串接／重導向／變數展開）` };
  if (NETWORK.test(cmd)) return { ok: false, reason: '含網路路徑 \\\\ 或 //' };
  // cmd.exe 只把半形空白、Tab 當分隔；其他 Unicode 空白與控制字元會讓兩邊切字不同
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/.test(cmd)) return { ok: false, reason: '含特殊空白或控制字元' };
  // 比對原始字串：字首不去引號、後面一定要接空白或結尾（"dir"\..\x.exe、dir\..、dir.exe 都不算 dir）
  const lc = cmd.toLowerCase();
  const rule = rules.find((r) => { const p = r.toLowerCase().replace(/\s+/g, ' '); return lc === p || (lc.startsWith(p) && /[ \t]/.test(lc[p.length])); });
  if (!rule) return { ok: false, reason: '不在白名單' };
  const toks = tokens(cmd), low = toks.map((t) => t.toLowerCase());
  if (low[0] === 'sqlcmd') { const why = sqlcmdOk(cmd, toks); if (why) return { ok: false, rule, reason: why }; }
  if (low[0] === 'tasklist' && low.some((t) => /^\/[sup]$/.test(t))) return { ok: false, rule, reason: 'tasklist 不收 /s /u /p（連別台）' };
  if (low[0] === 'findstr' && low.some((t) => /^[-/]f:/.test(t))) return { ok: false, rule, reason: 'findstr 不收 /f:（清單檔可能含網路路徑）' };
  return { ok: true, rule, reason: '' };
}

function backup() {
  fs.mkdirSync(BAK, { recursive: true });
  const dst = path.join(BAK, `whitelist-${new Date().toISOString().replace(/[-:]/g, '').replace('.', '_').replace('Z', '')}.txt`);
  fs.copyFileSync(FILE, dst);
  return dst;
}

if (require.main === module) {
  const [op, val] = process.argv.slice(2);
  if (op === 'list') console.log(readRules().join('\n'));
  else if (op === 'check') console.log(JSON.stringify(check(val)));
  else if ((op === 'add' || op === 'remove') && val && val.trim()) {
    const v = val.trim().replace(/\s+/g, ' ');
    if (BANNED.test(v)) { console.error('字首不能含禁止字元'); process.exit(1); }
    const has = readRules().some((r) => r.toLowerCase() === v.toLowerCase());
    if (op === 'add' && has) return console.log('已經在白名單：' + v);
    if (op === 'remove' && !has) return console.log('白名單沒有：' + v);
    const bak = backup();
    const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/);
    const next = op === 'add' ? [...lines.filter((l, i) => l || i < lines.length - 1), v, '']
      : lines.filter((l) => l.trim().toLowerCase() !== v.toLowerCase());
    fs.writeFileSync(FILE, next.join('\n'), 'utf8');
    console.log(`${op === 'add' ? '已加入' : '已移除'}：${v}（備份 ${bak}）`);
  } else { console.error('用法：node whitelist.cjs list | add "<字首>" | remove "<字首>" | check "<指令>"'); process.exitCode = 1; }
}

module.exports = { check, tokens };
