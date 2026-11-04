// 草案（尚未安裝）：PreToolUse 兩級檢查，只看工具輸入，不回顯命中的原字串。
//   攔下（exit 2）：疑似 API key／token、身分證字號（驗檢查碼）、信用卡號（驗 Luhn）。
//   提醒（exit 0）：Email、手機號碼；顯示一行提示並記到 ~/.claude/egress-log/secret-guard-warn.jsonl（只記類別與次數）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID_LETTER = { A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21, N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33 };
function validTwId(s) {
  const n = ID_LETTER[s[0].toUpperCase()];
  if (!n) return false;
  const d = s.slice(1).split('').map(Number);
  let sum = Math.floor(n / 10) + (n % 10) * 9;
  for (let i = 0; i < 8; i++) sum += d[i] * (8 - i);
  return (sum + d[8]) % 10 === 0;
}
function luhn(s) {
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = +s[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}
const matches = (re, text) => text.match(re) || [];

// 收集 tool_input 裡所有字串值（遞迴），不用 JSON.stringify：那會把換行變成「\n」兩個字，
// 讓行首的 token 黏在字母 n 後面而躲過 \b 與前置檢查。另附一份去掉引號／反斜線的版本，
// 抓 sk-""ant-… 這種 shell 會自動接回去的拆字寫法；NFKC 把全形數字字母還原成半形。
function collect(v, out, depth) {
  if (depth > 20 || v == null) return out;
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number') out.push(String(v));
  else if (typeof v === 'object') for (const x of Object.values(v)) collect(x, out, depth + 1);
  return out;
}
function scanText(input) {
  const t = collect(input, [], 0).join('\n').normalize('NFKC');
  const dq = t.replace(/["'\\`]/g, '');
  return dq === t ? t : t + '\n' + dq;
}

const BLOCK = [
  // sha256:<hex>（docker digest、lockfile 校驗值）不算 key
  ['64 位十六進位字串（疑似 API key）', t => matches(/(?<!sha(?:256|512)?[:=]\s?)(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, t)],
  ['x-api-key／Authorization 標頭值', t => matches(/(x-api-key|authorization)["'\s:=]+(bearer\s+|basic\s+)?[A-Za-z0-9._\-+\/]{16,}={0,2}/gi, t)],
  ['sk- 開頭 token', t => matches(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_\-]{20,}/gi, t)],
  ['GitHub token', t => matches(/(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, t)],
  ['AWS access key', t => matches(/(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g, t)],
  ['身分證字號', t => matches(/(?<![A-Za-z0-9])[A-Za-z][12]\d{8}(?!\d)/g, t).filter(validTwId)],
  // 卡號：要有發卡機構開頭（3/4/5/6），分隔符號整串一致且每 4 碼一組，避免一串數字參數被誤擋
  ['信用卡號', t => matches(/(?<![\d.])(?:[3-6]\d{12,18}|[3-6]\d{3}([ .-])\d{4}\1\d{4}\1\d{1,7}|3[47]\d{2}([ .-])\d{6}\2\d{5})(?![\d])/g, t).map(x => x.replace(/[ .-]/g, '')).filter(x => x.length >= 13 && x.length <= 19 && luhn(x))],
];
const WARN = [
  // 前置斷言＋長度上限：舊寫法在一長串無 @ 的英數字上是平方時間（200 KB 要 47 秒）
  ['Email', t => matches(/(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, t)],
  ['手機號碼', t => matches(/(?<!\d)09\d{2}[- ]?\d{3}[- ]?\d{3}(?!\d)/g, t)],
];

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  let ev;
  try { ev = JSON.parse(raw || '{}'); } catch (_) { return; }
  if (!ev || typeof ev !== 'object') return;
  const text = scanText(ev.tool_input);

  const hit = BLOCK.find(([, f]) => f(text).length);
  if (hit) {
    process.stderr.write(`secret-guard：工具 ${ev.tool_name} 的輸入含${hit[0]}，已攔下。請改由使用者在目標機器自行填入，勿寫進指令或對外內容。\n`);
    process.exit(2);
  }

  const warns = WARN.map(([name, f]) => [name, f(text).length]).filter(([, n]) => n);
  if (!warns.length) return;
  const desc = warns.map(([k, n]) => `${k}×${n}`).join('、');
  try {
    const dir = path.join(os.homedir(), '.claude', 'egress-log');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'secret-guard-warn.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), session: ev.session_id || '', tool: ev.tool_name, hits: Object.fromEntries(warns) }) + '\n', 'utf8');
  } catch (_) { /* 紀錄失敗不影響提醒 */ }
  process.stdout.write(JSON.stringify({ systemMessage: `secret-guard 提醒：${ev.tool_name} 的輸入含 ${desc}（未攔下，已記錄）。` }));
});
