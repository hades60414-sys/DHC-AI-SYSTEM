@echo off
REM Undo 2026-10-31 voice-call silence 700->1500 ms: put back the previous frontend dist (static files, no restart needed).
set "C=D:\TAS\cc-host\node_modules\@cloudcli-ai\cloudcli"
if not exist "%C%\dist.bak-20261031vad\index.html" (echo no backup & exit /b 1)
ren "%C%\dist" dist.bad-20261031vad
ren "%C%\dist.bak-20261031vad" dist
echo rolled back
