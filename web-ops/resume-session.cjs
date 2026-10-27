// Resume a CloudCLI session that stopped on "You've hit your session limit": sends one continue message through the
// local CloudCLI server so the turn shows live in the web UI, then waits for it to finish.
// usage: node resume-session.cjs <sessionId> <model: opus|fable|sonnet|haiku> <permissionMode> [message]
'use strict';
const WebSocket = require('D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/ws');

const [sessionId, model, permissionMode, msg] = process.argv.slice(2);
const content = msg || '額度已恢復。請接著完成剛才因為用量上限被中斷的工作（就是我上一則訊息要的事），不用重頭解釋。';
const say = (...a) => console.log(new Date().toISOString(), ...a);

const ws = new WebSocket('ws://127.0.0.1:3001/ws');
ws.on('open', () => {
  const skip = permissionMode === 'bypassPermissions';
  ws.send(JSON.stringify({
    type: 'chat.send', sessionId, content,
    options: { model, permissionMode, toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: skip }, skipPermissions: skip, attachments: [] },
  }));
  say('sent', sessionId, model, permissionMode);
});
let chars = 0;
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.sessionId !== sessionId) return;
  if (m.kind === 'text' && m.role === 'assistant' && !m.parentToolUseId) chars += String(m.content).length;
  if (['complete', 'error', 'protocol_error'].includes(m.kind)) {
    say('end', m.kind, `reply chars ${chars}`, m.kind === 'complete' ? '' : JSON.stringify(m).slice(0, 300));
    ws.close(); process.exit(m.kind === 'complete' ? 0 : 1);
  }
});
ws.on('error', (e) => { say('ws error', e.message); process.exit(1); });
setTimeout(() => { say('still running after 30 min, detaching (turn keeps going on the server)'); process.exit(0); }, 30 * 60000);
