// 其他 hook 的回歸測試（20261105）：node harness/hooks/test/hooks-misc.test.cjs
// 只用 stdin 餵 payload、暫存 HOME 與暫存資料夾，不碰真的 ~/.claude。
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const HOOKS = path.join(__dirname, '..');
const TOOLS = path.join(HOOKS, '..', '..', 'tools');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'das-hooks-test-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });

const env = (extra = {}) => ({ ...process.env, HOME, USERPROFILE: HOME, ...extra });
const run = (hook, payload, extra) => spawnSync(process.execPath, [path.join(HOOKS, hook)], { input: JSON.stringify(payload), env: env(extra), encoding: 'utf8' });

let fail = 0;
const t = (name, ok, detail = '') => { if (!ok) fail++; console.log((ok ? 'OK  ' : 'BAD ') + name + (ok ? '' : '  ' + detail)); };

// zh-reply-guard：Linux 路徑不算英文；英文回覆照樣擋；紀錄檔不存在也要判斷
{
  const tr = path.join(TMP, 'transcript.jsonl'); fs.writeFileSync(tr, '');
  const zh = '已完成，修改了 /home/dev/das/harness/hooks/secret-guard.js 與 ./tools/prompt-injection/guard.cjs 和 ~/.claude/settings.json';
  let r = run('zh-reply-guard.js', { hook_event_name: 'Stop', transcript_path: tr, last_assistant_message: zh });
  t('zh-reply-guard：中文＋Linux 路徑不擋', !r.stdout.includes('block'), r.stdout);
  const en = 'Done. I updated the guard hooks and verified every test passes on this machine without issues.';
  r = run('zh-reply-guard.js', { hook_event_name: 'Stop', transcript_path: tr, last_assistant_message: en });
  t('zh-reply-guard：英文回覆照擋', r.stdout.includes('"block"'), r.stdout);
  r = run('zh-reply-guard.js', { hook_event_name: 'Stop', transcript_path: path.join(TMP, 'missing.jsonl'), last_assistant_message: en });
  t('zh-reply-guard：紀錄檔不存在也擋英文', r.stdout.includes('"block"'), r.stdout);
}

// drain-guard：drain.json 沒有 since（或格式錯）當過期，不能永久擋住
{
  const root = path.join(TMP, 'drain'); fs.mkdirSync(root, { recursive: true });
  const p = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } };
  fs.writeFileSync(path.join(root, 'drain.json'), JSON.stringify({ reason: 'test' }));
  t('drain-guard：缺 since 不擋', !run('drain-guard.js', p, { DRAIN_ROOT: root }).stdout.includes('deny'));
  fs.writeFileSync(path.join(root, 'drain.json'), JSON.stringify({ reason: 'test', since: 'not-a-date' }));
  t('drain-guard：since 格式錯不擋', !run('drain-guard.js', p, { DRAIN_ROOT: root }).stdout.includes('deny'));
  fs.writeFileSync(path.join(root, 'drain.json'), JSON.stringify({ reason: 'test', since: new Date().toISOString() }));
  t('drain-guard：有效旗標照擋', run('drain-guard.js', p, { DRAIN_ROOT: root }).stdout.includes('deny'));
}

// keepgoing-detect：checkpoint 路徑要用系統的路徑分隔
{
  const ws = path.join(TMP, 'ws'); fs.mkdirSync(ws);
  const kdir = path.join(TMP, 'kg');
  fs.writeFileSync(path.join(HOME, '.claude', 'das-hooks.json'), JSON.stringify({ toolsRoot: TOOLS, workspaces: [ws], keepgoingEnabled: true }));
  const sid = '0123abcd-0123-0123-0123-0123456789ab';
  const r = run('keepgoing-detect.js', { session_id: sid, cwd: ws, prompt: '再試兩小時' }, { KEEPGOING_DIR: kdir });
  const want = path.join(kdir, sid + '.md');
  t('keepgoing-detect：checkpoint 路徑正確', r.stdout.includes(JSON.stringify(want).slice(1, -1)), r.stdout.slice(0, 300));
  fs.rmSync(path.join(HOME, '.claude', 'das-hooks.json'));
}

// turn-budget：平行 PostToolUse 不能掉計數
async function parallelBudget() {
  const sid = 'par' + process.pid;
  const e = env({ TURN_BUDGET_CALLS: '20' });
  const file = path.join(os.tmpdir(), `turn-budget-${sid}.json`);
  spawnSync(process.execPath, [path.join(HOOKS, 'turn-budget.js')], { input: JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit' }), env: e });
  const outs = await Promise.all(Array.from({ length: 20 }, () => new Promise((res) => {
    const c = spawn(process.execPath, [path.join(HOOKS, 'turn-budget.js')], { env: e });
    let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => res(o));
    c.stdin.end(JSON.stringify({ session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} }));
  })));
  const calls = JSON.parse(fs.readFileSync(file, 'utf8')).main.calls;
  t('turn-budget：20 個平行呼叫記到 20 次', calls === 20, 'calls=' + calls);
  t('turn-budget：第 20 次提醒剛好一次', outs.filter((o) => o.includes('回合預算')).length === 1);
  fs.rmSync(file, { force: true });
}

parallelBudget().then(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `FAILED ${fail}` : 'ALL PASS');
  process.exit(fail ? 1 : 0);
});
