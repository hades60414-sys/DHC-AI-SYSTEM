// Append-only log of every outbound data transfer by Claude (all sessions).
// Wired as PreToolUse (phase=attempt) and PostToolUse (phase=done) in ~/.claude/settings.json.
// Each record carries sha256 of the full tool_input (summary is truncated) and, for file attachments/uploads, per-file sha256.
// Never blocks: any error is swallowed and the hook exits 0.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SHELL_NET = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Send-MailMessage|Outlook\.Application|System\.Net\.(Mail|WebClient|Http)|Net\.WebClient|HttpClient|scp|sftp|ssh|ftp|rsync|git\s+push|gh\s+(pr|issue|api|release|gist)|npm\s+publish|Start-BitsTransfer|smtp|nc|ncat|plink|pscp)\b/i;
const cut = (s, n) => (s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

function target(tool, i) {
  return i.url || i.chat_id || i.channel || i.to || i.query || i.projectId || i.trigger_id ||
    (i.container && i.container.id) || i.sessionId || i.selector || '';
}
function summary(tool, i) {
  if (tool === 'Bash' || tool === 'PowerShell') return cut(i.command, 1500);
  const parts = [];
  for (const k of ['text', 'message', 'prompt', 'body', 'payload', 'files', 'paths', 'writes', 'fields', 'method', 'action', 'emoji', 'message_id']) {
    if (i[k] !== undefined) parts.push(k + '=' + cut(typeof i[k] === 'string' ? i[k] : JSON.stringify(i[k]), 800));
  }
  return parts.join(' | ');
}

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const MAX_HASH_BYTES = 200 * 1024 * 1024;
function filePaths(i) {
  const out = [];
  for (const k of ['files', 'paths']) {
    if (!Array.isArray(i[k])) continue;
    for (const f of i[k]) {
      if (typeof f === 'string') out.push(f);
      else if (f && typeof f.localPath === 'string') out.push(f.localPath);
    }
  }
  return out;
}
function hashFiles(i, cwd) {
  return filePaths(i).map(p => {
    try {
      const abs = path.resolve(cwd || '.', p);
      const st = fs.statSync(abs);
      if (!st.isFile()) return { path: p, sha256: 'not-a-file' };
      if (st.size > MAX_HASH_BYTES) return { path: p, bytes: st.size, sha256: 'skipped-too-large' };
      return { path: p, bytes: st.size, sha256: sha(fs.readFileSync(abs)) };
    } catch (_) { return { path: p, sha256: 'unreadable' }; }
  });
}

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw || '{}');
    const tool = ev.tool_name || '';
    const input = ev.tool_input || {};
    if ((tool === 'Bash' || tool === 'PowerShell') && !SHELL_NET.test(input.command || '')) return;
    const now = new Date();
    const rec = {
      ts: now.toISOString(),
      phase: ev.hook_event_name === 'PostToolUse' ? 'done' : 'attempt',
      session: ev.session_id || '',
      cwd: ev.cwd || '',
      tool,
      target: cut(target(tool, input), 300),
      summary: summary(tool, input),
      sha256: sha(JSON.stringify(input)),
    };
    const fh = hashFiles(input, ev.cwd);
    if (fh.length) rec.files = fh;
    const dir = path.join(os.homedir(), '.claude', 'egress-log');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `egress-${now.toISOString().slice(0, 7)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch (_) { /* never block the tool call */ }
});
