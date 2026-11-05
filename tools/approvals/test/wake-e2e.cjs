// 核准後續接端對端（測試房，使用者看不到）：從某個網頁版對話裡開單 → 模擬按鈕 → 等排程執行 →
// 開單對話還在忙時要標「等待」、不送；之後由 watch.cjs 在對話閒下來時叫醒它（這一步要由開單的對話自己觀察到被叫醒）。
// 另外用 --dry 確認一個閒著的對話會被叫醒、訊息內容正確。只能在 DHC CLI 網頁版對話裡跑（要有 CLAUDE_CODE_SESSION_ID）。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const L = require('../lib.cjs');
const { wake, state } = require('../wake.cjs');
const NODE = process.execPath, ROOM = 'dm:dhc-assistant~dhc-verify', BASE = 'http://127.0.0.1:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args) => { try { return { ok: true, out: execFileSync(NODE, args, { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; } };
const api = async (m, u, b) => (await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
(async () => {
  const me = process.env.CLAUDE_CODE_SESSION_ID; if (!me) return console.log('RESULT FAIL：不在 Claude Code 對話裡');
  const a = run(['ask.cjs', '--machine', 'rag1', '--cmd-file', 'test/cmd-ok.txt', '--why', '核准後續接端對端測試', '--rollback', '無（只印字）', '--room', ROOM,
    '--next', '這是核准後續接的端對端測試：先寫一行「續接測試收到」，再繼續你原本的工作。']);
  const id = (a.out.match(/核准單 ([0-9a-f]{6})/) || [])[1]; console.log('開單', a.ok, id, 'origin', L.load(id).origin === me);
  const t = L.load(id), msgs = await L.readMsgs(ROOM);
  const at = new Date(Math.max(Date.now(), Date.parse(msgs.at(-1).at) + 1)).toISOString();
  await api('PATCH', '/api/user/preferences', { [`dhc.chat:${ROOM}`]: { msgs: [...msgs, { id: `v${Date.now().toString(36)}`, by: 'dhc-verify', text: t.button, at, refs: [] }].slice(-50) } });
  const t0 = Date.now(); let fin;
  while (Date.now() - t0 < 180000) { await sleep(5000); fin = L.load(id); if (fin.status === 'done' || fin.status === 'failed') break; }
  console.log('排程執行', fin.status, Math.round((Date.now() - t0) / 1000) + 's');
  await sleep(2000); fin = L.load(id);
  const busyOk = fin.wakePending === true && /^等待/.test(fin.wakeNote || '');
  console.log('開單對話忙 → 應等待不送', busyOk, fin.wakeNote);
  // 閒著的對話：找一個最近 10 分鐘沒寫入、最後是已結束回覆的網頁版對話，只做 --dry
  const dir = 'C:/Users/demo/.claude/projects/D--TAS-Claude-Code---Harness--';
  const idle = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.startsWith(me)).map((f) => f.slice(0, -6)).find((s) => state(path.join(dir, s + '.jsonl')).idle);
  const saved = L.load(id); L.save({ ...saved, origin: idle, wakePending: true });
  const dry = await wake(id, { dry: true }); console.log('閒著的對話 → 應會叫醒（dry）', /^會叫醒/.test(dry), dry.slice(0, 160));
  L.save(saved); // 換回自己，讓 watch 之後叫醒這個對話
  console.log(fin.status === 'done' && busyOk && /^會叫醒/.test(dry) ? 'RESULT OK（剩下：這個對話結束回合後 1～2 分鐘內應被叫醒）' : 'RESULT FAIL');
})().catch((e) => { console.log('script fail', e.message); process.exitCode = 1; }); // 失敗要讓 CI／呼叫端看得到
