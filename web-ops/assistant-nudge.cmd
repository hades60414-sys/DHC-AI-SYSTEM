@echo off
REM DHC assistant proactive nudges (2026-10-21). Usage: assistant-nudge.cmd waiting or brief
"D:\TAS\node\node.exe" "D:\TAS\cc-web\assistant-nudge.cjs" %1 >> "D:\TAS\cc-web\assistant-nudge.out.log" 2>&1
