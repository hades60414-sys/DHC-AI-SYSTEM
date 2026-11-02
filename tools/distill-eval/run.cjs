#!/usr/bin/env node
// 蒸餾模式提問評測：用模擬使用者（心裡藏著 H1..H6 的隱性標準）跟真的 Claude（帶某一版燒杯說明）跑幾回合，
// 再由評審讀決策紀錄，算出問出並記下了幾條、問了幾題、使用者有多煩。
// 用法：node run.cjs <版本資料夾名> [情境名,...] [--turns 4] [--tag 名稱]
//   版本資料夾 versions/<版本>/ 放 README.md 與 note.txt（note 裡的 {README} 會換成沙盒 README 的路徑）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HERE = __dirname;
const LIVE_ROOT = 'D:\\TAS\\Claude Code專案\\蒸餾任務';
const CLAUDE = 'D:/TAS/cc-host/claude.cmd';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const TURNS = Number(flag('--turns', 4));
const TAG = flag('--tag', new Date().toISOString().slice(5, 16).replace(/[-:T]/g, ''));
const [VER, only] = args;
const scenarios = JSON.parse(fs.readFileSync(path.join(HERE, 'scenarios.json'), 'utf8')).filter((s) => !only || only.split(',').includes(s.name));

function run(argv, cwd, input) {
  return new Promise((resolve) => {
    const p = spawn(CLAUDE, argv, { cwd, shell: true, env: { ...process.env, NODE_ENV: 'production' } });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ out, err, code }));
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

// cmd.exe 會吃掉引號與換行，長字串一律經檔案或 stdin 傳。
async function agentTurn(ws, notePath, msg, sid) {
  const argv = ['-p', '--model', 'opus', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
    '--append-system-prompt-file', `"${notePath}"`];
  if (sid) argv.push('--resume', sid);
  const { out, err } = await run(argv, ws, msg);
  const texts = [];
  let session = sid;
  for (const line of out.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.session_id) session = e.session_id;
    if (e.type === 'assistant') for (const b of e.message.content || []) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
  }
  if (!texts.length) texts.push(`（沒有回覆）${err.slice(0, 300)}`);
  return { text: texts.join('\n\n'), session };
}

async function judgeCall(prompt, cwd) {
  const { out } = await run(['-p', '--model', 'sonnet', '--setting-sources', 'project', '--output-format', 'text'], cwd, prompt);
  const m = out.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m[0]); } catch { return { parseError: out.slice(0, 500) }; }
}

function simPrompt(s, transcript, turnNo) {
  return `你在扮演一位證券自營中台的使用者，正透過網頁跟 AI 助手協作。只輸出一個 JSON，不要其他文字。

你心裡的工作標準（AI 看不到）：
${s.hidden.join('\n')}

扮演規則：
- 你不會主動說出這些標準或原因。${s.behavior}
- AI 問你一個具體的問題、而答案就在上面某條標準裡：照實簡短回答，原因也可以說（這是真實的你）。
- AI 問抽象問題（「你的標準是什麼」「還有什麼偏好」「有什麼要補充」）：只簡短回一句，最多透露一條。
- AI 問它自己查檔案就知道的事、或跟工作無關的事：回「這你自己看」之類的一句。
- AI 附了猜測讓你回「對」：猜對就回對，猜錯就簡短改正。
- 你很忙，訊息最多 3 句。AI 沒問問題、成果也沒違反你的標準時，可以只說下一步或「可以」。
- 這是第 ${turnNo} 則訊息。

到目前為止的對話：
${transcript}

輸出格式：{"message":"你要送出的訊息","revealed":["這則訊息透露了哪幾條標準，如 H2"],"annoyance":0到3的整數（AI 上一則的提問讓你多煩：0 沒問或問得剛好、1 有點多、2 煩、3 很煩想關掉這功能）,"why":"一句話"}`;
}

function readLogs(root) {
  const found = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.md$/.test(f.name) && !/README|結案步驟/.test(f.name)) found.push(`### ${path.relative(root, p)}\n${fs.readFileSync(p, 'utf8')}`);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found.join('\n\n') || '（沒有任何蒸餾紀錄檔）';
}

function judgePrompt(s, transcript, logs) {
  return `你是評審。只輸出一個 JSON，不要其他文字。

情境：AI 助手在「蒸餾模式」下幫使用者做事；蒸餾模式要求它把使用者的判斷與理由記進決策紀錄，結案時整理成技能。
使用者心裡藏著這些標準（AI 看不到）：
${s.hidden.join('\n')}

對話：
${transcript}

AI 寫下的蒸餾紀錄檔：
${logs}

請判斷：
1. recorded：每條 H 是否出現在蒸餾紀錄檔裡（內容對得上即可）。reason=紀錄裡有寫到那條的理由（H 句子裡「因為／所以」後面的部分或同義）。
2. questions：AI 在對話中問使用者的每一個問題（包括正事需要的澄清問題與蒸餾用的提問）。kind 只能是：
   concrete（錨定在具體發生的事、問出判斷或理由、好答）、abstract（空泛，例如你的標準是什麼）、ondisk（AI 自己查得到）、redundant（重複或已答過）、blocking（因為問而沒先把正事做完）。
3. task：使用者要的成果有沒有做出來（檔案存在且大致可用）。

格式：{"recorded":[{"id":"H1","present":true,"reason":true}],"questions":[{"q":"問題摘要","kind":"concrete"}],"task":true,"note":"一句話"}`;
}

async function episode(s) {
  const root = path.join(os.tmpdir(), 'de', TAG, VER, s.name);
  fs.rmSync(root, { recursive: true, force: true });
  const ws = path.join(root, 'ws');
  const dist = path.join(root, '蒸餾任務');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(dist, { recursive: true });
  for (const [f, c] of Object.entries(s.files)) fs.writeFileSync(path.join(ws, f), c);
  const vdir = path.join(HERE, 'versions', VER);
  const readme = fs.readFileSync(path.join(vdir, 'README.md'), 'utf8').split(LIVE_ROOT).join(dist);
  fs.writeFileSync(path.join(dist, 'README.md'), readme);
  fs.copyFileSync(path.join(HERE, 'versions', '結案步驟.md'), path.join(dist, '結案步驟.md'));
  const notePath = path.join(root, 'note.txt');
  fs.writeFileSync(notePath, fs.readFileSync(path.join(vdir, 'note.txt'), 'utf8').split('{README}').join(path.join(dist, 'README.md')));
  const simDir = path.join(root, 'sim');
  fs.mkdirSync(simDir);

  let msg = s.opening;
  let sid = null;
  let transcript = '';
  const sims = [];
  for (let t = 1; t <= TURNS; t++) {
    transcript += `\n【使用者】${msg}\n`;
    const r = await agentTurn(ws, notePath, msg, sid);
    sid = r.session;
    transcript += `\n【AI】${r.text}\n`;
    if (t === TURNS) break;
    const sim = await judgeCall(simPrompt(s, transcript, t + 1), simDir);
    sims.push(sim);
    msg = sim.message || '可以';
  }
  const verdict = await judgeCall(judgePrompt(s, transcript, readLogs(dist)), simDir);
  const rec = (verdict.recorded || []).filter((x) => x.present);
  const qs = verdict.questions || [];
  const result = {
    ver: VER, scenario: s.name,
    recorded: rec.length, withReason: rec.filter((x) => x.reason).length,
    revealed: [...new Set(sims.flatMap((x) => x.revealed || []))].length,
    questions: qs.length, concrete: qs.filter((q) => q.kind === 'concrete').length,
    badQuestions: qs.filter((q) => q.kind !== 'concrete').length,
    annoyanceMax: Math.max(0, ...sims.map((x) => Number(x.annoyance) || 0)),
    annoyanceSum: sims.reduce((a, x) => a + (Number(x.annoyance) || 0), 0),
    task: verdict.task, note: verdict.note,
  };
  fs.writeFileSync(path.join(root, 'transcript.md'), transcript);
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ result, verdict, sims }, null, 2));
  return result;
}

(async () => {
  const results = await Promise.all(scenarios.map(episode));
  const out = path.join(HERE, 'results.jsonl');
  for (const r of results) fs.appendFileSync(out, JSON.stringify({ tag: TAG, ...r }) + '\n');
  console.table(results.map(({ note, ...r }) => r));
  console.log(`紀錄在 ${path.join(os.tmpdir(), 'de', TAG, VER)}`);
})();
