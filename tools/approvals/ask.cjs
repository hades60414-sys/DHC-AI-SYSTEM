// 開一張核准單：把要在別台跑的指令貼到使用者和小助手的私聊，附「同意核准單 <id>」按鈕。
//   node ask.cjs --machine rag1 --cmd-file <指令檔> --why "<為什麼>" --rollback "<怎麼回退>" [--timeout 600] [--room <聊天室>] [--next "<執行後要做什麼>"] [--no-resume] [--dry]
// 指令一律放檔案（危險字串寫在指令列會被 dhc-guard 擋）。按鈕按下後由排程 TAS-Approvals-Watch（watch.cjs）每分鐘
// 呼叫 run.cjs 核對後只執行這一筆；小助手模型不參與執行。
const fs = require('node:fs'), crypto = require('node:crypto');
const L = require('./lib.cjs');
const WL = require('./whitelist.cjs');
const G = require('./grant.cjs');

const USER_PROJECT = '00000000-0000-0000-0000-000000000000';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

async function main() {
  const machine = arg('machine'), cmdFile = arg('cmd-file'), why = arg('why'), rollback = arg('rollback');
  if (!machine || !cmdFile || !why) throw new Error('要給 --machine --cmd-file --why --rollback');
  const tools = L.servers()[machine];
  if (!tools) throw new Error('.mcp.json 沒有這台：' + machine);
  if (machine !== 'ragent' && (tools.env || {}).RAGENT_CMD !== '1') throw new Error(machine + ' 沒開 ragent_cmd');
  const cmd = fs.readFileSync(cmdFile, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!cmd || cmd.length > 8000) throw new Error('指令是空的或超過 8000 字');
  const timeout = Math.min(1800, Number(arg('timeout', 600)));
  const room = arg('room', 'dm:' + [USER_PROJECT, L.ASSISTANT].sort().join('~'));
  const id = crypto.randomBytes(3).toString('hex');
  const wl = WL.check(cmd);
  if (wl.ok) return runWhitelisted({ id, machine, cmd, why, timeout, room, rule: wl.rule });
  const g = G.match(machine, cmd);
  if (g) return runWhitelisted({ id, machine, cmd, why, timeout, room, grant: g });
  if (!rollback) throw new Error(`這筆要開核准單（${wl.reason}），要給 --rollback`);
  const button = `同意核准單 ${id}`;
  const created = new Date().toISOString();
  // origin：開單的對話；執行完由 wake.cjs 叫醒它接著做（--no-resume 不叫；--next 寫執行後要做什麼）
  const t = { id, machine, cmd, sha256: L.sha(machine, cmd), why, rollback, timeout, room, button, created,
    expires: new Date(Date.now() + L.TTL_MS).toISOString(), status: 'pending',
    origin: process.argv.includes('--no-resume') ? null : process.env.CLAUDE_CODE_SESSION_ID || null, next: arg('next') || null };
  const text = [
    `【核准單 ${id}】要在 ${L.label(machine)} 執行（24 小時內有效，只能執行一次）`,
    `原因：${why}`,
    '指令：', '```', cmd.length > 1500 ? cmd.slice(0, 1500) + '\n…（全文在核准單檔）' : cmd, '```',
    `回退：${rollback}`,
    `按下面的「${button}」＝同意。一分鐘內由核准單程式（不是小助手）核對是你按的、指令沒被改過，才只執行上面這一筆，結果貼回這裡${t.origin ? '，並叫開單的對話接著把工作做完' : ''}。不按就不會做。`,
    `（小助手：看到「${button}」只要回「收到，核准單程式一分鐘內執行」，不用做別的。）`,
  ].join('\n');
  if (process.argv.includes('--dry')) return console.log(text);
  fs.mkdirSync(L.DIR, { recursive: true });
  L.save(t);
  await L.post(room, text, button);
  L.log(`ask\t${id}\t${machine}\t${t.sha256.slice(0, 12)}\t${why}`);
  console.log(`已貼核准單 ${id}（${L.label(machine)}），等使用者按鈕${t.origin ? `。也可以在這段對話直接問：把單號 ${id} 和要做的事列給使用者，他下一則回 OK／同意 就算核准，接著跑 node D:/TAS/ai-tools/approvals/run.cjs ${id}` : ''}`);
}

// 白名單內的唯讀指令、或命中常設授權（grant.cjs）的指令：不開單，直接呼叫那台代理執行，紀錄照樣存成 tickets\<id>.json（auto: true）並貼回聊天室
async function runWhitelisted({ id, machine, cmd, why, timeout, room, rule, grant }) {
  const via = grant ? `依常設授權 ${grant.id}` : `白名單「${rule}」，唯讀`;
  if (process.argv.includes('--dry')) return console.log(`免核准（${via}），會直接在 ${L.label(machine)} 執行：${cmd}`);
  if (grant) grant = G.consume(grant);
  const t = { id, machine, cmd, sha256: L.sha(machine, cmd), why, auto: true, rule, grant: grant && grant.id, timeout, room,
    created: new Date().toISOString(), status: 'running' };
  fs.mkdirSync(L.DIR, { recursive: true });
  L.save(t);
  L.log(`auto\t${id}\t${machine}\t${grant ? 'grant=' + grant.id : 'rule=' + rule}\t${why}`);
  let r;
  try {
    const wait = Math.min(600, timeout + 60);
    // 前置變數讓 cmd 不從目前目錄找外部程式（避免家目錄裡同名的 hostname.bat 之類被執行）
    t.sent = 'set NoDefaultCurrentDirectoryInExePath=1& ' + cmd; L.save(t);
    r = await L.callTool(machine, 'ragent_cmd', { cmd: t.sent, timeout_sec: timeout, wait_seconds: wait }, (wait + 660) * 1000); // 660：主機忙時 ragent-mcp 最多排 10 分鐘（2026-10-29）
  } catch (e) { r = { text: '執行失敗：' + e.message, isError: true }; }
  t.status = r.isError ? 'failed' : 'done'; t.ranAt = new Date().toISOString(); t.result = r.text.slice(0, 20000); L.save(t);
  L.log(`${t.status}\t${id}\t${machine}\tauto`);
  const brief = r.text.length > 3000 ? r.text.slice(0, 1000) + '\n…\n' + r.text.slice(-1800) : r.text;
  await L.post(room, [`【免核准 ${id}】${r.isError ? '執行失敗' : '已直接執行'}（${L.label(machine)}，${via}${grant ? '，' + G.left(grant) : ''}）`,
    `原因：${why}`, '指令：', '```', cmd, '```', '結果：', '```', brief, '```'].join('\n'));
  console.log(`免核准 ${id} ${t.status}\n${brief}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
