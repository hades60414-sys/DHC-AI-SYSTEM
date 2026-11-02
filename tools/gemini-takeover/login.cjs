// agy 一次性 Google 登入：互動模式開著等（最多 2 小時），選單自動選 Google OAuth，最新登入網址寫 login-url.txt；
// 使用者在瀏覽器登入後若需要貼碼，把碼放進 login-code.txt。畫面紀錄寫 login.log。
const pty = require('D:/TAS/Claude Code專案/DHC-CLI/repo/node_modules/node-pty');
const fs = require('fs');
const dir = __dirname;
const plain = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');
for (const f of ['login-url.txt', 'login-code.txt', 'login.log']) try { fs.unlinkSync(dir + '/' + f); } catch {}
const p = pty.spawn(dir + '\\agy.exe', [], { cwd: dir + '\\empty-cwd', cols: 1000, rows: 50, env: process.env });
let buf = '', picked = false;
p.onData(d => {
  fs.appendFileSync(dir + '/login.log', d);
  buf = (buf + plain(d)).slice(-50000);
  const all = buf.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s]+/g);
  if (all) fs.writeFileSync(dir + '/login-url.txt', all[all.length - 1]);
  if (!picked && /Select login method/.test(buf)) { picked = true; setTimeout(() => p.write('\r'), 800); }
});
setInterval(() => {
  if (fs.existsSync(dir + '/login-code.txt')) {
    p.write(fs.readFileSync(dir + '/login-code.txt', 'utf8').trim() + '\r');
    fs.unlinkSync(dir + '/login-code.txt');
  }
}, 1000);
p.onExit(e => { fs.appendFileSync(dir + '/login.log', '\n[exit] ' + e.exitCode + '\n'); process.exit(0); });
setTimeout(() => { fs.appendFileSync(dir + '/login.log', '\n[timeout]\n'); p.kill(); process.exit(0); }, 120 * 60000);
