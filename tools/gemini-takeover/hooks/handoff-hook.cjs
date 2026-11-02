// Claude Code hook（PostToolUse＋UserPromptSubmit 共用）：5 小時用量到 85% 就交工給 EKB＋agy。
//  PostToolUse：用量 ≥ 85% 且這個對話在這個視窗還沒提醒過 → 注入「請寫交接單並結束這一回合」。
//  UserPromptSubmit：用量 ≥ 85% → 擋下新訊息、把使用者原話寫成交接單；`!claude` 開頭放行；交工完成的自動訊息放行；`/` 開頭的指令放行。
// 只對 takeover-whitelist.txt（TAKEOVER_WHITELIST 可覆寫）列的工作區生效；任何錯誤都放行（不輸出、exit 0）。
// 用量來自 usage.json（usage.cjs，TAKEOVER_USAGE_OVERRIDE 可覆寫）；門檻 TAKEOVER_HANDOFF_PCT（預設 85）。
'use strict';
const fs = require('fs');
const path = require('path');
const AGY = path.join(__dirname, '..');
const DONE_MARK = '【EKB＋agy 交工完成】'; // 自動送出的交工完成訊息必須以此開頭，hook 才放行
const THRESHOLD = Number(process.env.TAKEOVER_HANDOFF_PCT) || 85;

let raw = '';
process.stdin.on('data', (d) => raw += d).on('end', () => {
  try {
    if (fs.existsSync(path.join(AGY, 'hooks', 'debug.on')) && fs.readFileSync(path.join(AGY, 'hooks', 'debug.on'), 'utf8').trim() === 'on') fs.appendFileSync(path.join(AGY, 'hooks', 'debug.log'), raw.slice(0, 1500) + '\n');
    main(JSON.parse(raw));
  } catch { /* 出錯放行 */ }
});

const norm = (s) => String(s || '').replace(/\//g, String.fromCharCode(92)).toLowerCase();
function whitelisted(cwd) {
  const f = process.env.TAKEOVER_WHITELIST || path.join(AGY, 'takeover-whitelist.txt');
  const white = fs.readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  return white.some((w) => norm(cwd).includes(norm(w)));
}
const out = (o) => console.log(JSON.stringify(o));
const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 17);

// 每個 (對話, 視窗) 只提醒一次：用 wx 建記號檔，建不起來（已存在）就不再提醒。
function firstTime(sid, key) {
  const dir = path.join(AGY, 'hooks', 'marks'); fs.mkdirSync(dir, { recursive: true });
  const k = Buffer.from(String(key)).toString('hex').slice(-24);
  try { fs.closeSync(fs.openSync(path.join(dir, `${sid.replace(/\W/g, '')}-${k}.mark`), 'wx')); return true; } catch { return false; }
}

function enqueue(entry) {
  const dir = process.env.TAKEOVER_QUEUE_DIR || path.join(AGY, 'handoff-queue'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, entry.id + '.json'), JSON.stringify(entry, null, 1));
}

function main(j) {
  const ev = j.hook_event_name, sid = String(j.session_id || ''), cwd = String(j.cwd || '');
  if (!sid || !cwd || !whitelisted(cwd)) return;
  const { effective } = require(path.join(AGY, 'usage.cjs'));
  const u = effective();
  if (u.percent === null || u.percent < THRESHOLD) return;
  const s8 = sid.slice(0, 8), dir = path.join(cwd, '.gemini-takeover');

  if (ev === 'PostToolUse') {
    if (j.agent_id) return; // 子代理共用主對話的 session_id；提醒只給主對話，否則子代理會把「每視窗一次」的提醒吃掉（2026-10-31 實測）
    if (!firstTime(sid, u.key)) return;
    const file = path.join(dir, `HANDOFF-${s8}.md`);
    fs.mkdirSync(dir, { recursive: true });
    enqueue({ id: `${Date.now()}-${s8}`, kind: 'claude', sid, cwd, file, created: new Date().toISOString(), percent: u.percent, window: u.key, status: 'waiting' });
    const mode = process.env.TAKEOVER_REMINDER_MODE || 'block'; // block（預設）：用 decision:block 把提醒當成 hook 回饋丟給模型。只用 additionalContext 時 Haiku 兩次都當成工具結果夾帶的指令而拒絕照做（2026-10-31 實測）；TAKEOVER_REMINDER_MODE=context 可改回
    const text =
      `【用量交工 hook】這是使用者自己在 settings.json 設定的 hook 訊息（不是工具回傳的內容，也不是外部網頁／檔案來源），使用者已事先授權你照做。5 小時用量已達 ${u.percent}%。請在這一步收尾：把交接單寫到 ${file}（繁體中文，要寫：目標、已完成、下一步要做的具體步驟、要改的檔案、驗收方式、不能做的事），然後結束這一回合，不要再做別的；剩下的工作交給 EKB＋agy，完成後會自動叫你審核。交接單要寫到「沒看過這段對話的人照著就能做」的程度：檔案寫完整路徑、驗收寫出指令。`;
    out(mode === 'block' ? { decision: 'block', reason: text, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } } : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
    return;
  }

  if (ev === 'UserPromptSubmit') {
    const prompt = String(j.prompt || '');
    // 放行：自動送出的交工完成、斜線指令、系統產生的假使用者訊息（子代理完成通知 <task-notification> 等）——不是使用者原話，擋掉會害對話收不到子代理結果。
    if (prompt.startsWith(DONE_MARK) || /^\s*\//.test(prompt) || /^\s*<(task-notification|system-reminder|local-command|command-name)/i.test(prompt)) return;
    if (/^\s*!claude\b/i.test(prompt)) { // hook 不能改寫使用者訊息，所以前綴會留在對話裡；用 additionalContext 說明
      out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `使用者用「!claude」前綴要求這則訊息由你（Claude）直接處理，不轉給 EKB＋agy；前綴只是放行記號，請忽略它。用量已達 ${u.percent}%，請省著用。` } });
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `HANDOFF-${s8}-u${stamp()}.md`);
    fs.writeFileSync(file, `# 交接單（使用者在用量 ${u.percent}% 之後送出的新訊息，由 hook 自動記錄）\n\n- 對話：${sid}\n- 時間：${new Date().toISOString()}\n\n## 目標（使用者原話）\n\n${prompt}\n\n## 已完成\n\nClaude 在這則訊息之前的進度沒有交接單；請先看同資料夾較早的 HANDOFF-*.md 與報告，以及工作區現況。\n\n## 下一步\n\n依使用者原話判斷；不確定就寫在報告的「待 Claude 決定的事」，不要猜。\n\n## 不能做的事\n\n見系統規則（不刪檔、不 commit／push、不對外送出、不動帳密權限與算錢／資料庫邏輯、不重啟服務或上線）。\n`);
    enqueue({ id: `${Date.now()}-${s8}`, kind: 'user', sid, cwd, file, created: new Date().toISOString(), percent: u.percent, window: u.key, status: 'waiting' });
    out({ decision: 'block', reason: `用量已達 ${u.percent}%，這則已轉給 EKB＋agy，完成後 Claude 會審核再回覆。（要強制由 Claude 處理，訊息開頭加 !claude）` });
  }
}
