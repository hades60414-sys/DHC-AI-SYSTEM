@echo off
REM Approval ticket watcher (2026-10-28), run every minute by task TAS-Approvals-Watch
"D:\TAS\node\node.exe" "D:\TAS\ai-tools\approvals\watch.cjs" >> "D:\TAS\ai-tools\approvals\watch.log" 2>&1
