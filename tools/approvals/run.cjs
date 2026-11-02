// 執行一張核准單：核對（使用者按過按鈕、沒過期、指令沒被改、沒執行過）後，直接呼叫那台代理跑核准單裡的指令，結果貼回聊天室。
//   node run.cjs <id>
const fs = require('node:fs');
const L = require('./lib.cjs');

async function main() {
  const id = process.argv[2];
  if (!/^[0-9a-f]{6}$/.test(id || '')) throw new Error('用法：node run.cjs <6 碼核准單號>');
  if (!fs.existsSync(L.ticketPath(id))) throw new Error('沒有這張核准單：' + id);
  const t = L.load(id);
  if (t.status !== 'pending') throw new Error(`核准單 ${id} 狀態是 ${t.status}，不再執行`);
  if (Date.now() > Date.parse(t.expires)) throw new Error(`核准單 ${id} 已過期（${t.expires}）`);
  if (L.sha(t.machine, t.cmd) !== t.sha256) throw new Error(`核准單 ${id} 的指令和開單時不一樣，拒絕執行`);
  const msgs = await L.readMsgs(t.room);
  const click = msgs.find((m) => m.by !== L.ASSISTANT && String(m.text || '').trim() === t.button && Date.parse(m.at) > Date.parse(t.created));
  if (!click) throw new Error(`聊天室裡找不到使用者按「${t.button}」的紀錄，拒絕執行`);

  // 搶鎖：同一張只會有一個 run 進得來
  fs.writeFileSync(L.ticketPath(id) + '.lock', String(process.pid), { flag: 'wx' });
  t.status = 'running'; t.approvedBy = click.by; t.approvedAt = click.at; L.save(t);
  L.log(`run\t${id}\t${t.machine}\tapprovedBy=${click.by}`);

  let r;
  try {
    const wait = Math.min(600, t.timeout + 60);
    r = await L.callTool(t.machine, 'ragent_cmd', { cmd: t.cmd, timeout_sec: t.timeout, wait_seconds: wait }, (wait + 660) * 1000); // 660：主機忙時 ragent-mcp 最多排 10 分鐘（2026-10-29）
  } catch (e) { r = { text: '執行失敗：' + e.message, isError: true }; }
  t.status = r.isError ? 'failed' : 'done'; t.ranAt = new Date().toISOString(); t.result = r.text.slice(0, 20000); L.save(t);
  L.log(`${t.status}\t${id}\t${t.machine}`);
  const brief = r.text.length > 3000 ? r.text.slice(0, 1000) + '\n…\n' + r.text.slice(-1800) : r.text;
  await L.post(t.room, `【核准單 ${id}】${r.isError ? '執行失敗' : '已執行'}（${L.label(t.machine)}）\n\`\`\`\n${brief}\n\`\`\`\n完整結果在 D:/TAS/ai-tools/approvals/tickets/${id}.json`);
  console.log(`${t.status}\n${brief}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
