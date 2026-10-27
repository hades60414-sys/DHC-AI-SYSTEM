'use strict';
// 夜間背景用：跑完整 37 題 eval.cjs，不論成敗都接著 qa.cjs stop，確保模型伺服器不留著。
const { spawnSync } = require('child_process');
const r = spawnSync(process.execPath, ['eval.cjs', ...process.argv.slice(2)], { cwd: __dirname, stdio: 'inherit' });
const s = spawnSync(process.execPath, ['qa.cjs', 'stop'], { cwd: __dirname, stdio: 'inherit' });
console.log(`eval exit=${r.status} stop exit=${s.status}`);
process.exitCode = r.status || s.status || 0;
