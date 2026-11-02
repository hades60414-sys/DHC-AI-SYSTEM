// 端對端：在看不到的測試房開單 → 沒按就跑要被拒 → 模擬按鈕 → 小助手跑 run.cjs → 核對 → 重跑要被拒。
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const L = require('../lib.cjs');
const NODE = process.execPath, ROOM = 'dm:dhc-assistant~dhc-verify', BASE = 'http://127.0.0.1:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args) => { try { return { ok: true, out: execFileSync(NODE, args, { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; } };
const api = async (m, u, b) => (await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
(async () => {
  const a = run(['ask.cjs', '--machine', 'rag1', '--cmd-file', 'test/cmd-ok.txt', '--why', '端對端測試', '--rollback', '無（只印字）', '--room', ROOM]);
  const id = (a.out.match(/核准單 ([0-9a-f]{6})/) || [])[1]; console.log('開單', a.ok, id);
  const early = run(['run.cjs', id]); console.log('沒按就跑 → 應拒', !early.ok, early.out.trim());
  const t = L.load(id);
  const msgs = await L.readMsgs(ROOM);
  const at = new Date(Math.max(Date.now(), Date.parse(msgs.at(-1).at) + 1)).toISOString();
  const q = { id: `v${Date.now().toString(36)}`, by: 'dhc-verify', text: t.button, at, refs: [] };
  await api('PATCH', '/api/user/preferences', { [`dhc.chat:${ROOM}`]: { msgs: [...msgs, q].slice(-50) } });
  const rep = await api('POST', '/api/assistant/reply', { roomId: ROOM, triggerAt: at, profileId: 'dhc-verify' }); console.log('按鈕 → 小助手', JSON.stringify(rep).slice(0, 80));
  const t0 = Date.now(); let s;
  while (Date.now() - t0 < 180000) { await sleep(5000); s = L.load(id).status; if (s === 'done' || s === 'failed') break; }
  const fin = L.load(id); console.log('狀態', fin.status, Math.round((Date.now() - t0) / 1000) + 's', 'approvedBy', fin.approvedBy); console.log(String(fin.result || '').slice(0, 400));
  await sleep(1000); const again = run(['run.cjs', id]); console.log('重跑 → 應拒', !again.ok, again.out.trim());
  const after = await L.readMsgs(ROOM); console.log('聊天室最後一則：', String(after.at(-1).text).slice(0, 120).replace(/\n/g, ' / '));
  console.log(fin.status === 'done' && !early.ok && !again.ok ? 'RESULT OK' : 'RESULT FAIL');
})().catch((e) => console.log('script fail', e.message));
