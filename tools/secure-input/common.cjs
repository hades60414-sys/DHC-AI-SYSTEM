// 安全輸入（2026-10-29，仿 ChatGPT 私密登入表單）：使用者在一次性網頁填帳密，值直送那台代理程式存成使用者環境變數。
// 值只出現在：使用者瀏覽器 → Cloudflare → seal-proxy 記憶體 → deliver.cjs 的 stdin → ragent-mcp 暫存檔（送出即刪）→ 加密工作 → 那台的使用者環境變數。
// 不進聊天、模型、log；這裡的單據只記機器、名稱、字數。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const DIR = __dirname, PENDING = path.join(DIR, 'pending'), DONE = path.join(DIR, 'done');
const TTL_MS = 15 * 60000;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}_(PWD|PASS|TOKEN|OTP|USER)$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
// 前門網址會輪換（TAS-Rotate），開單時向代理程式信箱的 /_where 問現在的；前門有密碼閘，只有登入過網頁版的瀏覽器打得開。
const MAILBOX = 'https://<worker>.<account>.workers.dev';
async function frontUrl() { const r = await fetch(MAILBOX + '/_where'); const u = (await r.json()).url; if (!/^https:\/\/[a-z0-9-]+\.<account>\.workers\.dev$/.test(u)) throw new Error('查不到前門網址：' + u); return u; }
const USER_PROJECT = '00000000-0000-0000-0000-000000000000';
const keyOf = (token) => crypto.createHash('sha256').update(token).digest('hex');   // 單據檔名用雜湊，硬碟上找不回連結
const pendingPath = (token) => path.join(PENDING, keyOf(token) + '.json');
const log = (line) => fs.appendFileSync(path.join(DIR, 'secure-input.log'), `${new Date().toISOString()}\t${line}\n`, 'utf8');
module.exports = { DIR, PENDING, DONE, TTL_MS, NAME_RE, TOKEN_RE, frontUrl, USER_PROJECT, keyOf, pendingPath, log };
// 2026-10-29 安全審查：
// - 不能存到 AI 自己所在的主機（srv-main＝pcmain）：那台的使用者環境變數 AI 直接讀得到，遮蔽只管代理程式的輸出。測試才用 SECURE_INPUT_ALLOW_HOST=1。
// - 別的工具在用的變數名（CLAUDE_、GH_、NPM_、RAGENT_…）不能存，免得換掉 AI 或工具的登入。
// - 遮蔽是比對原文：值只收可列印 ASCII；要遮蔽的至少 6 字（4 位數可用逐一 echo 試出來）。
const HOST_MACHINES = ['pcmain'];
const TOOL_RE = /^(CLAUDE|ANTHROPIC|OPENAI|GH|GITHUB|GIT|NODE|NPM|HF|HUGGINGFACE|AWS|AZURE|GOOGLE|CLOUDFLARE|CF|RAGENT|TASUI)_/i;
const minChars = (name) => (/_USER$/.test(name) ? 2 : 6);
const valueProblem = (name, v) => (v.length < minChars(name) || v.length > 512 || /[^\x20-\x7e]/.test(v)) ? `要 ${minChars(name)}–512 個英數或符號（不收中文、空白以外的特殊字元與換行）` : null;
Object.assign(module.exports, { HOST_MACHINES, TOOL_RE, minChars, valueProblem });
