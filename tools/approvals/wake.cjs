// 核准後續接（2026-11-03，學 ChatGPT「核准到位後自動續接」）：核准單執行完，叫醒開單的那個 DHC CLI 對話，讓它讀結果把原本的工作做完。
//   node wake.cjs <核准單號> [--dry]     （run.cjs 執行完、watch.cjs 每分鐘都會呼叫；這裡也可以手動補叫）
// 開單時 ask.cjs 記下 t.origin（CLAUDE_CODE_SESSION_ID）。只在那個對話閒著時送：最後一則是已結束的助手回覆、60 秒內沒寫入。
// 忙就留著 wakePending，下一分鐘 watch.cjs 再試；超過 6 小時放棄。不是網頁版的對話（claude -p、無頭）不叫。
const fs = require('node:fs'), path = require('node:path');
const L = require('./lib.cjs');

const PROJECTS = process.env.WAKE_PROJECTS || path.join(require('node:os').homedir(), '.claude', 'projects');
const GIVE_UP_MS = 6 * 3600e3;

function transcript(id) {
  for (const d of fs.readdirSync(PROJECTS)) { const f = path.join(PROJECTS, d, id + '.jsonl'); if (fs.existsSync(f)) return f; }
  return null;
}

// 讀尾段判斷：閒著嗎、權限模式是什麼
function state(file) {
  const st = fs.statSync(file), size = st.size, fd = fs.openSync(file, 'r');
  const n = Math.min(size, 512 * 1024), buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
  let last = null, mode = null;
  for (const line of buf.toString('utf8').split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.permissionMode) mode = o.permissionMode;
    if ((o.type === 'user' || o.type === 'assistant') && !o.isSidechain) last = o;
  }
  if (!mode) { const m = [...fs.readFileSync(file, 'utf8').matchAll(/"permissionMode":"(\w+)"/g)].pop(); mode = m ? m[1] : 'default'; }
  const ended = last && last.type === 'assistant' && last.message?.stop_reason === 'end_turn';
  return { idle: !!ended && Date.now() - st.mtimeMs > 60e3, mode, quietSec: Math.round((Date.now() - st.mtimeMs) / 1000) };
}

// 在場時先說好（2026-11-03 觀察者提案、使用者同意）：AI 在開單的對話裡把單號列給使用者看，使用者在同一段對話回 OK 就算核准，不用去私聊按卡。
// 條件全部成立才算：(1) 開單後 AI 的回覆文字裡出現過這個單號（AI 不能偷開單、讓使用者一句 OK 順便放行）；
// (2) AI 列出單號之後、使用者接著打的那一則（回了別的就要 AI 再列一次）；(3) 那則是同意（短的「OK／好／同意／都做」，或寫了「同意 <單號>」）。逐項回答、講別的都不算，照舊等按卡。
// 限制同常設授權：AI 與排程同一個 Windows 帳號，改得到對話紀錄檔就能偽造，這是防誤用不是防惡意。
const ASSENT = /^(好|好的|好啊|好喔|可以|行|ok|OK|Ok|嗯|對|是|沒問題|同意|照做|都做|都可以|都好|全部做|全部|做一做|做吧|做|go|Go|yes|Yes|都OK|都ok|OK都做|ok都做|都做一做|全部做一做|直接做|核准|准)[!！。.～~啦喔吧啊阿]*$/;
function textOf(o) {
  const c = o.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && !c.some((x) => x.type === 'tool_result')) return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  return null;
}
function convApproval(t) {
  if (!t.origin) return null;
  const file = transcript(t.origin); if (!file) return null;
  const created = Date.parse(t.created); let shown = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain || Date.parse(o.timestamp) <= created) continue;
    const s = textOf(o); if (s == null) continue;
    if (o.type === 'assistant') { if (s.includes(t.id)) shown = true; continue; }
    if (o.type !== 'user') continue;
    const u = s.trim();
    // 系統通知、續接訊息、hook 回饋不是使用者打的
    if (!u || /^[<【\[]/.test(u) || /^(Stop hook feedback|Caveat:|This session is being continued)/.test(u)) continue;
    const short = u.replace(/\s+/g, '');
    const yes = shown && ((short.length <= 20 && ASSENT.test(short)) || new RegExp('(同意|核准|OK|ok)[^。\\n]{0,8}' + t.id).test(u));
    if (yes) return { by: 'conversation:' + t.origin, at: o.timestamp, text: u };
    shown = false; // 回了別的：要 AI 再列一次單號，下一則同意才算
  }
  return null;
}

function message(t) {
  const what = t.kind === 'grant' ? `常設授權 ${t.id} 已由使用者按鈕啟用（${L.label(t.machine)}，字首「${t.prefix}」）`
    : `核准單 ${t.id} 已由使用者核准，${L.label(t.machine)} 上的指令${t.status === 'done' ? '已執行完' : '執行失敗'}`;
  return `【核准後續接】${what}。結果在 D:\\TAS\\ai-tools\\approvals\\tickets\\${t.id}.json。` +
    '請讀結果，接著把開單前原本要做的工作做完（驗證成果、後續步驟），照常回報；執行失敗就判斷原因換路處理。不用重頭解釋。' +
    (t.next ? `開單時寫的後續：${t.next}` : '');
}

async function send(sessionId, model, permissionMode, content) {
  const WebSocket = require('D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/ws');
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:3001/ws');
    const skip = permissionMode === 'bypassPermissions';
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'chat.send', sessionId, content,
        options: { model, permissionMode, toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: skip }, skipPermissions: skip, attachments: [] } }));
      // 送出就好，不等回合結束（關掉連線不會中斷對話）
      setTimeout(() => { ws.close(); res(); }, 1500);
    });
    ws.on('error', rej);
    setTimeout(() => rej(new Error('連不上 CloudCLI（3001）')), 15000);
  });
}

// 回傳一句狀態；會更新核准單的 wakePending／woken／wakeNote
async function wake(id, { dry = false } = {}) {
  const t = L.load(id);
  if (!t.origin || !t.wakePending) return 'skip：沒有要叫醒的對話';
  const done = (note, keep = false) => { if (!dry) { t.wakePending = keep; t.wakeNote = note; if (!keep) t.wakeAt = new Date().toISOString(); L.save(t); } return note; };
  if (Date.now() - Date.parse(t.ranAt || t.created) > GIVE_UP_MS) return done('放棄：6 小時內對話一直沒閒下來');
  const file = transcript(t.origin);
  if (!file) return done('放棄：找不到開單對話的紀錄檔');
  const Database = require('D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/better-sqlite3');
  const db = new Database('D:/TAS/cc-web/data/auth.db', { readonly: true });
  const row = db.prepare('select session_id, model, isArchived from sessions where provider_session_id = ? order by updated_at desc limit 1').get(t.origin);
  db.close();
  if (!row || row.isArchived) return done(row ? '不叫：對話已封存' : '不叫：不是網頁版對話（claude -p 或無頭），結果只貼聊天室');
  const s = state(file);
  if (!s.idle) return done(`等待：對話還在忙（${s.quietSec} 秒前有寫入）`, true);
  if (dry) return `會叫醒 ${row.session_id}（model=${row.model || 'default'} mode=${s.mode}）：${message(t)}`;
  await send(row.session_id, row.model || 'default', s.mode, message(t));
  L.log(`wake\t${id}\t${t.origin}\t${row.session_id}\t${s.mode}`);
  return done(`已叫醒對話 ${row.session_id}`);
}

if (require.main === module) {
  wake(process.argv[2], { dry: process.argv.includes('--dry') }).then(console.log).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
// 給 keepgoing.cjs 用：最後一則主對話助手文字、對應的網頁版對話
function lastText(file) {
  const size = fs.statSync(file).size, n = Math.min(size, 512 * 1024), buf = Buffer.alloc(n), fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
  let t = null;
  for (const line of buf.toString('utf8').split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'assistant' && !o.isSidechain) { const s = textOf(o); if (s && s.trim()) t = s; }
  }
  return t;
}
function cloudRow(sid) {
  const Database = require('D:/TAS/cc-host/node_modules/@cloudcli-ai/cloudcli/node_modules/better-sqlite3');
  const db = new Database('D:/TAS/cc-web/data/auth.db', { readonly: true });
  const row = db.prepare('select session_id, model, isArchived from sessions where provider_session_id = ? order by updated_at desc limit 1').get(sid);
  db.close();
  return row && !row.isArchived ? row : null;
}

module.exports = { wake, state, message, convApproval, send, transcript, lastText, cloudRow };
