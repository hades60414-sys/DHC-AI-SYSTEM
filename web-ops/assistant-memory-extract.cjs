'use strict';
// 10/31 memory extraction for the chat-room assistant. The answering model rarely fills `remember` (某證券's file got
// nothing new in 186 messages after the 10-21 seeds), so after a private-chat answer with an empty `remember` the server
// runs this once: Haiku reads the person's message, the answer and what is already remembered, and lists the new
// long-lasting facts about the person or their work. Isolated like assistant-memory-curate.cjs (no tools, no MCP, no
// settings, no session). stdin: {"said","reply","memory"}; stdout: JSON array of strings (empty on any failure).
// Env (tests): EXTRACT_CLAUDE_EXE.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLAUDE_EXE = process.env.EXTRACT_CLAUDE_EXE || 'D:\\TAS\\cc-host\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const TOKEN_FILE = 'C:\\Users\\demo\\.tas\\claude-token.txt';
const MODEL = 'haiku';
const TIMEOUT_MS = 60_000;
const MAX_ITEMS = 3;
const MAX_CHARS = 200;
// Never keep anything that looks like a secret value.
const SECRET = /(密碼|password|passwd|pwd|token|secret|api[_ ]?key)\s*[:=：是]\s*\S|[A-Za-z0-9+/_-]{32,}/i;

const SYSTEM = [
  '你幫證券中台團隊的聊天室助理整理長期記憶。輸入是同事的一則訊息、助理的回覆、助理已經記下關於這位同事的事。',
  '列出這次對話裡「之後還用得上」的新事實，只記同事本人說的或助理查證到、和他的工作有關的：',
  '- 他的偏好、做法、交代的規則（回覆格式、稱呼、常用資料夾）',
  '- 他的電腦、主機、帳號環境的事實（例：srv-src 是 24 核、192GB RAM；他的電腦是 pc-mgr）',
  '- 他做的決定、他負責或常做的工作、專案名稱與現況',
  '不要記：一次性的問答內容、閒聊、助理自己的道歉或進度、已經記過的事、密碼或任何帳密值、別人的私事。',
  '每條一句、120 字內、寫成第三人稱事實（例「他的 srv-src 清空後想拿來放本地模型」）。沒有就輸出 []。',
  `只輸出 JSON 字串陣列，最多 ${MAX_ITEMS} 條，不要其他文字。`,
].join('\n');

function claudeEnv() {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    try { env.CLAUDE_CODE_OAUTH_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/)[0].trim(); } catch {}
  }
  return env;
}

function askClaude(prompt) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-'));
  const args = ['-p', '--model', MODEL, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--no-session-persistence', '--disable-slash-commands', '--system-prompt', SYSTEM, '--output-format', 'json'];
  return new Promise((resolve, reject) => {
    let stdout = '', done = false;
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
    child.on('error', (e) => finish(reject, new Error('spawn:' + e.message)));
    child.on('close', () => {
      let env;
      try { env = JSON.parse(stdout); } catch { return finish(reject, new Error('cli-json')); }
      if (env.is_error) return finish(reject, new Error('cli-error'));
      finish(resolve, String(env.result || ''));
    });
    child.stdin.end(prompt);
  });
}

/** The model's text → at most MAX_ITEMS one-line strings, secrets dropped. */
function parseItems(text) {
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return [];
  let list;
  try { list = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((item) => typeof item === 'string')
    .map((item) => Array.from(item.replace(/\s+/g, ' ').trim()).slice(0, MAX_CHARS).join(''))
    .filter((item) => item && !SECRET.test(item))
    .slice(0, MAX_ITEMS);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let said = '', reply = '', memory = '';
  try { ({ said = '', reply = '', memory = '' } = JSON.parse(input)); } catch { process.stdout.write('[]'); return; }
  const prompt = [
    '已經記下的事：', String(memory).trim() || '（還沒有）', '',
    '同事這則訊息：', String(said).slice(0, 3000), '',
    '助理的回覆：', String(reply).slice(0, 3000),
  ].join('\n');
  try {
    process.stdout.write(JSON.stringify(parseItems(await askClaude(prompt))));
  } catch {
    process.stdout.write('[]');
  }
}

if (require.main === module) main();
module.exports = { parseItems, SECRET };
