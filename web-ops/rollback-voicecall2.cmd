@echo off
REM Undo deploy-voicecall2.cmd: put back dist and the websocket service, drop the command-mode module, then restart (tas-restart-fast.cmd).
chcp 65001 >nul
set "C=D:\TAS\cc-host\node_modules\@cloudcli-ai\cloudcli"
if not exist "%C%\dist.bak-20261030vc2\index.html" (echo no backup & exit /b 1)
ren "%C%\dist" dist.bad-20261030vc2
ren "%C%\dist.bak-20261030vc2" dist
set "W=%C%\dist-server\server\modules\websocket\services\chat-websocket.service.js"
copy /y "%W%.bak-20261030vc2" "%W%" >nul
rmdir /s /q "%C%\dist-server\server\modules\command-mode"
echo rolled back files; now run D:\TAS\cc-web\tas-restart-fast.cmd from a one-off scheduled task
