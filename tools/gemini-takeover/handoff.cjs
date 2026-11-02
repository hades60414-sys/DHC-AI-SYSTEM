// 85% 交工：Claude 的 5 小時用量到門檻後，由 EKB＋agy 互相監督做完交接單上的工作，Claude 留額度做最後審核。
// 佇列：hook（hooks/handoff-hook.cjs）在 handoff-queue\ 放 <id>.json（status=waiting），gemini-takeover.cjs --loop 每 30 秒呼叫 scanQueue()。
//   waiting → 交接單檔案出現、檔案與對話紀錄都靜止 45 秒 → running（背景跑 node handoff.cjs --run <佇列檔>）→ done／error → 送「交工完成」給原對話（notified）。
// 流程（--run）：
//   1. 程式先快照工作區文字檔（之後的 diff、備份、刪檔偵測都以快照為準，不信任 agy 自己的備份）。
//   2. EKB 可用（週一到週五 08:00–20:00、沒關、題目過 ekb-prep）→ EKB（Opus）依交接單出做法；否則略過，原因寫進報告。
//   3. agy（執行者，對話 A）照交接單＋EKB 做法動手改檔、跑驗證。
//   4. 審查最多 3 輪：審查者（EKB；不可用就用另一個 agy 對話 B）看 diff 判 PASS／FIX；FIX → 執行者逐點判斷、修或反駁 → 再審。
//   5. 程式自己跑交接單裡寫的驗證指令（只准 node …、npm test、npm run lint），寫報告 <cwd>\.gemini-takeover\<時間>-<id>.md。
//   6. chat.send「【EKB＋agy 交工完成】…」到原對話（用量 ≥100% 或對話還在跑就等，每 30 秒重試；01:00–06:00 不送）。
// 環境變數（測試用）：TAKEOVER_QUEUE_DIR、TAKEOVER_PROJECTS、TAKEOVER_NOTIFY_DRY=1（只印不送）、TAKEOVER_EKB=0、TAKEOVER_SETTLE_SEC、TAKEOVER_AGY_SEC、TAKEOVER_MODEL
// usage: node handoff.cjs --run <佇列檔>｜--scan（掃一次佇列）｜--notify <佇列檔>
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const DIR = __dirname;
const AGY = path.join(DIR, 'agy.exe');
const QUEUE = process.env.TAKEOVER_QUEUE_DIR || path.join(DIR, 'handoff-queue');
const PROJECTS = process.env.TAKEOVER_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const LOG = path.join(DIR, 'takeover.log');
const MODEL = process.env.TAKEOVER_MODEL || 'claude-opus-4-6-thinking';
// agy 的 Claude 模型額度會用完（2026-10-31 實測：RESOURCE_EXHAUSTED，160 小時後才重置）；用完就自動改用 Gemini 做完這次交工並記進報告。
const FALLBACK_MODEL = 'gemini-3.8-flash-high';
let curModel = MODEL; const modelNotes = [];
const SETTLE_MS = (Number(process.env.TAKEOVER_SETTLE_SEC) || 45) * 1000;
const AGY_SEC = Number(process.env.TAKEOVER_AGY_SEC) || 900;
const EKB_SEC = Number(process.env.TAKEOVER_EKB_TIMEOUT_SEC) || 420;
const MAX_REVIEWS = 3;
const DONE_MARK = '【EKB＋agy 交工完成】';
const ALLOW = ['command(node)', 'command(npm test)', 'command(npm run lint)', 'command(git status)', 'command(git diff)', 'command(git log)', 'read_url(*)'];
let allowNow = ALLOW; // agy 的 command(node) 不會放行 `node test.js`（實測），要逐條列出完整指令
const CMD_OK = /^(node\s+[^&|;<>`$]+|npm test|npm run lint)$/;
const SKIP_DIRS = ['node_modules', '.git', '.gemini-takeover'];
let LANE = null; try { LANE = require('./ekb-lane.cjs'); } catch (e) { LANE = { loadError: e.message }; }

const log = (s) => { const line = `${new Date().toISOString()} [handoff] ${s}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch {} };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const saveEntry = (e) => fs.writeFileSync(e.qfile, JSON.stringify({ ...e, qfile: undefined }, null, 1));
const loadEntry = (qfile) => { const e = readJson(qfile); if (e) e.qfile = qfile; return e; };
const fence = '```';

function redact(s) {
  return s
    .replace(/\b(?:172\.(?:1[6-9]|2\d|3[01])|10\.\d{1,3}|192\.168)\.\d{1,3}\.\d{1,3}\b/g, '[內網IP]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[Email]')
    .replace(/((?:password|passwd|pwd|token|secret|密碼)\s*[:=：]\s*)\S+/gi, '$1[遮蔽]')
    .replace(/\bDEID_[A-Z]+_\d+\b/g, '[代號]');
}

// ---------- 佇列 ----------
function transcriptOf(sid) {
  try { for (const d of fs.readdirSync(PROJECTS)) { const f = path.join(PROJECTS, d, sid + '.jsonl'); if (fs.existsSync(f)) return f; } } catch {}
  return null;
}
function idleMs(file) { try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return Infinity; } }

// 這個對話目前有沒有交工在進行（gemini-takeover 的 100% 接手用來避免重複接手）。
function hasActive(providerId) {
  try {
    for (const f of fs.readdirSync(QUEUE)) {
      if (!f.endsWith('.json')) continue;
      const e = readJson(path.join(QUEUE, f));
      if (e && e.sid === providerId && ['waiting', 'running', 'done', 'notify-pending'].includes(e.status) && Date.now() - Date.parse(e.created) < 6 * 3600e3) return true;
    }
  } catch {}
  return false;
}

// 掃一次佇列：把「交接單寫好、對話停了」的項目啟動；同一時間只跑一個（agy 同時改同一工作區會打架）。
function scanQueue({ dry = false } = {}) {
  let files = []; try { files = fs.readdirSync(QUEUE).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
  const entries = files.map((f) => loadEntry(path.join(QUEUE, f))).filter(Boolean);
  const running = entries.find((e) => e.status === 'running');
  if (running && Date.now() - Date.parse(running.started) > 3 * 3600e3) { running.status = 'error'; running.error = '執行超過 3 小時，視為中斷'; saveEntry(running); log(`running 逾時 ${running.id}`); }
  for (const e of entries) {
    if (e.status !== 'waiting') continue;
    const age = Date.now() - Date.parse(e.created);
    if (!fs.existsSync(e.file)) { if (age > 2 * 3600e3) { e.status = 'expired'; e.note = '2 小時內沒有出現交接單檔案'; saveEntry(e); log(`expired ${e.id}`); } continue; }
    const tr = transcriptOf(e.sid);
    if (idleMs(e.file) < SETTLE_MS || (tr && idleMs(tr) < SETTLE_MS)) continue; // 還在寫或對話還沒停
    if (entries.some((x) => x.status === 'running')) return;
    if (dry) { log(`[dry] would run ${e.id} (${e.file})`); continue; }
    e.status = 'running'; e.started = new Date().toISOString(); saveEntry(e);
    spawn(process.execPath, [__filename, '--run', e.qfile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log(`start ${e.id} sid=${e.sid.slice(0, 8)} cwd=${e.cwd}`);
    return;
  }
}

// ---------- 快照與 diff ----------
function walk(root, fn) {
  const go = (d, depth) => {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (SKIP_DIRS.includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 6) go(p, depth + 1); } else fn(p);
    }
  };
  go(root, 0);
}
const isBak = (p) => /\.bak-gemini/.test(p);
const readText = (p, st) => { if (st.size > 300 * 1024) return null; const b = fs.readFileSync(p); return b.includes(0) ? null : b.toString('utf8'); };
// 每個檔都記大小與修改時間；只有前 400 個小文字檔存內容（拿來 diff 和備份）。
// 以前只記前 400 個檔，大工作區裡其餘舊檔全被當成「新增」（10-31 一次報了 34102 筆）。
function snapshot(root) {
  const snap = new Map(); let n = 0;
  walk(root, (p) => {
    if (isBak(p)) return;
    try {
      const st = fs.statSync(p); let text = null;
      if (n < 400) { text = readText(p, st); if (text !== null) n++; }
      snap.set(p, { size: st.size, mtime: st.mtimeMs, text });
    } catch {}
  });
  return snap;
}
function changes(root, snap) {
  const out = [];
  const now = new Set();
  walk(root, (p) => {
    if (isBak(p)) return; now.add(p);
    try {
      const st = fs.statSync(p); const old = snap.get(p);
      if (!old) { const cur = readText(p, st); if (cur !== null) out.push({ file: p, kind: 'new', after: cur }); return; }
      if (st.size === old.size && st.mtimeMs === old.mtime) return;
      const cur = readText(p, st);
      if (old.text === null) out.push({ file: p, kind: 'modified', before: null, after: cur || '' });
      else if (cur !== old.text) out.push({ file: p, kind: 'modified', before: old.text, after: cur || '' });
    } catch {}
  });
  for (const [p, old] of snap) if (!now.has(p) && !fs.existsSync(p)) out.push({ file: p, kind: 'deleted', before: old.text });
  return out;
}
function diffText(root, c) {
  const rel = path.relative(root, c.file);
  if (c.kind === 'new') return `--- 新增 ${rel} ---\n${c.after.slice(0, 4000)}${c.after.length > 4000 ? '\n…（截斷）' : ''}\n`;
  if (c.kind === 'deleted') return `--- 被刪除 ${rel}（違規）---\n`;
  if (c.before === null) return `--- 修改 ${rel}（改前內容沒有快照，無法比對）---\n`;
  const tmp = path.join(os.tmpdir(), `ho-before-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, c.before);
  try {
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '-U3', '--', tmp, c.file], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.stdout) return `--- ${rel} ---\n` + r.stdout.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join('\n');
  } catch {} finally { try { fs.unlinkSync(tmp); } catch {} }
  return `--- ${rel}（改前）---\n${c.before.slice(0, 2500)}\n--- ${rel}（改後）---\n${c.after.slice(0, 2500)}\n`;
}
// 程式自己確保每個被改的既有檔案都有 .bak-gemini（內容＝改前快照）；已存在但內容不同就另存 .bak-gemini-<runid>。
function ensureBackups(cs, runId) {
  const notes = [];
  for (const c of cs) {
    if (c.kind !== 'modified' && c.kind !== 'deleted') continue;
    if (c.before === null || c.before === undefined) { c.backup = '改前內容沒有快照，無法備份'; continue; }
    const bak = c.file + '.bak-gemini';
    try {
      if (!fs.existsSync(bak)) { fs.writeFileSync(bak, c.before); c.backup = path.basename(bak); }
      else if (fs.readFileSync(bak, 'utf8') === c.before) c.backup = path.basename(bak);
      else { const alt = `${bak}-${runId}`; fs.writeFileSync(alt, c.before); c.backup = path.basename(alt); notes.push(`${path.basename(bak)} 早就存在但內容不是這次改前的樣子（舊的備份），這次改前的原樣另存為 ${path.basename(alt)}`); }
    } catch (e) { c.backup = '備份失敗：' + e.message; }
  }
  return notes;
}

// ---------- agy ----------
function agyCall(prompt, opts = {}, retried = false) {
  const { conv, cwd, sec = AGY_SEC, allow = allowNow } = opts;
  const args = [...(conv ? ['--conversation', conv] : []), '-p', prompt, '--model', curModel, '--mode', 'accept-edits', '--print-timeout', sec + 's', '--output-format', 'json', '--settings', JSON.stringify({ permissions: { allow } })];
  const r = spawnSync(AGY, args, { cwd, encoding: 'utf8', timeout: (sec + 60) * 1000, maxBuffer: 64 << 20, windowsHide: true });
  let o = {}; try { o = JSON.parse(r.stdout); } catch {}
  if (!retried && curModel !== FALLBACK_MODEL && /RESOURCE_EXHAUSTED|quota reached/i.test((r.stdout || '') + (r.stderr || '') + (o.response || ''))) {
    modelNotes.push(`agy 的 ${curModel} 額度用完，改用 ${FALLBACK_MODEL}`); log(modelNotes[modelNotes.length - 1]);
    curModel = FALLBACK_MODEL;
    return agyCall(prompt, { ...opts, conv: undefined }, true); // 換模型就換新對話（舊對話綁原模型）
  }
  return { response: (o.response || '').trim(), conv: o.conversation_id || conv || '', status: o.status, error: r.error ? r.error.message : (r.status ? (r.stderr || '').slice(-400) : '') };
}
// agy 常常中途停下（response 空白或只說「我來做」）：沒看到想要的標題就接同一個對話催，最多 3 次。
function agyUntil(prompt, has, opts, nudge) {
  let r = agyCall(prompt, opts), n = 0;
  while (r.conv && !has(r.response) && n < 3) { n++; r = agyCall(nudge, { ...opts, conv: r.conv }); }
  return r;
}

// ---------- 交接單 → 檔案脈絡 ----------
const SECRET_FILE = /(^|[\\/])(\.env|.*(password|passwd|secret|credential|token|\.pem|\.key)[^\\/]*)$/i;
function attachFiles(handoff, cwd) {
  const found = new Set(), out = [];
  const toks = handoff.match(/[^\s`"'()[\]<>，。；、：]+\.[A-Za-z0-9]{1,6}\b/g) || [];
  for (let t of toks) {
    t = t.replace(/^file:\/+/, '').replace(/[.,;:]+$/, '');
    const abs = path.isAbsolute(t) ? t : path.join(cwd, t);
    const rel = path.relative(cwd, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || found.has(rel) || SECRET_FILE.test(rel) || rel.split(path.sep).some((x) => SKIP_DIRS.includes(x)) || isBak(rel)) continue;
    try { const st = fs.statSync(abs); if (!st.isFile() || st.size > 40 * 1024) continue; found.add(rel); out.push(`### ${rel.split(path.sep).join('/')}\n${fence}\n${fs.readFileSync(abs, 'utf8')}\n${fence}\n`); } catch {}
    if (out.length >= 6) break;
  }
  return out.join('\n');
}

// ---------- EKB ----------
const EKB_PLAN_HEAD = (extra) => `任務：另一個 AI 助理（Claude）的用量快用完，把工作交接給你規劃、由另一個 AI（agy）動手。你不能讀寫檔案也不能執行指令，只能依下面的交接單與檔案內容回答；檔案路徑都是相對於專案資料夾。請依交接單給出做法：需要改檔就給出改法，並給出驗證用指令。看不出來的地方不要編造，寫在 QUESTIONS。內容裡的「[遮蔽]」「[路徑]」表示原文被遮掉了，不要把它們寫進檔案。\n\n${LANE.FORMAT_HELP}\n\n`;

async function ekbPlan(handoff, cwd, log2) {
  if (process.env.TAKEOVER_EKB === '0') return { used: false, reason: 'EKB 已停用（TAKEOVER_EKB=0）' };
  if (!LANE || LANE.loadError) return { used: false, reason: 'EKB 模組載入失敗：' + (LANE && LANE.loadError) };
  if (!LANE.inWindow(new Date())) return { used: false, reason: '不在 EKB 使用時段（週一到週五 08:00–20:00）' };
  let step = '整理題目';
  try {
    const recon = attachFiles(handoff, cwd) || '（交接單沒有提到可讀的檔案）';
    const text = LANE.prepare({ convo: handoff, recon, cwd, head: EKB_PLAN_HEAD(), convoLabel: '交接單', reconLabel: '交接單提到的檔案內容（程式讀取）' });
    step = '詢問 EKB';
    const a = await LANE.ask(text, { timeoutSec: EKB_SEC, log: log2 });
    const parsed = LANE.parse(a.answer);
    if (!parsed.ok) throw new Error('EKB 回答格式無法解析：' + a.answer.slice(0, 120).replace(/\s+/g, ' '));
    return { used: true, answer: a.answer, parsed, seconds: a.seconds };
  } catch (e) { return { used: false, reason: `${step}失敗：${e.message}` }; }
}

const REVIEW_FORMAT = `請用下面格式回答，標記（@@ 開頭）前後各空一行，標記之外不要加說明：

@@VERDICT

（只寫 PASS 或 FIX 其中一個：PASS＝改動符合交接單、沒有錯誤或不安全的地方；FIX＝有問題需要修）

@@ISSUES

（FIX 時逐點列出：哪個檔案、什麼問題、建議怎麼修；PASS 時寫「無」，可以附小建議）

@@END`;

function parseVerdict(t) {
  const m = t.match(/@@VERDICT\s*[:：]?\s*(PASS|FIX)\b/i);
  if (!m) return null;
  const iss = t.split(/@@ISSUES/i)[1];
  return { verdict: m[1].toUpperCase(), issues: (iss || '').split(/@@END/i)[0].trim() };
}

async function ekbReview(handoff, execReport, diff, cwd, log2) {
  if (!LANE || LANE.loadError || process.env.TAKEOVER_EKB === '0' || !LANE.inWindow(new Date())) throw new Error('EKB 目前不可用');
  const head = `任務：下面是一份交接單，以及另一個 AI（agy）依它做出的改動（diff）。請你當審查者，判斷改動是否符合交接單、有沒有邏輯錯誤、遺漏、不安全或超出範圍的地方。你不能讀寫檔案也不能執行指令，只能依下面內容判斷。內容裡的「[遮蔽]」「[路徑]」表示原文被遮掉了。\n\n${REVIEW_FORMAT}\n\n`;
  const room = LANE.MAX_TEXT - head.length - 200;
  const h = LANE.mask(handoff, cwd).slice(0, Math.floor(room * 0.3));
  const rep = LANE.mask(execReport, cwd).slice(0, Math.floor(room * 0.2));
  const d = LANE.mask(diff, cwd).slice(0, Math.max(1500, room - h.length - rep.length));
  const text = `${head}=== 交接單 ===\n${h}\n\n=== agy 的自述 ===\n${rep}\n\n=== 改動 diff ===\n${d}\n`;
  const blocks = LANE.prepBlocks(text);
  if (blocks.length) throw new Error('ekb-prep 擋下：' + blocks.slice(0, 2).join('；'));
  const a = await LANE.ask(text, { timeoutSec: EKB_SEC, log: log2 });
  const v = parseVerdict(a.answer);
  if (!v) throw new Error('EKB 審查回答格式無法解析：' + a.answer.slice(0, 100).replace(/\s+/g, ' '));
  return { ...v, raw: a.answer, who: 'EKB（Opus）', seconds: a.seconds };
}

// ---------- 提示詞 ----------
const RULES = (cwd) => `規則：
1. 只在目前資料夾（${cwd}）裡工作。讀檔、找檔、改檔用內建的檔案工具；系統指令只准用 node、npm test、npm run lint、git status、git diff、git log，其他指令都會被擋。改既有檔案前，先複製一份「原檔名.bak-gemini」。
2. 不准刪除檔案或資料、不准 git commit／push、不准對外寄信或發訊息、不准改帳密或權限、不准動算錢或資料庫的邏輯、不准重啟服務或上線（上線由 Claude 處理）。遇到這些就停下，寫在報告的「待確認」。
3. 不確定交接單要什麼就不要猜，寫在報告的「待確認」。`;
const EXEC_HEADS = '## 做了什麼（每個改動的檔案路徑）\n## 怎麼驗證（實際跑了什麼指令、結果）\n## 還沒做的\n## 待確認';
const hasExecReport = (s) => /做了什麼/.test(s) && /怎麼驗證/.test(s);

function execPrompt(handoff, cwd, plan) {
  const ekb = plan.used
    ? `\n這次分工：公司內部 AI 聊天 EKB（Opus，只能聊天、不能讀寫檔案）已依交接單出了做法，你負責動手＋監督，不是照抄。EKB 的回答是從網頁畫面複製下來的，換行、縮排、反引號可能跑掉，所以一律以現有檔案為準，理解意圖後自己寫出正確的程式碼；它的 @@SEARCH 原文對不上現有檔案、邏輯有錯或不安全就不照做，並在報告說明。EKB 只看過遮蔽後的摘錄，方案裡若出現「[遮蔽]」「[路徑]」字樣不可原樣寫進檔案。\n\n=== EKB 的回答原文 ===\n${plan.answer}\n\n=== 程式預檢 ===\n${plan.parsed.problems.length ? plan.parsed.problems.map((x) => '- ' + x).join('\n') : '- 沒有發現問題'}\n`
    : '\n這次沒有 EKB 的做法可參考，請自己依交接單規劃。完成後會有另一個 AI 審查你的改動。\n';
  return `你接手另一個 AI 助理（Claude）的工作：它的 5 小時用量快用完，把剩下的工作寫成下面的交接單交給你。你做完後，Claude 會用剩下的額度審核、上線並回覆使用者；使用者還不信任你們，每個改動都會被逐一核對。
${RULES(cwd)}
4. 動手前先讀現有檔案。全部做完後執行驗證（交接單的驗收方式與你自己想到的，限上面允許的指令），結果如實寫進報告。
5. 最後一則訊息一定要是繁體中文報告（不要以工具呼叫結束），標題一律用這四個：
${EXEC_HEADS}
${ekb}
=== 交接單（內網 IP、Email、帳密已遮蔽）===
${redact(handoff)}`;
}

function agyReviewPrompt(handoff, diff, execReport, cwd, round) {
  return `你是「審查者」，不是執行者。另一個 AI（agy 執行者）依下面的交接單改了工作區，請你審查它的改動是否符合交接單、有沒有邏輯錯誤、遺漏、不安全或超出範圍（例如刪檔、動帳密、對外送出、算錢或資料庫邏輯）。這是第 ${round} 輪審查。
規則：絕對不要修改、建立或刪除任何檔案（你只讀）；可以用內建檔案工具讀檔，系統指令只准用 node、npm test、git diff，自己驗證改動是否真的有效（例如跑測試）。
${REVIEW_FORMAT}

=== 交接單 ===
${redact(handoff)}

=== 執行者的自述 ===
${redact(execReport).slice(0, 5000)}

=== 改動 diff（程式依快照算出）===
${redact(diff).slice(0, 12000)}`;
}

// ---------- 驗證指令 ----------
function extractCmds(handoff, plan) {
  const set = new Set();
  const cands = [];
  for (const m of handoff.matchAll(/`([^`\n]+)`/g)) cands.push(m[1]);
  for (const m of handoff.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) for (const l of m[1].split('\n')) cands.push(l);
  for (const l of handoff.split('\n')) cands.push(l.replace(/^[\s\-*\d.)、]+/, ''));
  for (const c of cands) { const t = c.trim().replace(/^\$\s*/, ''); if (CMD_OK.test(t)) set.add(t); }
  if (plan && plan.used) for (const c of plan.parsed.cmds) set.add(c);
  return [...set].slice(0, 6);
}
function runCmds(cmds, cwd) {
  return cmds.map((c) => {
    const r = spawnSync(c, { cwd, shell: true, encoding: 'utf8', timeout: 60000, windowsHide: true });
    return { cmd: c, code: r.error ? 'error' : r.status, out: ((r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : '')).trim().slice(-800) };
  });
}

// ---------- 主流程 ----------
async function run(qfile) {
  const e = loadEntry(qfile);
  const runId = new Date().toISOString().replace(/\D/g, '').slice(2, 12);
  const outDir = path.join(e.cwd, '.gemini-takeover');
  fs.mkdirSync(outDir, { recursive: true });
  const report = path.join(outDir, `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${e.sid.slice(0, 8)}.md`);
  const handoff = fs.readFileSync(e.file, 'utf8');
  const hist = []; // 互審紀錄
  const problems = []; // 待 Claude 決定
  const t0 = Date.now();
  let plan = { used: false, reason: '尚未執行' }, execRes = { response: '' }, err = '', cs = [], backupNotes = [], reviewerKind = '';
  const snap = snapshot(e.cwd);
  const log2 = (s) => log(`${e.id} ${s}`);
  log(`run ${e.id} cwd=${e.cwd} handoff=${e.file} (${handoff.length} 字)`);
  try {
    plan = await ekbPlan(handoff, e.cwd, log2);
    allowNow = [...ALLOW, ...extractCmds(handoff, plan).map((c) => `command(${c})`)];
    log2(plan.used ? `EKB 做法 ${plan.seconds}s` : `EKB 略過：${plan.reason}`);
    execRes = agyUntil(execPrompt(handoff, e.cwd, plan), hasExecReport, { cwd: e.cwd }, '請繼續，直接動手把工作做完（同樣遵守前面的規則），不用先說明計畫。全部做完並驗證後，最後一則訊息用繁體中文寫報告，標題用：\n' + EXEC_HEADS);
    if (!execRes.response && !changes(e.cwd, snap).length) throw new Error('agy 執行者沒有產出報告也沒有改任何檔案：' + (execRes.error || execRes.status || '空白回應').toString().slice(0, 200));
    if (!execRes.conv) throw new Error('agy 執行者沒有回應：' + (execRes.error || execRes.status || '空白'));
    log2(`agy 執行 對話 ${execRes.conv.slice(0, 8)} 報告 ${execRes.response.length} 字`);
    let reviewer = { conv: '' }, last = null;
    for (let round = 1; round <= MAX_REVIEWS; round++) {
      cs = changes(e.cwd, snap);
      const diff = cs.map((c) => diffText(e.cwd, c)).join('\n') || '（沒有任何檔案改動）';
      let rv = null, ekbFail = '';
      if (plan.used || (LANE && !LANE.loadError && process.env.TAKEOVER_EKB !== '0' && LANE.inWindow(new Date()))) {
        try { rv = await ekbReview(handoff, execRes.response, diff, e.cwd, log2); } catch (x) { ekbFail = x.message; }
      } else ekbFail = plan.reason || 'EKB 不可用';
      if (!rv) { // 退回另一個 agy 對話當審查者（對話 B，不同於執行者的對話 A）
        const key = (c) => `${c.file}|${c.kind}|${(c.after || '').length}`;
        const before = new Set(changes(e.cwd, snap).map(key));
        const r = agyUntil(reviewer.conv ? `第 ${round} 輪審查。執行者已回應你上一輪的意見並修改，最新 diff 如下，請重新審查，格式同前。\n\n${redact(diff).slice(0, 12000)}\n\n執行者的回應：\n${redact(execRes.response).slice(0, 4000)}` : agyReviewPrompt(handoff, diff, execRes.response, e.cwd, round),
          (s) => !!parseVerdict(s), { cwd: e.cwd, conv: reviewer.conv || undefined, sec: 600 }, '請現在直接依格式回答（@@VERDICT 與 @@ISSUES），不要修改任何檔案。');
        reviewer.conv = r.conv;
        const after = new Set(changes(e.cwd, snap).map(key));
        const wrote = [...after].filter((x) => !before.has(x)).map((x) => path.relative(e.cwd, x.split('|')[0]));
        // 別的程序（例如代理程式的 results\*.json）同時寫檔也會算進來，列出檔名讓 Claude 判斷
        if (wrote.length) problems.push(`⚠ 第 ${round} 輪 agy 審查者審查期間工作區有 ${wrote.length} 處檔案變動（可能是審查者違反「只讀」，也可能是別的程序）：${wrote.slice(0, 10).join('、')}${wrote.length > 10 ? '…' : ''}`);
        const v = parseVerdict(r.response);
        rv = v ? { ...v, raw: r.response, who: `agy 審查者（對話 ${(r.conv || '').slice(0, 8)}，與執行者不同對話）` } : { verdict: 'FIX', issues: '審查者沒有給出可解析的結論：' + (r.response.slice(0, 200) || r.error || '空白'), raw: r.response, who: 'agy 審查者', unparsable: true };
        reviewerKind = 'agy';
      } else reviewerKind = reviewerKind || 'EKB';
      hist.push({ round, who: rv.who, verdict: rv.verdict, issues: rv.issues, fallback: ekbFail, fix: '' });
      log2(`第 ${round} 輪審查 ${rv.who}：${rv.verdict}`);
      last = rv;
      if (rv.verdict === 'PASS') break;
      if (rv.unparsable) { problems.push('審查者回答無法解析，這輪沒有有效審查'); break; }
      if (round === MAX_REVIEWS) { problems.push(`審查 ${MAX_REVIEWS} 輪後仍有未解決意見（見「雙方互審意見」最後一輪）`); break; }
      const fx = agyUntil(`審查者（${rv.who}）看了你的改動，提出下面意見。請逐點判斷：對的就修改；你認為審查者錯了就不改並說明理由（有憑據，例如跑出來的結果）。修完後重跑驗證，最後一則訊息用繁體中文報告，標題同前（${EXEC_HEADS.replace(/\n/g, '、')}），並在「做了什麼」裡逐點寫「採納」或「不採納＋理由」。\n\n${redact(rv.issues)}`,
        hasExecReport, { cwd: e.cwd, conv: execRes.conv }, '請繼續，直接處理審查意見並用同樣的標題寫報告。');
      hist[hist.length - 1].fix = fx.response || '（執行者沒有回應）';
      if (fx.response) execRes.response = fx.response;
    }
    if (last && last.verdict !== 'PASS' && !problems.some((p) => /未解決/.test(p)) && !last.unparsable) problems.push('最後一輪審查不是 PASS');
  } catch (x) { err = x.stack || String(x); problems.push('流程中斷：' + x.message); log2('error ' + x.message); }

  cs = changes(e.cwd, snap);
  backupNotes = ensureBackups(cs, runId);
  const deleted = cs.filter((c) => c.kind === 'deleted');
  if (deleted.length) problems.push('⚠ 有檔案被刪除（違反規則）：' + deleted.map((c) => path.relative(e.cwd, c.file)).join('、'));
  const ver = runCmds(extractCmds(handoff, plan), e.cwd);
  if (!ver.length) problems.push('交接單沒有可自動執行的驗證指令（只認 node …、npm test、npm run lint），驗證結果只有 agy 的自述');
  for (const v of ver) if (v.code !== 0) problems.push(`程式自己跑 ${v.cmd} 失敗（exit ${v.code}）`);
  const asked = (execRes.response.split(/##\s*待確認/)[1] || '').trim();
  if (asked && !/^(無|沒有|none)[。.\s]*$/i.test(asked)) problems.push('agy 的「待確認」：' + asked.slice(0, 400));

  const lane = plan.used ? `EKB（Opus）出做法 ${plan.seconds} 秒；執行者 agy（${curModel}）；審查者 ${reviewerKind === 'agy' ? 'agy 另一個對話（EKB 審查不可用）' : 'EKB'}` : `EKB 沒有參與（${plan.reason}）；執行者 agy 對話 A；審查者 agy 另一個對話 B`;
  const md = [
    `# ⚠️【交工：EKB＋agy・未經 Claude 審核】`,
    '',
    `> Claude 的 5 小時用量達門檻後，剩下的工作由 EKB 與 agy 互相監督做完。使用者還不信任它們：每個改動都要由 Claude 對照備份逐一核對、實際跑驗證後才算數，有錯就修或還原。`,
    '',
    `- 對話：${e.sid}（${e.kind === 'user' ? '使用者在用量 ' + e.percent + '% 之後送出的新訊息' : 'Claude 在用量 ' + e.percent + '% 時寫的交接單'}）`,
    `- 分工：${lane}`,
    ...modelNotes.map((n) => '- ⚠ 模型：' + n),
    `- 開始：${new Date(t0).toISOString()}　結束：${new Date().toISOString()}`,
    `- 結果：${err ? '流程中斷（見文末錯誤）' : problems.length ? '流程跑完，但有待 Claude 決定的事（見文末）' : '做完，雙方審查通過'}`,
    '', '## 交接單要求', '', `來源檔：${e.file}`, '', fence, handoff.trim(), fence,
    '', '## EKB 提的', '',
    plan.used ? `EKB 摘要：${plan.parsed.summary || '（無）'}\n\n程式預檢：${plan.parsed.problems.length ? '\n' + plan.parsed.problems.map((x) => '- ' + x).join('\n') : '沒有發現問題'}\n\n原始回答（程式存檔，非 agy 轉述）：\n\n${fence}\n${plan.answer}\n${fence}` : `沒有參與。原因：${plan.reason}`,
    '', '## agy 做的（執行者自述）', '', execRes.response || '（agy 沒有留下報告文字）',
    '', '## 雙方互審意見（誰挑了誰什麼錯、怎麼處理）', '',
    hist.length ? hist.map((h) => `### 第 ${h.round} 輪：${h.who} → ${h.verdict}${h.fallback ? `（EKB 審查不可用：${h.fallback}，改由 agy 審查者）` : ''}\n\n審查意見：\n\n${h.issues || '（無）'}\n\n${h.verdict === 'FIX' ? '執行者 agy 的處理：\n\n' + (h.fix || '（沒有再修，審查已結束）') + '\n' : ''}`).join('\n') : '（沒有進行審查）',
    '## 改動檔案清單（程式依快照自動列出）', '',
    cs.length ? cs.map((c) => `- ${c.kind === 'new' ? '新增' : c.kind === 'deleted' ? '⚠刪除' : '修改'}：${path.relative(e.cwd, c.file)}${c.backup ? `（備份：${c.backup}）` : ''}`).join('\n') : '- （沒有任何改動）',
    ...backupNotes.map((n) => '- 備份備註：' + n),
    '', '## 驗證結果（程式自己跑的，不是 agy 自述）', '',
    ver.length ? ver.map((v) => `- \`${v.cmd}\` → exit ${v.code}\n${fence}\n${v.out || '（無輸出）'}\n${fence}`).join('\n') : '- （沒有可自動執行的驗證指令）',
    '', '## 待 Claude 決定的事', '',
    problems.length ? problems.map((p) => '- ' + p).join('\n') : '- 無（但仍請逐一核對改動）',
    err ? `\n## 錯誤\n\n${fence}\n${err}\n${fence}` : '', '',
  ].join('\n');
  fs.writeFileSync(report, md);
  const fin = loadEntry(qfile);
  Object.assign(fin, { status: 'done', report, finished: new Date().toISOString(), ok: !err, problems: problems.length, lane: plan.used ? 'ekb+agy' : 'agy+agy' });
  saveEntry(fin);
  log(`done ${e.id} -> ${report} (問題 ${problems.length})`);
  await notify(qfile).catch((x) => log('notify error ' + x.message));
}

// ---------- 通知 Claude ----------
function permissionModeOf(tr) {
  if (!tr) return 'bypassPermissions'; // DHC CLI 預設 bypass；找不到對話紀錄時的備案
  try { const m = [...fs.readFileSync(tr, 'utf8').matchAll(/"permissionMode":"(\w+)"/g)].pop(); return m ? m[1] : 'default'; } catch { return 'default'; }
}
function sendWs(WebSocket, sessionId, model, permissionMode, content) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:3001/ws');
    const finish = (r) => { try { ws.close(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish('sent (no reply frame within 20 s)'), 20000);
    ws.on('error', (x) => { clearTimeout(timer); finish('ws error ' + x.message); });
    ws.on('open', () => {
      const skip = permissionMode === 'bypassPermissions';
      ws.send(JSON.stringify({ type: 'chat.send', sessionId, content, options: { model, permissionMode, toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: skip }, skipPermissions: skip, attachments: [] } }));
    });
    ws.on('message', (data) => {
      let f; try { f = JSON.parse(data.toString()); } catch { return; }
      if (f.sessionId !== sessionId) return;
      clearTimeout(timer);
      finish(f.kind === 'protocol_error' || f.kind === 'error' ? `failed ${f.code || ''} ${String(f.error || '').slice(0, 150)}` : 'started');
    });
  });
}
function doneMessage(e) {
  return `${DONE_MARK}報告在 ${e.report}。${e.kind === 'user' ? `（這是使用者在用量 ${e.percent}% 之後送出、被轉給 EKB＋agy 的訊息，原話在報告的「交接單要求」。）` : ''}${e.ok ? '' : '（這次流程中斷，報告裡有錯誤，請特別小心。）'}請用剩下的額度：\n1. 讀報告並把每個改動跟 .bak-gemini 逐一比對、實際跑驗證，有錯就修或還原；\n2. 需要上線就上線；\n3. 回覆使用者，開頭先列 EKB＋agy 做了什麼與你的核對結果。`;
}
// 送「交工完成」。用量 ≥100%、對話還在跑、01:00–06:00 → 先不送（status=notify-pending，之後由 --loop 重試）。
async function notify(qfile) {
  const e = loadEntry(qfile);
  if (!e || !['done', 'notify-pending'].includes(e.status)) return 'skip';
  const msg = doneMessage(e);
  const usage = require('./usage.cjs');
  let pct = null; try { pct = (await usage.poll()).session.percent; } catch {}
  const ov = process.env.TAKEOVER_USAGE_OVERRIDE; if (ov) pct = Number(ov);
  const hold = (why) => { e.status = 'notify-pending'; e.holdReason = why; saveEntry(e); log(`notify hold ${e.id}: ${why}`); return 'hold'; };
  const h = new Date().getHours();
  if (pct !== null && pct >= 100) return hold('用量 100%，等重置');
  if (h >= 1 && h < 6 && !process.env.TAKEOVER_NOTIFY_DRY) return hold('01:00–06:00 不送（維持晨檢視窗）');
  const tr = transcriptOf(e.sid);
  if (tr && idleMs(tr) < 60e3) return hold('對話還在跑（紀錄 60 秒內有更新）');
  if (process.env.TAKEOVER_NOTIFY_DRY) { console.log('【乾跑】會送到對話 ' + e.sid + ' 的訊息：\n' + msg); e.status = 'notified'; e.notify = 'dry-run'; saveEntry(e); return 'dry'; }
  const CLOUDCLI = 'D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/';
  const WebSocket = require(CLOUDCLI + 'ws'), Database = require(CLOUDCLI + 'better-sqlite3');
  const db = new Database(process.env.AUTO_RESUME_DB || 'D:/TAS/cc-web/data/auth.db', { readonly: true });
  const row = db.prepare('SELECT session_id, model, isArchived FROM sessions WHERE provider_session_id = ? ORDER BY updated_at DESC LIMIT 1').get(e.sid);
  db.close();
  if (!row || row.isArchived) { e.status = 'notified'; e.notify = 'skip: ' + (row ? '對話已封存' : '不是網頁版對話'); saveEntry(e); log(`notify skip ${e.id}: ${e.notify}`); return 'skip'; }
  const r = await sendWs(WebSocket, row.session_id, row.model || 'default', permissionModeOf(tr), msg);
  e.notifyTries = (e.notifyTries || 0) + 1;
  if (r.startsWith('failed') || r.startsWith('ws error')) { e.status = e.notifyTries >= 5 ? 'notify-failed' : 'notify-pending'; e.holdReason = r; }
  else { e.status = 'notified'; e.notify = r; }
  saveEntry(e); log(`notify ${e.id}: ${r}`);
  return r;
}
let notifying = false;
async function notifyPending() {
  if (notifying) return; notifying = true;
  try {
    let files = []; try { files = fs.readdirSync(QUEUE).filter((f) => f.endsWith('.json')); } catch {}
    for (const f of files) { const e = readJson(path.join(QUEUE, f)); if (e && e.status === 'notify-pending') { await notify(path.join(QUEUE, f)); break; } }
  } finally { notifying = false; }
}

module.exports = { scanQueue, notifyPending, hasActive, run, notify, snapshot, changes, diffText, parseVerdict, extractCmds, attachFiles, doneMessage, DONE_MARK };

if (require.main === module) {
  const a = process.argv;
  if (a.includes('--run')) run(a[a.indexOf('--run') + 1]).catch((x) => { log('error ' + x.stack); process.exit(1); });
  else if (a.includes('--notify')) notify(a[a.indexOf('--notify') + 1]).then((r) => console.log(r));
  else if (a.includes('--scan')) scanQueue({ dry: a.includes('--dry') });
}
