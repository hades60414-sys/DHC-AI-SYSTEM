#!/usr/bin/env node
'use strict';
// 2026-10-01 現場升級後：等 srv-db 心跳顯示對話模型正常（使用者關掉所有 CMD 後，模型要靠自動重啟或重新登入開回來）。
// 只讀心跳檔、用控制程式驗章解開；不送任何工作。每 30 秒看一次，最多 45 分鐘。
//   node wait-model-ok.cjs
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const A = path.join(os.homedir(), '.cloudcli', 'assets'), CTL = path.join(__dirname, '..', 'Controller-V31.ps1');
const since = Date.parse('2026-10-01T00:49:30Z'), seen = new Set(), t0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  while (Date.now() - t0 < 45 * 60000) {
    const files = fs.readdirSync(A).filter(f => f.endsWith('-ragent-agent-heartbeat.cms.b64.txt') && !seen.has(f)).map(f => ({ f, t: fs.statSync(path.join(A, f)).mtimeMs })).filter(x => x.t > since).sort((a, b) => a.t - b.t);
    for (const { f } of files) {
      seen.add(f);
      try {
        const j = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CTL, '-Command', 'heartbeat', '-File', path.join(A, f)], { encoding: 'utf8' }));
        console.log(new Date().toISOString(), 'heartbeat', j.createdUtc, j.agentVersion, String(j.modelHealth).slice(0, 80));
        if (/"status"\s*:\s*"ok"/.test(String(j.modelHealth))) { console.log('MODEL OK'); process.exit(0); }
      } catch (e) { console.log('skip', f, String(e.message).slice(0, 120)); }
    }
    await sleep(30000);
  }
  console.log('TIMEOUT: no heartbeat with a healthy model in 45 min'); process.exit(1);
})();
