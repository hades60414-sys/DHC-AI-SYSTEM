// 中台小助理 PreToolUse hook (passed by the assistant service with --settings; not used by normal sessions).
// Every tool call is logged; an existing file is copied before Write/Edit touches it; deleting, killing,
// pushing, scheduling, outward sends and edits to the harness itself are denied unless the person who called
// the assistant wrote 確認執行 in that message (the service sets ASSISTANT_CONFIRMED=1).
// 10/20 action cards: with ASSISTANT_CALL_ID set, a held action is also written to actions/pending/<call>.jsonl so
// the service can post it as a card; with ASSISTANT_APPROVED=<key> (a pressed card) only that one action may run.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = process.env.ASSISTANT_ROOT || path.join(os.homedir(), '.cloudcli', 'assistant');
const confirmed = process.env.ASSISTANT_CONFIRMED === '1';
const callId = /^[\w-]{1,80}$/.test(process.env.ASSISTANT_CALL_ID || '') ? process.env.ASSISTANT_CALL_ID : '';
const approvedKey = process.env.ASSISTANT_APPROVED || '';
const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const RISKY_COMMAND = [
  /(^|[\s;&|(])(rm|rmdir|rd|del|erase|unlink|shred)(\s|$)/i,
  /\b(Remove-Item|Clear-Content|Clear-RecycleBin|Stop-Process|Stop-Service|Restart-Service|Restart-Computer|Stop-Computer)\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\b(taskkill|shutdown|diskpart|vssadmin|cipher\s+\/w|robocopy\b.*\/(mir|purge)|sc(\.exe)?\s+(stop|delete|config)|net\s+(user|localgroup|stop))\b/i,
  /\bschtasks(\.exe)?\s+\/(create|delete|change|end)\b/i,
  /\bgit\s+(push|reset\s+--hard|clean|checkout\s+--|restore|rebase|branch\s+-D|stash\s+(drop|clear))\b/i,
  /\b(curl|wget)\b[^\n]*\s(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s|-F\s|--upload-file)/i,
  /\bInvoke-(WebRequest|RestMethod)\b[^\n]*-Method\s+(Post|Put|Patch|Delete)/i,
  /\b(Send-MailMessage|sendmail)\b/i,
  /\b(DROP|TRUNCATE|ALTER)\s+(TABLE|DATABASE|VIEW|PROC|PROCEDURE|INDEX|SCHEMA)\b/i,
  /\b(DELETE\s+FROM|UPDATE\s+\S+\s+SET|INSERT\s+INTO|MERGE\s+INTO|EXEC(UTE)?\s+\S)/i,
  /\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/i,
  /Controller-RAG1\.ps1\b[^\n]*-Command\s+(pair|init)\b/i,
  /\bwrangler\s+(deploy|publish|delete|secret)\b/i,
  /(^|[^>2&])>\s*(?!(nul|\/dev\/null|&))[^\s>&|]/i,
];
const PROTECTED_PATH = [
  /[\\/]\.claude([\\/]|$)/i,
  /[\\/]cc-host([\\/]|$)/i,
  /[\\/]cc-hosts([\\/]|$)/i,
  /[\\/]cc-web([\\/]|$)/i,
  /[\\/]\.cloudcli[\\/](?!assistant[\\/]work[\\/])/i,
  /[\\/]ai-tools([\\/]|$)/i,
  /\.credentials|\.env($|\.)|id_rsa|\.pem$|\.key$/i,
  /^[a-z]:[\\/](windows|program files|programdata)([\\/]|$)/i,
];
// 10/21 MO OK'd plan B: pairing a colleague's lite PC runs without a card, but only as this exact command,
// for one of these devices, with a 64-hex fingerprint and an enrollment file for that device that arrived in the
// last 10 minutes. Anything else (other devices, chaining, redirects) still needs a card.
const SELF_PAIR_DEVICES = new Set(['userB', 'userC', 'userD', 'pcmgr', 'userF']);
const SELF_PAIR = /^(?:cd \/d "D:\\TAS\\Claude Code專案\\Harness優化\\gemma-offline\\agent-channel\\rag1" && )?powershell -NoProfile -ExecutionPolicy Bypass -File Controller-RAG1\.ps1 -Command pair -Config ([a-z0-9]+) -ReleaseDir release-rag1d-\1 -File "C:\\Users\\demo\\\.cloudcli\\assets\\(\d+-\d+-\1-agent-enrollment\.cms\.b64\.txt)" -Fingerprint [0-9A-Fa-f]{64}$/;
function selfPairOk(command) {
  const m = SELF_PAIR.exec(command.trim());
  if (!m || !SELF_PAIR_DEVICES.has(m[1])) return false;
  try {
    const age = Date.now() - fs.statSync(path.join(os.homedir(), '.cloudcli', 'assets', m[2])).mtimeMs;
    return age >= 0 && age <= 10 * 60e3;
  } catch { return false; }
}
const MAIL_READ = /olRag|Outlook\.Application|\.pst\b/i;
const MAILBOX = { rag1: 'srv-rag', userF: '同事F', pcmgr: '同事G', userD: '同事D', userC: '同事C', userB: 'userB', userE: '同事E', pcmain: 'srv-main' };
function mailAudit(tool, command) {
  const device = /__ragent_cmd$/.test(tool) ? tool.split('__')[1] : (/AGX=(\w+)/.exec(command)?.[1] ?? 'rag1');
  const what = (command.match(/[\w-]+\.ps1/g) ?? []).join(',') || command.slice(0, 200);
  const line = [new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '), process.env.ASSISTANT_ASKER || '（未知）', MAILBOX[device] ?? device, what.replace(/\s+/g, ' ')].join('\t');
  try { fs.appendFileSync(path.join(ROOT, 'mail-audit.log'), line + '\n'); } catch {}
}
const DENY_TOOLS =/^mcp__.*__(ragent_self_update|ragent_doc_index|ragent_sandbox)$/;

function log(line) {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.appendFileSync(path.join(ROOT, 'audit.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

// Fields that do not change what an action does; left out so a re-run of the same action gets the same key.
const NOISE = new Set(['description', 'timeout', 'timeout_sec', 'wait_seconds', 'run_in_background']);
const stable = (value) => (Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  : value);
function actionKey(tool, args) {
  const kept = Object.fromEntries(Object.entries(args || {}).filter(([key]) => !NOISE.has(key)));
  return crypto.createHash('sha256').update(JSON.stringify([tool, stable(kept)])).digest('hex');
}

function answer(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
  process.exit(0);
}

let current = { tool: '', args: {} };

function deny(reason, hard = false) {
  if (hard) { log(`DENY ${reason}`); answer('deny', `${reason}。`); }
  // 10/21 MO turned cards off: while ROOT/cards-off exists, held actions run (still logged); delete the file to turn cards back on.
  if (fs.existsSync(path.join(ROOT, 'cards-off'))) { log(`CARDS-OFF ALLOW ${reason}`); process.exit(0); }
  log(`DENY ${reason}`);
  if (approvedKey) answer('deny', `${reason}。這一輪只能執行卡片上那一個動作，其他刪改或對外動作都不做。`);
  if (callId) {
    try {
      const dir = path.join(ROOT, 'actions', 'pending');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${callId}.jsonl`), JSON.stringify({ tool: current.tool, input: current.args, reason, key: actionKey(current.tool, current.args) }) + '\n');
      answer('deny', `${reason}。這屬於刪改或不可逆／對外的動作，已做成確認卡貼給對方：回覆裡講清楚卡片要做什麼、影響哪些檔案或資料；對方按卡片上的「執行」才會做。不要叫對方打字確認，也不要換別的寫法繞過。`);
    } catch (error) {
      log(`CARD-FAIL ${error.message}`);
    }
  }
  answer('deny', `${reason}。這屬於刪改或不可逆／對外的動作：先在回覆裡講清楚要做什麼、影響哪些檔案或資料，請對方在聊天室回「確認執行」後再做。`);
}

function backup(file) {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return;
    const target = path.join(ROOT, 'backups', stamp, path.resolve(file).replace(/^([a-z]):/i, '$1'));
    if (fs.existsSync(target)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    log(`BACKUP ${file} -> ${target}`);
  } catch (error) {
    deny(`改檔前備份 ${file} 失敗（${error.message}）`);
  }
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let event;
  try { event = JSON.parse(input); } catch { process.exit(0); }
  const tool = String(event.tool_name || '');
  const args = event.tool_input || {};
  current = { tool, args };
  // The one action on a pressed card runs as is; Python stays blocked below even then.
  const pressed = approvedKey !== '' && actionKey(tool, args) === approvedKey;
  const released = confirmed || pressed;
  if (pressed) {
    // The service reads this mark to tell "ran the card" from "said it did".
    try {
      fs.mkdirSync(path.join(ROOT, 'actions', 'ran'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'actions', 'ran', approvedKey), new Date().toISOString());
    } catch {}
  }
  log(`${confirmed ? 'CONFIRMED ' : released ? 'APPROVED ' : ''}${tool} ${JSON.stringify(args).slice(0, 600)}`);

  if (DENY_TOOLS.test(tool) && !released) deny(`${tool} 會改遠端主機的設定或資料`);

  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
    const file = String(args.file_path || args.notebook_path || '');
    if (PROTECTED_PATH.some((re) => re.test(file)) && !released) deny(`${file} 是系統或設定檔`);
    backup(file);
    process.exit(0);
  }

  const command = String(args.command || args.cmd || '');
  // 10-27 起 srv-main 可跑 Python，不再擋
  if (command && (tool === 'Bash' || tool === 'PowerShell' || /__ragent_cmd$/.test(tool)) && MAIL_READ.test(command)) mailAudit(tool, command);
  if (command && (tool === 'Bash' || tool === 'PowerShell' || /__ragent_cmd$/.test(tool))) {
    const hit = RISKY_COMMAND.find((re) => re.test(command));
    if (hit && !released && (tool === 'Bash' || tool === 'PowerShell') && selfPairOk(command)) {
      log(`SELF-PAIR ${command.slice(0, 300)}`);
      process.exit(0);
    }
    if (hit && !released) deny(`指令「${command.slice(0, 120)}」`);
  }
  process.exit(0);
});
