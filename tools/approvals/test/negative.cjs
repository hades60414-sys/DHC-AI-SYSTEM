// 反向測試：指令被改、過期，都要拒絕（直接改核准單檔，不碰聊天室）
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const L = require('../lib.cjs');
const mk = (id, patch) => { const cmd = 'echo neg'; L.save({ id, machine: 'rag1', cmd, sha256: L.sha('rag1', cmd), why: 't', rollback: 't', timeout: 30, room: 'dm:dhc-assistant~dhc-verify', button: '同意核准單 ' + id, created: new Date().toISOString(), expires: new Date(Date.now() + 3600e3).toISOString(), status: 'pending', ...patch }); };
const run = (id) => { try { execFileSync(process.execPath, [path.join(__dirname, '..', 'run.cjs'), id], { stdio: 'pipe' }); return 'RAN'; } catch (e) { return String(e.stderr).trim(); } };
mk('ffff01', { cmd: 'echo tampered' }); const a = run('ffff01');
mk('ffff02', { expires: new Date(Date.now() - 1000).toISOString() }); const b = run('ffff02');
console.log('改過指令 →', a); console.log('過期 →', b);
for (const id of ['ffff01', 'ffff02']) fs.unlinkSync(L.ticketPath(id));
console.log(/不一樣/.test(a) && /過期/.test(b) ? 'RESULT OK' : 'RESULT FAIL');
