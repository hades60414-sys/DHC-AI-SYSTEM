// 開一張安全輸入單：貼一張卡到使用者和小助手的私聊，裡面是一次性連結（15 分鐘、只能用一次）。
//   node ask.cjs --machine srv-main --name EKB_PWD [--note "EKB 登入密碼"] [--room <聊天室>]
// 不印連結（對話紀錄裡不留可用的連結）；只印單號。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const C = require('./common.cjs'), L = require('../approvals/lib.cjs');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
(async () => {
  const machine = arg('machine'), name = arg('name'), note = (arg('note', '') || '').slice(0, 80);
  const s = L.servers()[machine];
  if (!s) throw new Error('沒有這台：' + machine + '（用 .mcp.json 的伺服器名稱，例如 srv-main、rag1、userE）');
  if (!(machine === 'ragent' || (s.env && s.env.RAGENT_CMD === '1'))) throw new Error(machine + ' 沒開 ragent_cmd，代理程式收不到');
  if (!C.NAME_RE.test(name || '')) throw new Error('名稱要以 _PWD、_PASS、_TOKEN、_OTP 或 _USER 結尾（英數與底線）');
  if (C.TOOL_RE.test(name)) throw new Error(name + ' 是別的工具在用的變數名，不能存');
  if (C.HOST_MACHINES.includes(machine) && process.env.SECURE_INPUT_ALLOW_HOST !== '1') throw new Error(L.label(machine) + ' 是 AI 自己所在的主機，存在那裡的值 AI 讀得到，不開安全輸入單');
  // 卡片只貼到使用者自己的私聊（測試用 test: 開頭的聊天室），不能拿去騙同事填
  const own = 'dm:' + [C.USER_PROJECT, L.ASSISTANT].sort().join('~'), room = arg('room', own);
  if (room !== own && !room.startsWith('test:')) throw new Error('--room 只能是使用者自己的私聊或 test: 開頭的測試聊天室');
  const token = crypto.randomBytes(32).toString('hex');
  const id = C.keyOf(token).slice(0, 6), created = Date.now();
  fs.mkdirSync(C.PENDING, { recursive: true });
  fs.writeFileSync(C.pendingPath(token), JSON.stringify({ id, machine, name, note, room, created: new Date(created).toISOString(), expires: new Date(created + C.TTL_MS).toISOString() }, null, 2), { flag: 'wx' });
  const what = `${L.label(machine)} 的 ${name}${note ? `（${note}）` : ''}`;
  // 10-29 實測：使用者把值直接打在聊天框。連結做成大字按鈕，並明講不要打在這裡。
  await L.post(room, [`【安全輸入 ${id}】請輸入 ${what}`,
    `👉 **[點這裡開輸入頁](${await C.frontUrl()}/_secure/${token})**`,
    '⚠ 不要把值打在聊天框（聊天會被記錄、AI 看得到），要在點開的頁面裡填。',
    '15 分鐘內有效、只能用一次。值直接存到那台的使用者環境變數，不經過聊天、不給 AI 看；AI 之後只用 %' + name + '% 登入，輸出會遮蔽（遮蔽防不小心印出，擋不住刻意去讀）。',
    '不是你要求的就不要填。'].join('\n'));
  C.log(`ask\t${id}\t${machine}\t${name}`);
  console.log(`已貼安全輸入卡 ${id}（${what}），等使用者填寫；結果會貼回同一個私聊。`);
})().catch((e) => { console.error('失敗：' + e.message); process.exit(1); });
