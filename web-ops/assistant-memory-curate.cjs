'use strict';
// Nightly memory consolidation for the chat-room assistant (hermes-style curation).
// For each memory file over ~20 lines or ~2 KB: ask local claude.exe (Sonnet, isolated: no tools, no MCP, no settings,
// no session persistence; same flags as D:\TAS\jev\judge.cjs) to merge duplicates, keep the newer of superseded facts,
// drop stale or one-off items and keep explicit preferences verbatim. The result replaces the file only if it passes
// the checks below; the original is copied to memory\.history\<file>.<yyyyMMdd> first (newest 14 kept).
// Usage: node assistant-memory-curate.cjs [--dry]   (--dry: ask and report, write nothing but curation.log)
// Env (tests): ASSISTANT_MEMORY_DIR, CURATE_CLAUDE_EXE.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DRY = process.argv.includes('--dry');
const MEMORY_DIR = process.env.ASSISTANT_MEMORY_DIR || path.join(os.homedir(), '.cloudcli', 'assistant', 'memory');
const HISTORY_DIR = path.join(MEMORY_DIR, '.history');
const LOG = path.join(MEMORY_DIR, 'curation.log');
const CLAUDE_EXE = process.env.CURATE_CLAUDE_EXE || 'D:\\TAS\\cc-host\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const TOKEN_FILE = 'C:\\Users\\demo\\.tas\\claude-token.txt';
const MODEL = 'sonnet';
const MIN_LINES = 20;
const MIN_BYTES = 2048;
const QUIET_MS = 10 * 60 * 1000;
const MIN_KEEP_RATIO = 0.3; // more than 70% shorter is rejected
const KEEP_HISTORY = 14;
const TIMEOUT_MS = 240_000;
const LINE_RE = /^- \d{4}-\d{2}-\d{2} \S.*$/;

const SYSTEM = [
  '你整理一份 AI 助理的長期記憶檔。每行格式是「- YYYY-MM-DD 內容」，由舊到新。',
  '請輸出整理後的完整檔案內容，規則：',
  '1. 合併重複或意思相同的條目，保留最新那條的日期。',
  '2. 同一件事前後矛盾時，以日期較新的為準，刪掉過時的舊條目。',
  '3. 刪掉過期的、一次性的、只是閒聊或進度紀錄的條目；長期有效的事實與規則要留。',
  '4. 每個人明確說出的偏好與規則（回覆長度、稱呼、常用資料夾、固定做法）逐字保留，不改寫、不縮短。',
  '5. 條目結尾的「（某某說）」標記保留。不要新增原檔沒有的資訊，不要改動數字、路徑、名稱。',
  '6. 格式維持每行「- YYYY-MM-DD 內容」，日期不可省略；由舊到新排序。',
  '只輸出整理後的檔案內容本身，不要說明、標題、程式碼框。',
].join('\n');

const stamp = () => new Date().toISOString();
const log = (line) => { try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); fs.appendFileSync(LOG, `${stamp()}\t${DRY ? '[dry] ' : ''}${line}\n`); } catch {} };
const say = (line) => console.log(line);

function claudeEnv() {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    try { env.CLAUDE_CODE_OAUTH_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/)[0].trim(); } catch {}
  }
  return env;
}

// One isolated claude.exe -p call in an empty temp cwd, prompt on stdin. Resolves to the model text or throws.
function askClaude(prompt) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'curate-'));
  const args = ['-p', '--model', MODEL, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--no-session-persistence', '--disable-slash-commands', '--system-prompt', SYSTEM, '--output-format', 'json'];
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', done = false;
    const child = spawn(CLAUDE_EXE, args, { cwd, env: claudeEnv(), windowsHide: true });
    const finish = (fn, value) => {
      if (done) return; done = true; clearTimeout(timer);
      try { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
      fn(value);
    };
    const timer = setTimeout(() => {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill(); }
      finish(reject, new Error('timeout'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish(reject, new Error('spawn:' + e.message)));
    child.on('close', () => {
      let env;
      try { env = JSON.parse(stdout); } catch { return finish(reject, new Error('cli-json:' + stderr.slice(0, 80))); }
      if (env.is_error) return finish(reject, new Error('cli-error:' + String(env.result || env.subtype || '').slice(0, 80)));
      finish(resolve, String(env.result || ''));
    });
    child.stdin.end(prompt);
  });
}

// The answer must be only well-formed memory lines, not empty, and not more than 70% shorter than the original.
function check(original, answer) {
  const text = answer.replace(/^```[a-z]*\r?\n|\r?\n```\s*$/g, '').trim();
  if (!text) return { ok: false, why: '空白' };
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const bad = lines.find((l) => !LINE_RE.test(l));
  if (bad) return { ok: false, why: '格式不符：' + bad.slice(0, 40) };
  const next = lines.join('\n') + '\n';
  if (Buffer.byteLength(next, 'utf8') < Buffer.byteLength(original, 'utf8') * MIN_KEEP_RATIO) return { ok: false, why: '縮減超過 70%' };
  return { ok: true, lines, text: next };
}

const ymd = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };

function backup(file, original) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const dest = path.join(HISTORY_DIR, `${file}.${ymd()}`);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, original, 'utf8'); // a same-day rerun keeps the first, more original copy
  // Only files this script writes (<name>.<8 digits>) are rotated.
  const mine = fs.readdirSync(HISTORY_DIR).filter((n) => n.startsWith(file + '.') && /^\d{8}$/.test(n.slice(file.length + 1))).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_HISTORY))) fs.rmSync(path.join(HISTORY_DIR, old), { force: true });
}

const diffSummary = (before, after) => {
  const a = new Set(before), b = new Set(after);
  return `${before.length}→${after.length} 行，刪 ${before.filter((l) => !b.has(l)).length}、新增或改寫 ${after.filter((l) => !a.has(l)).length}`;
};

async function main() {
  let names = [];
  try { names = fs.readdirSync(MEMORY_DIR).filter((n) => /\.md$/.test(n)).sort(); } catch (e) { say('memory dir unreadable: ' + e.message); log('error\t' + e.message); return 1; }
  const totals = { files: 0, curated: 0, before: 0, after: 0 };
  for (const name of names) {
    const file = path.join(MEMORY_DIR, name);
    let stat, original;
    try { stat = fs.statSync(file); original = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const before = original.split(/\r?\n/).filter(Boolean);
    if (before.length <= MIN_LINES && stat.size <= MIN_BYTES) { say(`skip ${name}: small (${before.length} lines, ${stat.size} B)`); continue; }
    totals.files += 1;
    if (Date.now() - stat.mtimeMs < QUIET_MS) { say(`skip ${name}: modified in the last 10 minutes`); log(`略過\t${name}\t10 分鐘內有改動`); continue; }
    let answer;
    try { answer = await askClaude(original); } catch (e) { say(`FAIL ${name}: ${e.message}`); log(`失敗\t${name}\t${e.message}`); continue; }
    const result = check(original, answer);
    if (!result.ok) { say(`REJECT ${name}: ${result.why}`); log(`拒絕\t${name}\t${result.why}\t保留原檔`); continue; }
    const summary = diffSummary(before, result.lines);
    totals.before += before.length; totals.after += result.lines.length;
    if (result.text === original.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')) { say(`same ${name}: no change`); log(`無變動\t${name}`); continue; }
    if (DRY) { say(`would curate ${name}: ${summary}`); log(`整理（未寫入）\t${name}\t${summary}`); totals.curated += 1; continue; }
    // The server may have appended while Sonnet was thinking: write only if the file is unchanged since it was read.
    if (fs.statSync(file).mtimeMs !== stat.mtimeMs) { say(`skip ${name}: changed while curating`); log(`略過\t${name}\t整理期間檔案被改動`); continue; }
    backup(name, original);
    fs.writeFileSync(file + '.tmp', result.text, 'utf8');
    fs.renameSync(file + '.tmp', file);
    say(`curated ${name}: ${summary}`); log(`整理\t${name}\t${summary}`); totals.curated += 1;
  }
  say(`done: ${totals.files} candidate files, ${totals.curated} ${DRY ? 'would change' : 'changed'}, lines ${totals.before} -> ${totals.after} (candidates only)`);
  return 0;
}

main().then((code) => process.exit(code), (e) => { log('error\t' + e.message); console.error(e); process.exit(1); });
