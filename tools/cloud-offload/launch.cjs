// 用 node-pty 模擬終端機開 claude --cloud；用法：node launch.cjs <repo 目錄> <任務檔>
// 只處理「信任此資料夾」確認；看到 claude.ai/code 網址就印出並結束（雲端 session 會繼續跑）。
const pty = require('D:/TAS/Claude Code專案/DHC-CLI/repo/node_modules/node-pty');
const fs = require('fs');
const [cwd, taskFile] = process.argv.slice(2);
const task = fs.readFileSync(taskFile, 'utf8').trim();
const p = pty.spawn('cmd.exe', ['/c', 'D:/TAS/cc-host/claude.cmd', '--cloud', task], { cwd, cols: 200, rows: 50, env: process.env });
let buf = '', trusted = false;
const plain = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');
p.onData(d => {
  process.stdout.write(d);
  buf = (buf + plain(d)).slice(-20000);
  if (!trusted && /Yes, I trust this folder/.test(buf)) {
    trusted = true;
    setTimeout(() => { p.write('\x1b[B'); setTimeout(() => p.write('\r'), 300); }, 500);
  }
  const m = buf.match(/https:\/\/claude\.ai\/code\/[\w\-\/?=&]+/);
  if (m) { console.log('\n[URL] ' + m[0]); setTimeout(() => { p.kill(); process.exit(0); }, 3000); }
});
p.onExit(e => { console.log('\n[exit]', e.exitCode); process.exit(0); });
setTimeout(() => { console.log('\n[timeout, kill]'); p.kill(); process.exit(0); }, 150000);
