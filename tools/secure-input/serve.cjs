// seal-proxy 在 /_secure/<token> 掛這支（在請求計數之前，連結不進任何紀錄）。GET 給表單，POST 收值交給 deliver.cjs。
// 頁面不載入任何外部資源、不跑 JS（CSP 全關），不快取、不帶 Referer、不能被嵌入。
// 2026-10-30：Referrer-Policy 不能用 no-referrer，瀏覽器會讓表單 POST 帶 Origin: null，被前門 Worker 的跨站防護擋成 403；strict-origin 只送網址根，不帶一次性碼。
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const C = require('./common.cjs');

const HEAD = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'strict-origin', 'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LABELS = { rag1: 'srv-rag' };
function label(machine) {
  try { const s = JSON.parse(fs.readFileSync('D:/TAS/Claude Code專案/Harness優化/.mcp.json', 'utf8')).mcpServers[machine]; return LABELS[machine] || (s && s.env && s.env.RAGENT_LABEL) || machine; } catch { return machine; }
}
function page(res, status, title, body) {
  res.writeHead(status, HEAD);
  res.end(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
body{font-family:system-ui,"Microsoft JhengHei",sans-serif;background:#f4f5f7;margin:0;padding:24px;color:#1f2328}
.card{max-width:420px;margin:8vh auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:19px;margin:0 0 12px}p{line-height:1.6;margin:8px 0;color:#444}.m{font-family:Consolas,monospace;background:#eef1f4;padding:1px 6px;border-radius:4px}
label{display:block;margin:14px 0 4px;font-size:14px;color:#555}input{width:100%;box-sizing:border-box;font-size:17px;padding:10px;border:1px solid #c8ccd2;border-radius:8px}
button{margin-top:18px;width:100%;font-size:17px;padding:11px;border:0;border-radius:8px;background:#1f6feb;color:#fff}.s{font-size:13px;color:#777}
</style></head><body><div class="card">${body}</div></body></html>`);
}
function ticket(token) {
  if (!C.TOKEN_RE.test(token)) return null;
  try { const t = JSON.parse(fs.readFileSync(C.pendingPath(token), 'utf8')); return Date.now() < Date.parse(t.expires) ? t : null; } catch { return null; }
}
const gone = (res) => page(res, 410, '連結已失效', '<h1>連結已失效</h1><p>這個連結過期、已經用過，或不存在。需要的話請 AI 再開一張。</p>');

function handle(req, res) {
  const m = /^\/_secure\/([^/?#]*)(?:\?.*)?$/.exec(req.url || '');
  if (!m) return false;
  const token = m[1], t = ticket(token);
  if (req.method === 'GET') {
    if (!t) return gone(res), true;
    page(res, 200, '安全輸入', `<h1>安全輸入</h1><p>要存到 <b>${esc(label(t.machine))}</b> 的 <span class="m">${esc(t.name)}</span>${t.note ? `<br>${esc(t.note)}` : ''}</p>
<form method="post" autocomplete="off"><label for="v">值</label><input id="v" name="v" type="password" autocomplete="new-password" required minlength="${C.minChars(t.name)}" maxlength="512" autofocus>
<label for="v2">再輸入一次</label><input id="v2" name="v2" type="password" autocomplete="new-password" required minlength="${C.minChars(t.name)}" maxlength="512"><button type="submit">存到 ${esc(label(t.machine))}</button></form>
<p class="s">只能用一次，${esc(new Date(t.expires).toLocaleTimeString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' }))} 前有效。值直接存到那台的使用者環境變數，不經過聊天、不給 AI 看；結果會貼回私聊。</p>`);
    return true;
  }
  if (req.method !== 'POST') { res.writeHead(405, HEAD); res.end(); return true; }
  let body = '', over = false;
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > 4096) { over = true; req.destroy(); } });
  // 例外不能往上丟：這裡跑在 seal-proxy 裡，丟出去整個網頁版會斷
  req.on('end', () => { try { onEnd(); } catch (e) { try { C.log('serve error\t' + e.message); if (!res.headersSent) page(res, 500, '出錯了', '<h1>出錯了</h1><p>沒有送出。請 AI 再開一張。</p>'); } catch {} } });
  req.on('error', () => {});
  const onEnd = () => {
    if (over) return;
    const f = new URLSearchParams(body); body = '';
    const v = f.get('v') || '', v2 = f.get('v2') || '';
    if (!ticket(token)) return gone(res);
    if (v !== v2) return page(res, 400, '兩次不一樣', '<h1>兩次輸入不一樣</h1><p>回上一頁重新輸入。</p>');
    const why = C.valueProblem(t.name, v);
    if (why) return page(res, 400, '格式不對', `<h1>格式不對</h1><p>${esc(why)}。回上一頁重新輸入。</p>`);
    // 先把單據搬到 done\ 才送：搬不動＝別人已經用掉（一次性）
    const key = C.keyOf(token), done = path.join(C.DONE, key + '.json');
    try { fs.mkdirSync(C.DONE, { recursive: true }); fs.renameSync(C.pendingPath(token), done); } catch { return gone(res); }
    try { const d = JSON.parse(fs.readFileSync(done, 'utf8')); d.submitted = new Date().toISOString(); fs.writeFileSync(done, JSON.stringify(d, null, 2)); } catch {}
    const p = spawn(process.execPath, [path.join(__dirname, 'deliver.cjs')], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, detached: true });
    p.on('error', () => C.log(`spawn failed\t${t.id}`));
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify({ key, value: v }));
    p.unref();
    C.log(`submit\t${t.id}\t${t.machine}\t${t.name}`);
    page(res, 200, '已送出', `<h1>已送出</h1><p>正在存到 <b>${esc(label(t.machine))}</b> 的 <span class="m">${esc(t.name)}</span>，結果約一分鐘內貼回私聊（那台忙時會排隊）。</p><p>這個頁面可以關掉了。</p>`);
  };
  return true;
}
module.exports = { handle };
