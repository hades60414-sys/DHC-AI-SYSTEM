'use strict';
// 單次往返：submit → publish-inbox → 等新的 *-ragent-agent-report → receive。用法：node roundtrip.cjs <action> [prompt-file] [完整報告輸出檔]
// 2026-09-30：srv-db 已升到 v3 → 改用 Controller-V3（同一份狀態，多允許 doc-qa）；doc-qa 要 1–3 分鐘，等待上限 480 秒。回滾到 v2 時改回 Controller-V2.ps1。
const { execFileSync } = require('child_process'), fs = require('fs'), path = require('path');
const assets = path.join(process.env.USERPROFILE, '.cloudcli', 'assets');
const ctl = (...a) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'Controller-V3.ps1'), ...a], { encoding: 'utf8' }).trim();
const reports = () => new Set(fs.readdirSync(assets).filter(f => f.endsWith('-ragent-agent-report.cms.b64.txt')));
// 控制程式的螢幕輸出是 Big5（中文會變亂碼），完整結果改從狀態檔（UTF-8）的 LastResult 讀
const lastResult = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'controller-state', 'controller-state.json'), 'utf8').replace(/^﻿/, '')).LastResult;
(async () => {
  const [action, promptFile, outFile] = process.argv.slice(2);
  const before = reports(), t0 = Date.now();
  ctl('-Command', 'submit', '-Action', action, ...(promptFile ? ['-PromptFile', promptFile] : []));
  ctl('-Command', 'publish-inbox');
  const tPub = Date.now();
  let got = null;
  while (Date.now() - t0 < 480000) {
    const now = [...reports()].filter(f => !before.has(f));
    for (const f of now) { try { const out = ctl('-Command', 'receive', '-File', path.join(assets, f)); if (out && !out.startsWith('Duplicate')) { got = lastResult(); break; } } catch {} }
    if (got) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!got) { console.log(JSON.stringify({ action, error: 'no report within 480s' })); process.exitCode = 1; return; }
  const d = JSON.parse(got);
  if (outFile) fs.writeFileSync(outFile, got + '\n');
  console.log(JSON.stringify({ action, seq: d.seq, state: d.executionState, roundtrip_ms: Date.now() - tPub, summary: d.summary.slice(0, 600) }));
})();
