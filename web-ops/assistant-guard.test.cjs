// node assistant-guard.test.cjs — runs the guard against a table of tool calls in a scratch HOME.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
const existing = path.join(home, 'existing.txt');
fs.writeFileSync(existing, 'old');
const sq = (s) => s.replace(/Q/g, String.fromCharCode(39));

const assets = path.join(home, '.cloudcli', 'assets');
fs.mkdirSync(assets, { recursive: true });
const fresh = '100-200-userF-agent-enrollment.cms.b64.txt';
const stale = '100-201-userF-agent-enrollment.cms.b64.txt';
const freshJ = '100-202-rag1-agent-enrollment.cms.b64.txt';
for (const f of [fresh, stale, freshJ]) fs.writeFileSync(path.join(assets, f), 'x');
const old = new Date(Date.now() - 11 * 60e3);
fs.utimesSync(path.join(assets, stale), old, old);
const BS = String.fromCharCode(92);
const pairCmd = (dev, file) => 'powershell -NoProfile -ExecutionPolicy Bypass -File Controller-RAG1.ps1 -Command pair -Config ' + dev + ' -ReleaseDir release-rag1d-' + dev + ' -File "' + ['C:', 'Users', 'demo', '.cloudcli', 'assets', file].join(BS) + '" -Fingerprint ' + 'A'.repeat(64);

const cases = [
  ['ls with stderr to null', 'Bash', { command: 'ls -la 2>/dev/null | head' }, 0, 'allow'],
  ['dir to nul', 'Bash', { command: 'dir C:\\x >nul' }, 0, 'allow'],
  ['grep word format', 'Bash', { command: 'grep -rn format src | wc -l' }, 0, 'allow'],
  ['single rm', 'Bash', { command: 'rm a.txt' }, 0, 'deny'],
  ['single rm confirmed', 'Bash', { command: 'rm a.txt' }, 1, 'allow'],
  ['redirect overwrite', 'Bash', { command: 'echo hi > out.txt' }, 0, 'deny'],
  ['git push', 'Bash', { command: 'git push origin main' }, 0, 'deny'],
  ['remote select', 'mcp__ragent__ragent_cmd', { cmd: sq('sqlcmd -Q "SELECT TOP 5 * FROM t"') }, 0, 'allow'],
  ['remote delete rows', 'mcp__ragent__ragent_cmd', { cmd: 'sqlcmd -Q "DEL' + 'ETE FROM t WHERE a=1"' }, 0, 'deny'],
  ['edit harness settings', 'Edit', { file_path: 'C:\\Users\\demo\\.claude\\settings.json' }, 0, 'deny'],
  ['write new work file', 'Write', { file_path: path.join(home, 'new.md') }, 0, 'allow'],
  ['edit existing file is backed up', 'Edit', { file_path: existing }, 0, 'allow'],
  ['remote self update', 'mcp__rag1__ragent_self_update', {}, 0, 'deny'],
  ['structured sql query', 'mcp__ragent__ragent_sql', { action: 'select' }, 0, 'allow'],
  ['pair new device', 'Bash', { command: 'powershell -File Controller-RAG1.ps1 -Command pair -Config userF -File x -Fingerprint ab' }, 0, 'deny'],
  ['channel status', 'Bash', { command: 'powershell -File Controller-RAG1.ps1 -Command status -Config userF' }, 0, 'allow'],
  ['taskkill', 'PowerShell', { command: 'taskkill /PID 1 /F' }, 0, 'deny'],
  ['local python', 'Bash', { command: 'python -c "print(1)"' }, 0, 'allow'],
  ['local python confirmed', 'Bash', { command: 'cd x && py script.py' }, 1, 'allow'],
  ['pip install', 'PowerShell', { command: 'pip install pandas' }, 1, 'allow'],
  ['word python in a path is fine', 'Bash', { command: 'ls C:/docs/python-notes' }, 0, 'allow'],
  ['python on a remote host is allowed', 'mcp__ragent__ragent_cmd', { cmd: 'python C:\\job\\x.py' }, 0, 'allow'],
  ['self pair fresh lite device', 'Bash', { command: pairCmd('userF', fresh) }, 0, 'allow'],
  ['self pair with cd prefix', 'Bash', { command: 'cd /d "' + ['D:', 'TAS', 'Claude Code專案', 'Harness優化', 'gemma-offline', 'agent-channel', 'rag1'].join(BS) + '" && ' + pairCmd('userF', fresh) }, 0, 'allow'],
  ['self pair stale enrollment', 'Bash', { command: pairCmd('userF', stale) }, 0, 'deny'],
  ['self pair missing enrollment', 'Bash', { command: pairCmd('userF', '1-2-userF-agent-enrollment.cms.b64.txt') }, 0, 'deny'],
  ['self pair other device file', 'Bash', { command: pairCmd('userD', fresh) }, 0, 'deny'],
  ['self pair not a lite device', 'Bash', { command: pairCmd('rag1', freshJ) }, 0, 'deny'],
  ['self pair chained', 'Bash', { command: pairCmd('userF', fresh) + ' & del x' }, 0, 'deny'],
  ['self pair short fingerprint', 'Bash', { command: pairCmd('userF', fresh).slice(0, -1) }, 0, 'deny'],
  ['self pair via remote cmd', 'mcp__ragent__ragent_cmd', { cmd: pairCmd('userF', fresh) }, 0, 'deny'],
  ['robocopy mirror confirmed', 'Bash', { command: 'robocopy a b /MIR' }, 1, 'allow'],
];

let failed = 0;
for (const [name, tool, input, confirmed, want] of cases) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'assistant-guard.cjs')], {
    input: JSON.stringify({ tool_name: tool, tool_input: input }),
    env: { ...process.env, USERPROFILE: home, HOME: home, ASSISTANT_CONFIRMED: String(confirmed) },
    encoding: 'utf8',
  });
  const got = out.includes('"deny"') ? 'deny' : 'allow';
  if (got !== want) failed += 1;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} ${name}: ${got}`);
}
// Action cards: a held action is written down for the service; a pressed card releases only that action.
const guard = (tool, input, extra) => execFileSync(process.execPath, [path.join(__dirname, 'assistant-guard.cjs')], {
  input: JSON.stringify({ tool_name: tool, tool_input: input }),
  env: { ...process.env, USERPROFILE: home, HOME: home, ASSISTANT_CONFIRMED: '0', ...extra },
  encoding: 'utf8',
});
const expect = (name, ok) => { if (!ok) failed += 1; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const held = guard('Bash', { command: 'rm a.txt', description: 'remove it' }, { ASSISTANT_CALL_ID: 'call-1' });
const pendingFile = path.join(home, '.cloudcli', 'assistant', 'actions', 'pending', 'call-1.jsonl');
const card = fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, 'utf8').trim()) : null;
expect('held action becomes a card', held.includes('"deny"') && held.includes('確認卡') && card?.tool === 'Bash' && card.input.command === 'rm a.txt' && /^[0-9a-f]{64}$/.test(card.key));
expect('plain read is not carded', !guard('Bash', { command: 'ls' }, { ASSISTANT_CALL_ID: 'call-2' }).includes('deny')
  && !fs.existsSync(path.join(home, '.cloudcli', 'assistant', 'actions', 'pending', 'call-2.jsonl')));
const key = card?.key ?? 'x';
expect('pressed card runs that action (description may differ)', !guard('Bash', { command: 'rm a.txt', description: 'other words' }, { ASSISTANT_APPROVED: key }).includes('deny'));
expect('pressed card does not release a different action', guard('Bash', { command: 'rm b.txt' }, { ASSISTANT_APPROVED: key }).includes('只能執行卡片上那一個動作'));
expect('pressed card makes no new cards', !fs.existsSync(path.join(home, '.cloudcli', 'assistant', 'actions', 'pending', 'undefined.jsonl')));
const pyCard = JSON.parse(JSON.stringify({ tool: 'Bash', input: { command: 'python x.py' } }));
guard(pyCard.tool, pyCard.input, { ASSISTANT_CALL_ID: 'call-3' });
expect('python is never carded', !fs.existsSync(path.join(home, '.cloudcli', 'assistant', 'actions', 'pending', 'call-3.jsonl')));
const protectedCard = guard('Edit', { file_path: 'C:\\Users\\x\\.claude\\settings.json', old_string: 'a', new_string: 'b' }, { ASSISTANT_CALL_ID: 'call-4' });
expect('protected file edit becomes a card', protectedCard.includes('確認卡') && fs.existsSync(path.join(home, '.cloudcli', 'assistant', 'actions', 'pending', 'call-4.jsonl')));

const backups = path.join(home, '.cloudcli', 'assistant', 'backups');
const backedUp = fs.existsSync(backups) && JSON.stringify(fs.readdirSync(backups, { recursive: true })).includes('existing.txt');
console.log(`${backedUp ? 'ok  ' : 'FAIL'} existing file copied before edit`);
if (!backedUp) failed += 1;
// Cards off: held actions run without a card; Python stays blocked.
const offFlag = path.join(home, '.cloudcli', 'assistant', 'cards-off');
fs.writeFileSync(offFlag, '');
expect('cards off: rm runs', !guard('Bash', { command: 'rm a.txt' }, { ASSISTANT_CALL_ID: 'call-5' }).includes('deny')
  && !fs.existsSync(path.join(home, '.cloudcli', 'assistant', 'actions', 'pending', 'call-5.jsonl')));
expect('cards off: protected edit runs', !guard('Edit', { file_path: 'C:\\Users\\x\\.claude\\settings.json' }, {}).includes('deny'));
expect('cards off: python allowed', !guard('Bash', { command: 'python x.py' }, {}).includes('deny'));
fs.unlinkSync(offFlag);
process.exitCode = failed ? 1 : 0;
