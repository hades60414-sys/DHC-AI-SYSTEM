// Claude 撞額度時由 Gemini（agy，使用者的 Google 學生方案）暫代。健康檢查每 5 分鐘跑一次。
// 接手條件：對話最後一則是 Claude 的額度上限訊息、撞限不到 1 小時、離重置還有 20 分鐘以上、
// 工作區在 takeover-whitelist.txt（每行一段路徑片段）、這次撞限還沒接手過（takeover-state.json）。
// 接手方式：對話尾段遮掉內網 IP／Email／密碼字樣後交給 agy -p，只自動核准改檔與少數唯讀指令，
// 重置前 5 分鐘停手；報告寫 <工作區>\.gemini-takeover\。auto-resume.cjs 續跑 Claude 時會附上報告路徑。
// 2026-10-30 起週一到週五 08:00–20:00 走「EKB 主做＋agy 動手監督」（ekb-lane.cjs）：agy 唯讀蒐集脈絡 → EKB（Opus 4.6）出方案 → agy 照做並審查；
// EKB 任何一步失敗就退回純 agy，原因寫進報告。TAKEOVER_EKB=0 可關掉。
// 2026-10-31 起主線改成「5 小時用量到 85% 就交工」（hooks/handoff-hook.cjs 放交接單 → handoff.cjs 跑 EKB＋agy 互審 → 送「交工完成」叫 Claude 審核）；
// --loop 每 30 秒順便讀用量寫 usage.json（usage.cjs）、掃交工佇列、重試未送出的「交工完成」。撞 100% 的舊接手保留當最後防線，這個對話已在交工流程中就不重複接手。
// usage: node gemini-takeover.cjs [--dry]（掃一次）、--loop（每 30 秒掃，排程 TAS-GeminiTakeover 開機啟動）；內部：--run <job.json>
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const DIR = __dirname;
const AGY = path.join(DIR, 'agy.exe');
const STATE = path.join(DIR, 'takeover-state.json');
const WHITELIST = process.env.TAKEOVER_WHITELIST || path.join(DIR, 'takeover-whitelist.txt');
const PROJECTS = process.env.TAKEOVER_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const LOG = path.join(DIR, 'takeover.log');
const LOCK = path.join(DIR, 'takeover.lock');
// 2026-10-30 使用者選：預設用 agy 裡的 Claude Opus 4.6（扣 Google 學生方案額度）；TAKEOVER_MODEL 可改成 gemini-3.8-flash-high 等。
const MODEL = process.env.TAKEOVER_MODEL || 'claude-opus-4-6-thinking';
const MODEL_LABEL = { 'claude-opus-4-6-thinking': 'Claude Opus 4.6（經 Google agy）', 'claude-sonnet-4-6': 'Claude Sonnet 4.6（經 Google agy）' }[MODEL] || `Gemini（${MODEL}）`;
const DRY = process.argv.includes('--dry');
const AGY_SHORT = { 'claude-opus-4-6-thinking': 'Opus 4.6', 'claude-sonnet-4-6': 'Sonnet 4.6' }[MODEL] || MODEL;
const EKB_LABEL = `EKB（Opus 4.6）主做＋agy（${AGY_SHORT}）動手監督`;
const EKB_SEC = Number(process.env.TAKEOVER_EKB_TIMEOUT_SEC) || 600;
let HO = null; try { HO = require('./handoff.cjs'); } catch (e) { console.error('handoff.cjs 載入失敗：' + e.message); }
let USAGE = null; try { USAGE = require('./usage.cjs'); } catch {}
let LANE = null; try { LANE = require('./ekb-lane.cjs'); } catch (e) { LANE = { loadError: e.message }; }
const LIMIT_RE = /hit your (?:session |usage )?limit\s*·\s*resets (\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const ALLOW = ['command(node)', 'command(npm test)', 'command(npm run lint)', 'command(git status)', 'command(git diff)', 'command(git log)', 'read_url(*)'];
const log = (s) => { const line = `${new Date().toISOString()} ${DRY ? '[dry] ' : ''}${s}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));

function textOf(e) {
  const c = e.message?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text || '').join('') : '';
}

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size, len = Math.min(size, 512 * 1024), buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
  return buf.toString('utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// 送到 Google 前遮掉的東西：內網 IP、Email、看起來像帳密的值、去識別代號。
function redact(s) {
  return s
    .replace(/\b(?:172\.(?:1[6-9]|2\d|3[01])|10\.\d{1,3}|192\.168)\.\d{1,3}\.\d{1,3}\b/g, '[內網IP]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[Email]')
    .replace(/((?:password|passwd|pwd|token|secret|密碼)\s*[:=：]\s*)\S+/gi, '$1[遮蔽]')
    .replace(/\bDEID_[A-Z]+_\d+\b/g, '[代號]');
}

function findCandidate(file, now) {
  const entries = readTail(file);
  const chat = entries.filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isMeta && !e.isSidechain);
  const last = chat[chat.length - 1];
  if (!last || last.type !== 'assistant') return null;
  const m = textOf(last).match(LIMIT_RE);
  if (!m) return null;
  const at = new Date(last.timestamp);
  if (now - at > 3600e3) return null;
  const reset = new Date(at); reset.setHours(Number(m[1]) % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0), Number(m[2] || 0), 0, 0);
  if (reset <= at) reset.setDate(reset.getDate() + 1);
  if (reset - now < 20 * 60e3) return null;
  // 對話尾段：最近的文字訊息（略過工具結果），從後面取到 40k 字。
  let convo = '';
  for (let i = chat.length - 2; i >= 0 && convo.length < 40000; i--) {
    const t = textOf(chat[i]).trim();
    if (t) convo = `【${chat[i].type === 'user' ? '使用者' : 'Claude'}】\n${t.slice(0, 8000)}\n\n` + convo;
  }
  return { uuid: last.uuid, at, reset, providerId: last.sessionId || path.basename(file, '.jsonl'), cwd: last.cwd || '', convo: redact(convo) };
}

function prompt(job) {
  return `你暫代另一個 AI 助理（Claude）。它做到一半時用量額度用完，大約 ${new Date(job.reset).toLocaleTimeString('zh-TW')} 恢復，之後由它接回。
請從下面對話的最後一個使用者要求接著做，能做多少做多少。

規則：
1. 只在目前資料夾（${job.cwd}）裡工作。讀檔、找檔、改檔一律用內建的檔案工具；系統指令只准用 node、npm test、npm run lint、git status、git diff、git log，其他指令都會被擋。改一個既有檔案前，先複製一份「原檔名.bak-gemini」。
2. 不准刪除檔案或資料、不准 git commit／push、不准對外寄信或發訊息、不准改帳密或權限、不准動算錢或資料庫的邏輯。遇到這些就停下，寫在報告裡等 Claude 處理。
3. 不確定使用者要什麼就不要猜，寫在報告的「待確認」。
4. 工作做完後，最後一則訊息一定要是用繁體中文寫的報告文字（不要以工具呼叫結束）：做了什麼（每個改動的檔案路徑）、怎麼驗證、還沒做的、待確認。

以下是對話尾段（內網 IP、Email、帳密已遮蔽）：
${job.convo}`;
}

// ---- EKB 主力線 ----
function reconPrompt(job) {
  return `你要「唯讀」蒐集脈絡：不准修改、建立、刪除任何檔案。只准用 list_dir、find_by_name、grep_search、view_file 這四個檔案工具，不要用 run_command（任何系統指令都會被擋）。
下面是另一個 AI 助理被中斷前的對話尾段。請依最後一個使用者要求，在目前資料夾找出完成它需要看的檔案，輸出精簡的脈絡。
格式：每個檔案一段，先寫一行「### 相對路徑」（相對於目前資料夾），下一段用程式碼區塊放和任務有關的原文（小檔給全文，大檔只給相關函式或段落並標明省略處）。
總長度 4500 字以內；不要含 .env、密碼、金鑰類檔案。你的最後一則訊息就是這份脈絡本身，不要加其他說明。

對話尾段：
${job.convo.slice(-6000)}`;
}

function execPrompt(job, lane) {
  const p = lane.parsed;
  return `你暫代另一個 AI 助理（Claude）。它做到一半時用量額度用完，大約 ${new Date(job.reset).toLocaleTimeString('zh-TW')} 恢復，之後由它接回。
這次分工：公司內部 AI 聊天 EKB（Opus 4.6，只能聊天、不能讀寫檔案）已先針對任務產出方案；你負責「動手＋監督」。使用者還不信任 EKB，所以你不是照抄：

規則：
1. 只在目前資料夾（${job.cwd}）裡工作。讀檔、找檔、改檔一律用內建的檔案工具；系統指令只准用 node、npm test、npm run lint、git status、git diff、git log，其他指令都會被擋。改一個既有檔案前，先複製一份「原檔名.bak-gemini」。
2. 不准刪除檔案或資料、不准 git commit／push、不准對外寄信或發訊息、不准改帳密或權限、不准動算錢或資料庫的邏輯。遇到這些就停下，寫在報告裡等 Claude 處理。
3. 動手前先讀現有檔案，核對 EKB 的方案。EKB 的回答是從聊天網頁畫面複製下來的，換行、縮排、反引號（例如範本字串）可能跑掉，所以一律以現有檔案為準，理解它的意圖後自己寫出正確的程式碼，不要逐字貼上。@@PATCH 的 @@SEARCH 原文對得上現有檔案嗎？邏輯對嗎？有沒有不安全、超出任務範圍的動作？對的就照做；錯的或不安全的就不照做或改掉，並說明理由。EKB 看不到真實檔案（只看過一份遮蔽後的摘錄），方案裡若出現「[遮蔽]」「[路徑]」字樣，不可原樣寫進檔案。
4. 照做後執行驗證（EKB 給的指令與你自己想到的，限上面允許的指令），結果如實寫進報告。
5. 不確定使用者要什麼就不要猜，寫在報告的「待確認」。
6. 全部做完後，最後一則訊息一定要是繁體中文報告（不要以工具呼叫結束），標題一律用這六個：
## EKB 提的（用你的話摘要它的結論、要改的檔案、要跑的指令）
## agy 照做的（每個改動的檔案路徑）
## agy 認為 EKB 錯或不安全而沒照做／改掉的（沒有就寫「無」，有就寫原因）
## 怎麼驗證
## 還沒做的
## 待確認

以下是對話尾段（內網 IP、Email、帳密已遮蔽）：
${job.convo}

=== EKB 的回答原文 ===
${lane.answer}

=== 程式預檢（路徑與指令是否在允許範圍） ===
${p.problems.length ? p.problems.map((x) => '- ' + x).join('\n') : '- 沒有發現問題'}`;
}

// 嘗試走 EKB 主力線；回傳 { used, reason, ... }，used=false 就是退回純 agy。
async function ekbPhase(job) {
  if (process.env.TAKEOVER_EKB === '0') return { used: false, reason: 'EKB 主力線已停用（TAKEOVER_EKB=0）' };
  if (!LANE || LANE.loadError) return { used: false, reason: 'EKB 模組載入失敗：' + (LANE && LANE.loadError) };
  if (!LANE.inWindow(new Date())) return { used: false, reason: '不在 EKB 使用時段（週一到週五 08:00–20:00）' };
  const leftSec = () => Math.floor((new Date(job.reset) - Date.now() - 5 * 60e3) / 1000);
  const t0 = Date.now(); let step = '蒐集脈絡';
  try {
    const reconSec = Math.min(240, leftSec() - 900);
    if (reconSec < 60) return { used: false, reason: '離重置太近，時間不夠走 EKB' };
    const r = spawnSync(AGY, ['-p', reconPrompt(job), '--model', MODEL, '--mode', 'accept-edits', '--print-timeout', reconSec + 's', '--output-format', 'json',
      '--settings', JSON.stringify({ permissions: { allow: [] } })], { cwd: job.cwd, encoding: 'utf8', timeout: (reconSec + 30) * 1000, maxBuffer: 16 << 20, windowsHide: true });
    let recon = '', cid = ''; try { const o = JSON.parse(r.stdout); recon = (o.response || '').trim(); cid = o.conversation_id; } catch {}
    if (recon.length < 40 && cid) { // 偶爾它只動手查、沒把脈絡寫出來：追問一次
      const r2 = spawnSync(AGY, ['--conversation', cid, '-p', '請把蒐集到的脈絡直接寫出來（格式同前，只准用 list_dir、find_by_name、grep_search、view_file，不要用 run_command，不要修改任何檔案），最後一則訊息就是脈絡本身。', '--model', MODEL, '--mode', 'accept-edits', '--print-timeout', '120s', '--output-format', 'json'],
        { cwd: job.cwd, encoding: 'utf8', timeout: 150000, maxBuffer: 16 << 20, windowsHide: true });
      try { recon = (JSON.parse(r2.stdout).response || '').trim(); } catch {}
    }
    const wrote = touched(job.cwd, t0);
    log(`ekb recon ${recon.length} chars, ${Math.round((Date.now() - t0) / 1000)}s${wrote.length ? ' WROTE ' + wrote.join(',') : ''}`);
    if (recon.length < 40) throw new Error('agy 沒有產出脈絡（' + (r.error ? r.error.message : 'response 空白') + '）');
    step = '遮蔽與送出前檢查';
    const text = LANE.prepare({ convo: job.convo, recon, cwd: job.cwd });
    step = '詢問 EKB';
    const budget = Math.min(EKB_SEC, leftSec() - 600);
    if (budget < 10) throw new Error('剩餘時間不夠等 EKB');
    const a = await LANE.ask(text, { timeoutSec: budget, log });
    step = '解析 EKB 回答';
    const parsed = LANE.parse(a.answer);
    if (!parsed.ok) throw new Error('EKB 回答格式無法解析（沒有 @@SUMMARY／@@FILE／@@PATCH／@@CMD 區塊）：' + a.answer.slice(0, 120).replace(/\s+/g, ' '));
    log(`ekb ok ${a.seconds}s answer ${a.answer.length} chars job ${a.job}`);
    return { used: true, answer: a.answer, parsed, seconds: a.seconds, reconChars: recon.length, reconWrote: wrote };
  } catch (e) {
    log(`ekb fallback at ${step}: ${e.message}`);
    return { used: false, reason: `${step}失敗：${e.message}` };
  }
}

// since 之後改過的檔案（略過 node_modules、.git、.gemini-takeover），最多 200 個。
function touched(root, since) {
  const hits = [];
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (hits.length >= 200 || ['node_modules', '.git', '.gemini-takeover'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 6) walk(p, depth + 1); }
      else if (fs.statSync(p).mtimeMs >= since) hits.push(path.relative(root, p));
    }
  };
  try { walk(root, 0); } catch {}
  return hits;
}

// 背景執行一個接手工作：跑 agy、寫報告、更新狀態。
async function run(jobFile) {
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const outDir = path.join(job.cwd, '.gemini-takeover');
  fs.mkdirSync(outDir, { recursive: true });
  const report = path.join(outDir, `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${job.providerId.slice(0, 8)}.md`);
  const t0 = Date.now();
  const lane = await ekbPhase(job);
  const label = lane.used ? EKB_LABEL : MODEL_LABEL;
  const HEADS = lane.used ? '標題用：EKB 提的、agy 照做的、agy 認為 EKB 錯或不安全而沒照做／改掉的、怎麼驗證、還沒做的、待確認' : '標題用：做了什麼（每個改動的檔案路徑）、怎麼驗證、還沒做的、待確認';
  const hasReport = (s) => lane.used ? /EKB 提的/.test(s) && /agy 照做的/.test(s) && /沒照做/.test(s) : /做了什麼/.test(s);
  const secs = Math.max(60, Math.floor((new Date(job.reset) - Date.now() - 5 * 60e3) / 1000));
  const r = spawnSync(AGY, ['-p', lane.used ? execPrompt(job, lane) : prompt(job), '--model', MODEL, '--mode', 'accept-edits', '--print-timeout', secs + 's', '--output-format', 'json',
    '--settings', JSON.stringify({ permissions: { allow: ALLOW } })],
    { cwd: job.cwd, encoding: 'utf8', timeout: (secs + 60) * 1000, maxBuffer: 64 << 20, windowsHide: true });
  let out = {};
  try { out = JSON.parse(r.stdout); } catch {}
  // agy 常在中途停下：response 是空的（以工具呼叫結束），或只說一句「我來接手」就結束。
  // 沒看到報告的「做了什麼」段落就接同一段對話叫它接著做，最多 4 輪（同樣的權限、剩下的時間）。
  // 2026-10-30：原本追問「只寫報告不要動檔」，結果它讀完檔就收工、什麼都沒做。
  for (let round = 0; round < 4 && out.conversation_id && !hasReport(out.response || ''); round++) {
    const left = Math.floor((new Date(job.reset) - Date.now() - 5 * 60e3) / 1000);
    if (left <= 60) break;
    const r2 = spawnSync(AGY, ['--conversation', out.conversation_id, '-p', '請繼續，直接動手把工作做完（同樣遵守前面的規則），不用先說明計畫。全部做完並驗證後，最後一則訊息用繁體中文寫報告，' + HEADS + '。',
      '--model', MODEL, '--mode', 'accept-edits', '--output-format', 'json', '--print-timeout', left + 's', '--settings', JSON.stringify({ permissions: { allow: ALLOW } })],
      { cwd: job.cwd, encoding: 'utf8', timeout: (left + 60) * 1000, maxBuffer: 64 << 20, windowsHide: true });
    try { out.response = JSON.parse(r2.stdout).response; } catch { out.response = ''; }
  }
  // 已經有改動卻沒寫報告：工作做完了，這時才可以叫它「只寫報告」。
  if (out.conversation_id && !hasReport(out.response || '') && touched(job.cwd, t0).length) {
    const r3 = spawnSync(AGY, ['--conversation', out.conversation_id, '-p', '用繁體中文寫剛才的工作報告，' + HEADS + '。只寫報告。',
      '--model', MODEL, '--output-format', 'json', '--print-timeout', '120s'], { cwd: job.cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 16 << 20, windowsHide: true });
    try { out.response = JSON.parse(r3.stdout).response || out.response; } catch {}
  }
  const body = (out.response || '').trim() || '(暫代模型最後沒有寫報告文字，請看下方改動清單)';
  const err = r.error ? r.error.message : (r.status || (out.status && out.status !== 'SUCCESS') ? `${out.status || ''} ${(r.stderr || '').slice(-2000)}` : '');
  const changed = touched(job.cwd, t0).map((f) => '- ' + f).join('\n') || '- （沒有）';
  const ekbNote = lane.used
    ? `- EKB：有參與（${lane.seconds} 秒；agy 蒐集脈絡 ${lane.reconChars} 字${lane.reconWrote.length ? '；⚠ 蒐集階段 agy 違規動了檔案：' + lane.reconWrote.join('、') : ''}）`
    : `- EKB：沒有參與，退回純 agy。原因：${lane.reason}`;
  const fence = '```';
  const ekbRaw = lane.used
    ? `\n## EKB 原始回答與程式預檢（程式存檔，非 agy 轉述）\n\n${fence}\n${lane.answer}\n${fence}\n\n程式預檢：${lane.parsed.problems.length ? '\n' + lane.parsed.problems.map((x) => '- ' + x).join('\n') : '沒有發現問題'}\n`
    : '';
  fs.writeFileSync(report, `# ⚠️【額度暫代：${label}・未經 Claude 核對】\n\n> 這份是 Claude 額度用完期間由 ${label} 暫代做的工作。使用者還不信任它的判斷：每個改動都要由 Claude 對照 .bak-gemini 逐一核對後才算數。\n\n- 對話：${job.providerId}\n${ekbNote}\n- 開始：${job.started}\n- 結束：${new Date().toISOString()}\n- 結果：${err ? '有錯誤（見文末）' : '完成'}\n\n## 暫代模型的說明\n\n${body}\n${ekbRaw}\n## 接手期間改過或新增的檔案（自動列出）\n\n${changed}\n${err ? '\n## 錯誤\n\n```\n' + err + '\n```\n' : ''}`);
  const s = readState(); s[job.uuid] = { ...s[job.uuid], status: err ? 'error' : 'done', report, model: label, ekb: lane.used ? { used: true, seconds: lane.seconds } : { used: false, reason: lane.reason }, finished: new Date().toISOString() }; saveState(s);
  log(`done ${job.providerId} (${job.cwd}) -> ${report}${err ? ' error: ' + err.slice(0, 200) : ''}`);
  fs.unlinkSync(jobFile);
}

function scan() {
  const now = Date.now();
  const white = fs.existsSync(WHITELIST) ? fs.readFileSync(WHITELIST, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')) : [];
  if (!white.length) return;
  const state = readState();
  for (const dir of fs.readdirSync(PROJECTS)) {
    const full = path.join(PROJECTS, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(full, f);
      if (now - fs.statSync(file).mtimeMs > 3600e3) continue;
      const c = findCandidate(file, now);
      if (!c || state[c.uuid] || !white.some((w) => c.cwd.includes(w))) continue;
      if (HO && HO.hasActive(c.providerId)) { log(`skip ${c.providerId}: 已在 85% 交工流程中，不重複接手`); state[c.uuid] = { status: 'skipped-handoff', providerId: c.providerId }; saveState(state); continue; }
      if (DRY) { log(`would take over ${c.providerId} (${c.cwd}) until ${c.reset.toLocaleTimeString()}, ${c.convo.length} chars`); continue; }
      const job = { ...c, started: new Date().toISOString() };
      const jobFile = path.join(DIR, `job-${c.providerId.slice(0, 8)}-${now}.json`);
      fs.writeFileSync(jobFile, JSON.stringify(job));
      state[c.uuid] = { status: 'running', providerId: c.providerId, cwd: c.cwd, started: job.started }; saveState(state);
      spawn(process.execPath, [__filename, '--run', jobFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      log(`take over ${c.providerId} (${c.cwd}) until ${c.reset.toLocaleTimeString()}`);
    }
  }
}

// 同一時間只准一個掃描（30 秒迴圈與健康檢查的備援會重疊）；鎖超過 2 分鐘視為殘留。
function scanLocked() {
  try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 120e3) fs.unlinkSync(LOCK); } catch {}
  let fd; try { fd = fs.openSync(LOCK, 'wx'); } catch { return; }
  try { scan(); if (HO) HO.scanQueue({ dry: DRY }); } finally { fs.closeSync(fd); fs.unlinkSync(LOCK); }
}

try {
  const i = process.argv.indexOf('--run');
  if (i > 0) run(process.argv[i + 1]).catch((e) => log('error ' + e.stack));
  else if (process.argv.includes('--loop')) {
    const tick = () => { try { scanLocked(); } catch (e) { log('error ' + e.stack); } if (USAGE) USAGE.poll().catch((e) => log('usage poll error ' + e.message)); if (HO) HO.notifyPending().catch((e) => log('notify error ' + e.message)); };
    tick(); setInterval(tick, 30e3);
  }
  else scanLocked();
} catch (e) { log('error ' + e.stack); }
