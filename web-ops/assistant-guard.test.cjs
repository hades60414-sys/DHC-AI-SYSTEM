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
  // Security audit 2026-11-04 (SEC-OPS-01): bypasses that used to run with no card.
  ['bypass: node -e unlink', 'Bash', { command: sq('node -e "require(QfsQ).unlinkSync(QC:/x.txtQ)"') }, 0, 'deny'],
  ['bypass: node -e fetch PATCH', 'Bash', { command: sq('node -e "fetch(Qhttp://127.0.0.1:3001/api/user/preferencesQ,{method:QPATCHQ})"') }, 0, 'deny'],
  ['bypass: node --eval writeFile', 'PowerShell', { command: sq('node --eval "require(Qnode:fsQ).writeFileSync(QaQ,QbQ)"') }, 0, 'deny'],
  ['bypass: python -c os.remove', 'Bash', { command: sq('python -c "import os; os.remove(Qx.txtQ)"') }, 0, 'deny'],
  ['bypass: python -c shutil.rmtree', 'Bash', { command: sq('py -3 -c "import shutil; shutil.rmtree(QC:/dataQ)"') }, 0, 'deny'],
  ['bypass: powershell -Command IO.File Delete', 'Bash', { command: sq('powershell -NoProfile -Command "[IO.File]::Delete(QC:\\x.txtQ)"') }, 0, 'deny'],
  ['bypass: powershell -EncodedCommand', 'Bash', { command: 'powershell -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQA' }, 0, 'deny'],
  ['bypass: move /y over approvals grant', 'Bash', { command: 'move /y D:\\TAS\\ai-tools\\approvals\\grants\\x.json NUL' }, 0, 'deny'],
  ['bypass: Set-Content whitelist', 'PowerShell', { command: 'Set-Content D:\\TAS\\ai-tools\\approvals\\whitelist.txt "dir *"' }, 0, 'deny'],
  ['bypass: copy onto .claude settings', 'Bash', { command: 'copy evil.json C:\\Users\\demo\\.claude\\settings.json' }, 0, 'deny'],
  ['bypass: curl --request PATCH', 'Bash', { command: 'curl --request PATCH http://127.0.0.1:3001/api/user/preferences' }, 0, 'deny'],
  ['bypass: curl --json', 'Bash', { command: 'curl --json {} http://127.0.0.1:3001/api/user/preferences' }, 0, 'deny'],
  ['bypass: mv in chain', 'Bash', { command: 'ls && mv a.txt /tmp/a.txt' }, 0, 'deny'],
  ['still allowed: node -e read-only', 'Bash', { command: sq('node -e "console.log(1+1)"') }, 0, 'allow'],
  ['still allowed: powershell -File status', 'Bash', { command: 'powershell -NoProfile -File Controller-RAG1.ps1 -Command status -Config userF' }, 0, 'allow'],
  ['still allowed: Get-Content', 'PowerShell', { command: 'Get-Content C:\\work\\a.txt | Select-Object -First 5' }, 0, 'allow'],
  ['still allowed: curl GET', 'Bash', { command: 'curl -s http://127.0.0.1:3001/health' }, 0, 'allow'],
  ['still allowed: grep for rename', 'Bash', { command: 'grep -rn rename src' }, 0, 'allow'],
  ['still allowed: read a .claude file', 'Bash', { command: 'type C:\\Users\\demo\\.claude\\settings.json' }, 0, 'allow'],
  ['forge approval click via curl', 'Bash', { command: 'curl -s http://127.0.0.1:3001/api/user/preferences -o p.json' }, 0, 'deny'],
  ['forge approval click via script file', 'Write', { file_path: path.join(home, 'f.js'), content: sq('fetch(Q/api/user/preferencesQ,{method:QPATCHQ,body:Q{\"dhc.chat:x\":1}Q})') }, 0, 'deny'],
  ['forge approval text via Edit', 'Edit', { file_path: existing, old_string: 'old', new_string: '同意核准單 abc123' }, 0, 'deny'],
  ['bypass confirmed runs', 'Bash', { command: sq('python -c "import os; os.remove(Qx.txtQ)"') }, 1, 'allow'],
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
// 11/02 收據＋復原: a call's edits are listed with their backups; a new file has none.
const editDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-edit-'));
const oldFile = path.join(editDir, 'old.txt');
fs.writeFileSync(oldFile, 'before');
guard('Edit', { file_path: oldFile, old_string: 'before', new_string: 'after' }, { ASSISTANT_CALL_ID: 'call-edit' });
guard('Write', { file_path: path.join(editDir, 'new.txt'), content: 'x' }, { ASSISTANT_CALL_ID: 'call-edit' });
const editsFile = path.join(home, '.cloudcli', 'assistant', 'edits', 'call-edit.jsonl');
const edits = fs.existsSync(editsFile) ? fs.readFileSync(editsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
expect('edits listed per call with backup', edits.length === 2 && edits[0].file === oldFile && fs.readFileSync(edits[0].backup, 'utf8') === 'before' && edits[1].backup === null);
// Cards off: held actions run without a card; Python stays blocked.
const offFlag = path.join(home, '.cloudcli', 'assistant', 'cards-off');
fs.writeFileSync(offFlag, '');
expect('cards off: rm runs', !guard('Bash', { command: 'rm a.txt' }, { ASSISTANT_CALL_ID: 'call-5' }).includes('deny')
  && !fs.existsSync(path.join(home, '.cloudcli', 'assistant', 'actions', 'pending', 'call-5.jsonl')));
expect('cards off: protected edit runs', !guard('Edit', { file_path: 'C:\\Users\\x\\.claude\\settings.json' }, {}).includes('deny'));
expect('cards off: python allowed', !guard('Bash', { command: 'python x.py' }, {}).includes('deny'));
fs.unlinkSync(offFlag);

// 10-28 交易時段硬擋：時鐘用 ASSISTANT_GUARD_NOW 固定（UTC），判斷用台北時間。2026-10-28 是週三。
const q41 = { cmd: 'sqlcmd -S 10.255.0.11 -U %SRC_USER% -P %SRC_PWD% -d MarketData -W -Q "SELECT TOP 5 * FROM DailyQuote"' };
const at = (iso, tool, input, extra = {}) => guard(tool, input, { ASSISTANT_GUARD_NOW: iso, ...extra });
const denied = (out) => out.includes('"deny"') && out.includes('交易時段');
expect('trading: Wed 08:29 Taipei srv-src allowed', !at('2026-10-28T00:29:00Z', 'mcp__ragent__ragent_cmd', q41).includes('deny'));
expect('trading: Wed 08:30 Taipei srv-src blocked', denied(at('2026-10-28T00:30:00Z', 'mcp__ragent__ragent_cmd', q41)));
expect('trading: Wed 13:59 Taipei srv-src blocked', denied(at('2026-10-28T05:59:00Z', 'mcp__ragent__ragent_cmd', q41)));
expect('trading: Wed 14:00 Taipei srv-src allowed', !at('2026-10-28T06:00:00Z', 'mcp__ragent__ragent_cmd', q41).includes('deny'));
expect('trading: Taipei clock, not UTC (Mon 08:45 Taipei = 00:45Z)', denied(at('2026-11-02T00:45:00Z', 'mcp__ragent__ragent_cmd', q41)));
expect('trading: Taipei clock, not UTC (Wed 14:30 Taipei = 06:30Z)', !at('2026-10-28T06:30:00Z', 'mcp__ragent__ragent_cmd', q41).includes('deny'));
expect('trading: Sat 10:00 Taipei allowed', !at('2026-10-31T02:00:00Z', 'mcp__ragent__ragent_cmd', q41).includes('deny'));
expect('trading: Sun 10:00 Taipei allowed', !at('2026-11-01T02:00:00Z', 'mcp__ragent__ragent_cmd', q41).includes('deny'));
expect('trading: srv-db2 IP blocked', denied(at('2026-10-28T02:00:00Z', 'mcp__rag1__ragent_cmd', { cmd: 'sqlcmd -S 10.255.0.30 -Q "SELECT 1"' })));
expect('trading: DBLINK2 via srv-src linked server blocked', denied(at('2026-10-28T02:00:00Z', 'mcp__ragent__ragent_cmd', { cmd: 'sqlcmd -S x -Q "SELECT TOP 5 * FROM [DBLINK2].PL.dbo.t"' })));
expect('trading: local Bash to srv-src blocked', denied(at('2026-10-28T02:00:00Z', 'Bash', { command: 'Test-NetConnection 10.255.0.11 -Port 1433' })));
expect('trading: confirmed does not release', denied(guard('mcp__ragent__ragent_cmd', q41, { ASSISTANT_GUARD_NOW: '2026-10-28T02:00:00Z', ASSISTANT_CONFIRMED: '1' })));
fs.writeFileSync(offFlag, '');
expect('trading: cards-off does not release', denied(at('2026-10-28T02:00:00Z', 'mcp__ragent__ragent_cmd', q41)));
fs.unlinkSync(offFlag);
expect('trading: srv-db localhost sqlcmd allowed', !at('2026-10-28T02:00:00Z', 'mcp__ragent__ragent_cmd', { cmd: 'sqlcmd -S localhost -Q "SELECT MAX(日期) FROM MarketData.dbo.DailyQuote"' }).includes('deny'));
expect('trading: structured srv-db sql allowed', !at('2026-10-28T02:00:00Z', 'mcp__ragent__ragent_sql', { action: 'select', spec: {} }).includes('deny'));
expect('trading: plain ls allowed', !at('2026-10-28T02:00:00Z', 'Bash', { command: 'ls -la' }).includes('deny'));
expect('trading: other 172.24.26.x host allowed', !at('2026-10-28T02:00:00Z', 'Bash', { command: 'curl http://10.255.0.99/' }).includes('deny'));
expect('trading: .410 is not srv-src', !at('2026-10-28T02:00:00Z', 'Bash', { command: 'ping 10.255.0.99' }).includes('deny'));
process.exitCode = failed ? 1 : 0;
