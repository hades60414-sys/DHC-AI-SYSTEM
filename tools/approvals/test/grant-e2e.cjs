// 常設授權端對端（測試房 dm:dhc-assistant~dhc-verify，使用者看不到）：
// 開授權卡 → 沒按就跑要拒 → 模擬按鈕 → run.cjs 啟用 → ask.cjs 在 srv-rag 跑 echo 要走授權直接執行、次數減一 → 撤銷 → 再問要回到開單
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const L = require('../lib.cjs');
const NODE = process.execPath, ROOM = 'dm:dhc-assistant~dhc-verify', BASE = 'http://127.0.0.1:3001', CWD = path.join(__dirname, '..');
const run = (args) => { try { return { ok: true, out: execFileSync(NODE, args, { cwd: CWD, encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; } };
const api = async (m, u, b) => (await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
(async () => {
  const PREFIX = 'echo grant-e2e';
  const a = run(['grant.cjs', 'propose', '--machine', 'rag1', '--prefix', PREFIX, '--why', '常設授權端對端測試', '--days', '1', '--uses', '2', '--room', ROOM, '--no-resume']);
  const id = (a.out.match(/常設授權卡 ([0-9a-f]{6})/) || [])[1]; console.log('開卡', a.ok, id, a.ok ? '' : a.out);
  const early = run(['run.cjs', id]); console.log('沒按就啟用 → 應拒', !early.ok, early.out.trim());
  const t = L.load(id), msgs = await L.readMsgs(ROOM);
  const at = new Date(Math.max(Date.now(), Date.parse(msgs.at(-1).at) + 1)).toISOString();
  await api('PATCH', '/api/user/preferences', { [`dhc.chat:${ROOM}`]: { msgs: [...msgs, { id: `v${Date.now().toString(36)}`, by: 'dhc-verify', text: t.button, at, refs: [] }].slice(-50) } });
  const on = run(['run.cjs', id]);
  // 排程 watch.cjs 可能搶先啟用；兩種都算
  const active = fs.existsSync(path.join(CWD, 'grants', id + '.json')); console.log('按鈕後啟用', active, on.out.trim() || '(排程已先啟用)');
  const cmdFile = path.join(CWD, 'test', 'cmd-grant.txt'); fs.writeFileSync(cmdFile, PREFIX + ' ok', 'utf8');
  const use = run(['ask.cjs', '--machine', 'rag1', '--cmd-file', cmdFile, '--why', '授權端對端：應直接執行', '--room', ROOM]);
  console.log('命中授權直接執行', use.ok, use.out.trim().split('\n')[0]);
  const g1 = JSON.parse(fs.readFileSync(path.join(CWD, 'grants', id + '.json'), 'utf8')); console.log('剩餘次數 2→', g1.usesLeft);
  const rv = run(['grant.cjs', 'revoke', id]); console.log('撤銷', rv.ok, rv.out.trim());
  const after = run(['ask.cjs', '--machine', 'rag1', '--cmd-file', cmdFile, '--why', '撤銷後應開單', '--room', ROOM, '--dry']);
  const backToTicket = !after.ok && /rollback/.test(after.out); console.log('撤銷後回到開單', backToTicket, after.out.trim().slice(0, 60));
  const last = (await L.readMsgs(ROOM)).slice(-3).map((m) => String(m.text).split('\n')[0]); console.log('聊天室最後三則：', last);
  const pass = !early.ok && active && use.ok && /依常設授權/.test(use.out + last.join()) && g1.usesLeft === 1 && rv.ok && backToTicket;
  console.log(pass ? 'RESULT OK' : 'RESULT FAIL');
})().catch((e) => console.log('script fail', e.message));
