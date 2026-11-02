// 由 serve.cjs 啟動：stdin 收 {id}＋值，呼叫那台代理程式的 secret-set（ragent_secret_set，只有這裡會打開），結果貼回私聊。
// 值只從 stdin 進來，不放命令列、不寫檔；貼回去的文字先把值換成 [REDACTED] 以防萬一。
const fs = require('node:fs'), path = require('node:path');
const C = require('./common.cjs'), L = require('../approvals/lib.cjs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; if (input.length > 8192) process.exit(2); });
process.stdin.on('end', async () => {
  const { key, value } = JSON.parse(input); input = '';
  const file = path.join(C.DONE, key + '.json'), t = JSON.parse(fs.readFileSync(file, 'utf8'));
  const esc = JSON.stringify(value).slice(1, -1);
  const scrub = (s) => String(s).split(value).join('[REDACTED]').split(esc).join('[REDACTED]');
  process.env.RAGENT_SECRET_SET = '1';
  let r;
  try { r = await L.callTool(t.machine, 'ragent_secret_set', { name: t.name, value, wait_seconds: 120 }, 12 * 60000); }
  catch (e) { r = { text: '執行失敗：' + e.message, isError: true }; }
  const ok = !r.isError && /"stored":true/.test(r.text), queued = !r.isError && /已送出（seq/.test(r.text);
  t.result = ok ? 'stored' : queued ? 'queued' : 'failed'; t.chars = value.length; t.finished = new Date().toISOString();
  if (!ok) t.detail = scrub(r.text).slice(0, 600);
  fs.writeFileSync(file, JSON.stringify(t, null, 2));
  C.log(`deliver\t${t.id}\t${t.machine}\t${t.name}\t${t.result}\t${value.length} chars`);
  const head = `【安全輸入 ${t.id}】`;
  await L.post(t.room, queued ? `${head}已送到 ${L.label(t.machine)}，那台還沒回報（可能在排隊或離線）。AI 之後可用 ragent_cmd 查那台 cmd-run.log 有沒有「secret-set ${t.name}」。` : ok ? `${head}已存 ${t.name} 到 ${L.label(t.machine)}（${value.length} 字）。之後指令裡用 %${t.name}%，輸出會遮蔽。`
    : `${head}沒存成：${L.label(t.machine)} 的 ${t.name}。\n${t.detail}\n要重來請 AI 再開一張。`).catch(() => {});
  process.exit(ok ? 0 : 1);
});
