// 一次性提醒（2026-10-25）：到時間貼一則到小助手私聊，下面附一顆按鈕，按下去＝同意，小助手直接開 Opus 對話照任務檔做。
//   node remind.cjs <提醒.json> [--dry]
// 提醒.json：{ "project": 私聊對象的專案 id, "text": 訊息, "button": 按鈕字（24 字內）, "task": 任務檔路徑 }
// 按鈕走小助手既有的追問按鈕（~/.cloudcli/assistant/next/<room>.json，只掛在最新一則）。貼過會在提醒.json 旁留 .done，不重貼。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const BASE = process.env.NUDGE_BASE || 'http://127.0.0.1:3001';
const ASSISTANT = 'dhc-assistant';
const file = process.argv[2], DRY = process.argv.includes('--dry');
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
const done = file + '.done';
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
  return res.json();
};
async function main() {
  if (fs.existsSync(done)) return console.log('已貼過，跳過');
  if ([...r.button].length > 24) throw new Error('按鈕字超過 24 字');
  const text = `${r.text}\n\n任務說明：${r.task}\n按下面的按鈕＝同意，直接開 Opus 對話照任務說明做（這則就是第 3 級的同意）。`;
  const room = [r.project, ASSISTANT].sort().join('~');
  const key = `dhc.chat:dm:${room}`;
  if (DRY) return console.log(`[${key}]\n${text}\n[按鈕] ${r.button}`);
  const msgs = (await api('GET', '/api/user/preferences'))?.preferences?.[key]?.msgs ?? [];
  const lastAt = msgs.reduce((m, x) => (x.at > m ? x.at : m), '');
  const at = new Date(Math.max(Date.now(), lastAt ? Date.parse(lastAt) + 1 : 0)).toISOString();
  const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await api('PATCH', '/api/user/preferences', { [key]: { msgs: [...msgs, { id, by: ASSISTANT, text, at, refs: [] }].sort((a, b) => a.at.localeCompare(b.at)).slice(-300) } });
  const nextDir = path.join(process.env.ASSISTANT_ROOT || path.join(os.homedir(), '.cloudcli', 'assistant'), 'next');
  fs.mkdirSync(nextDir, { recursive: true });
  fs.writeFileSync(path.join(nextDir, `dm:${room}`.replace(/[^\w-]/g, '_') + '.json'), JSON.stringify({ messageId: id, items: [r.button] }), 'utf8');
  fs.writeFileSync(done, at);
  console.log(`已貼 ${id}`);
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
