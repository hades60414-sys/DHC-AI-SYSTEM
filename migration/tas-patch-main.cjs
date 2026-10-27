// One-off srv-main edits after tas-rewrite.cjs. Idempotent: each edit checks whether it is already there.
const fs = require('fs');
const edits = [];

// CloudCLI chats on srv-main use the one-year token (the 30-day .credentials.json is not copied).
{
  const f = 'D:\\TAS\\cc-web\\start-cc-web.cmd';
  let s = fs.readFileSync(f, 'latin1');
  const line = 'if exist "C:\\Users\\demo\\.tas\\claude-token.txt" set /p CLAUDE_CODE_OAUTH_TOKEN=<"C:\\Users\\demo\\.tas\\claude-token.txt"';
  if (!s.includes('CLAUDE_CODE_OAUTH_TOKEN')) {
    const anchor = s.match(/set "CLAUDE_CLI_PATH=[^\r\n]*\r?\n/);
    if (!anchor) throw new Error('start-cc-web.cmd: CLAUDE_CLI_PATH line not found');
    s = s.replace(anchor[0], anchor[0] + 'REM TAS 2026-10-20: one-year Claude token (claude setup-token), read at start\r\n' + line + '\r\n');
    fs.writeFileSync(f, s, 'latin1');
    edits.push('start-cc-web.cmd: token line added');
  } else edits.push('start-cc-web.cmd: token line already there');
}
// srv-main has no system-wide Node: cloudcli.cmd calls plain "node", so the portable one goes on PATH.
{
  const f = 'D:\\TAS\\cc-web\\start-cc-web.cmd';
  let s = fs.readFileSync(f, 'latin1');
  const from = 'set "PATH=%CC_BIN%;%PATH%"';
  if (s.includes(from)) {
    fs.writeFileSync(f, s.replace(from, 'set "PATH=%CC_BIN%;D:\\TAS\\node;%PATH%"'), 'latin1');
    edits.push('start-cc-web.cmd: D:\\TAS\\node added to PATH');
  } else edits.push('start-cc-web.cmd: PATH already patched');
}
// Health and morning checks look at the fixed TAS mailbox instead of tasui (tasui is now only the moved page).
const MAILBOX = 'https://<worker>.<account>.workers.dev';
for (const f of ['D:\\TAS\\cc-hosts\\health-check.ps1', 'D:\\TAS\\cc-hosts\\morning-check.ps1']) {
  const s = fs.readFileSync(f, 'latin1');
  if (s.includes('https://tas-ui.example.workers.dev')) {
    fs.writeFileSync(f, s.split('https://tas-ui.example.workers.dev').join(MAILBOX), 'latin1');
    edits.push(f + ': tasui -> TAS mailbox');
  } else edits.push(f + ': already on mailbox');
}

// Scheduled tasks have no portable Node on PATH; health-check.cmd calls plain "node".
{
  const f = 'D:\\TAS\\cc-hosts\\health-check.cmd';
  const s = fs.readFileSync(f, 'latin1');
  if (/^node "/m.test(s)) { fs.writeFileSync(f, s.replace(/^node "/m, '"D:\\TAS\\node\\node.exe" "'), 'latin1'); edits.push('health-check.cmd: node path'); }
  else edits.push('health-check.cmd: node path already set');
}

// The morning check pings Claude with claude.exe; on srv-main that needs the one-year token.
{
  const f = 'D:\\TAS\\cc-hosts\\morning-check.ps1';
  let s = fs.readFileSync(f, 'latin1');
  if (!s.includes('CLAUDE_CODE_OAUTH_TOKEN')) {
    const anchor = s.match(/\$claude = '[^'\r\n]*'\r?\n/);
    if (!anchor) throw new Error('morning-check.ps1: $claude line not found');
    s = s.replace(anchor[0], anchor[0] + "$tokFile = 'C:\\Users\\demo\\.tas\\claude-token.txt'; if (Test-Path $tokFile) { $env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content $tokFile -TotalCount 1).Trim() }\r\n");
    fs.writeFileSync(f, s, 'latin1');
    edits.push('morning-check.ps1: token line added');
  } else edits.push('morning-check.ps1: token line already there');
}

// Files delivered by tas-go.cmd in D:\TAS\_go: agent controller exes/state, handoff notes, rotation wrapper.
if (fs.existsSync('D:\\TAS\\_go')) {
  const path = require('path');
  fs.cpSync('D:\\TAS\\_go\\Harness優化', 'D:\\TAS\\Claude Code專案\\Harness優化', { recursive: true, force: true });
  fs.cpSync('D:\\TAS\\_go\\cc-hosts', 'D:\\TAS\\cc-hosts', { recursive: true, force: true });
  fs.cpSync('D:\\TAS\\_go\\tas-worker', 'D:\\TAS\\tas-worker', { recursive: true, force: true });
  const mem = 'C:\\Users\\demo\\.claude\\projects\\D--TAS-Claude-Code---Harness--\\memory';
  for (const f of fs.readdirSync('D:\\TAS\\_go\\memory')) fs.copyFileSync(path.join('D:\\TAS\\_go\\memory', f), path.join(mem, f));
  edits.push('_go delivered: controller exes/state, PLAN.md, tas-rotate.cmd, tas-worker, memory');
}
console.log(edits.join('\n'));
