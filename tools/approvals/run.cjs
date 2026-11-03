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
  const isGrant = t.kind === 'grant';
  if (L.sha(t.machine, isGrant ? 'GRANT\n' + t.prefix : t.cmd) !== t.sha256) throw new Error(`核准單 ${id} 的內容和開單時不一樣，拒絕執行`);
  const msgs = await L.readMsgs(t.room);
  // 兩種同意：私聊按卡，或在開單的對話裡回 OK（wake.cjs convApproval）
  const click = msgs.find((m) => m.by !== L.ASSISTANT && String(m.text || '').trim() === t.button && Date.parse(m.at) > Date.parse(t.created))
    || require('./wake.cjs').convApproval(t);
  if (!click) throw new Error(`聊天室裡找不到使用者按「${t.button}」的紀錄，開單的對話裡也沒有同意，拒絕執行`);

  // 搶鎖：同一張只會有一個 run 進得來
  fs.writeFileSync(L.ticketPath(id) + '.lock', String(process.pid), { flag: 'wx' });
  t.status = 'running'; t.approvedBy = click.by; t.approvedAt = click.at; L.save(t);
  // 開單的對話自己跑 run.cjs（使用者剛在對話裡回 OK）：結果直接回到這個對話，不用事後再叫醒
  if (t.origin && process.env.CLAUDE_CODE_SESSION_ID === t.origin) { t.origin = null; L.save(t); }
  L.log(`run\t${id}\t${t.machine}\tapprovedBy=${click.by}`);

  // 常設授權卡：不執行任何指令，只啟用授權（寫 grants\<id>.json）
  if (isGrant) {
    const G = require('./grant.cjs');
    const bad = G.unsafe(t.prefix);
    if (bad) { t.status = 'failed'; t.result = bad; L.save(t); throw new Error(`常設授權 ${id} 的字首不合格：${bad}`); }
    const g = G.activate(t, click);
    t.status = 'done'; t.ranAt = new Date().toISOString(); t.result = '已啟用'; t.wakePending = !!t.origin; L.save(t);
    L.log(`grant-on\t${id}\t${t.machine}\t${G.left(g)}`);
    await L.post(t.room, `【常設授權 ${id}】已啟用（${L.label(t.machine)}，${G.left(g)}）。之後開頭是「${t.prefix}」的指令直接執行，每次都會貼回這裡。`);
    await wakeOrigin(id);
    return console.log('grant on ' + id);
  }

  let r;
  try {
    const wait = Math.min(600, t.timeout + 60);
    r = await L.callTool(t.machine, 'ragent_cmd', { cmd: t.cmd, timeout_sec: t.timeout, wait_seconds: wait }, (wait + 660) * 1000); // 660：主機忙時 ragent-mcp 最多排 10 分鐘（2026-10-29）
  } catch (e) { r = { text: '執行失敗：' + e.message, isError: true }; }
  t.status = r.isError ? 'failed' : 'done'; t.ranAt = new Date().toISOString(); t.result = r.text.slice(0, 20000); t.wakePending = !!t.origin; L.save(t);
  L.log(`${t.status}\t${id}\t${t.machine}`);
  const brief = r.text.length > 3000 ? r.text.slice(0, 1000) + '\n…\n' + r.text.slice(-1800) : r.text;
  await L.post(t.room, `【核准單 ${id}】${r.isError ? '執行失敗' : '已執行'}（${L.label(t.machine)}）\n\`\`\`\n${brief}\n\`\`\`\n完整結果在 D:/TAS/ai-tools/approvals/tickets/${id}.json`);
  await wakeOrigin(id);
  console.log(`${t.status}\n${brief}`);
}

// 叫醒開單的對話接著做（對話忙就留給 watch.cjs 下一分鐘再試）；叫不成不影響這張單的結果
async function wakeOrigin(id) {
  try { L.log(`wake-try\t${id}\t${await require('./wake.cjs').wake(id)}`); } catch (e) { L.log(`wake-error\t${id}\t${e.message}`); }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
