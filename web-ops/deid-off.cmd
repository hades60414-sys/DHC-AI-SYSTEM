@echo off
REM Turns the de-identification proxy OFF for DHC CLI: removes CloudCLI's .env and restarts CloudCLI
REM (running chats are aborted). The proxy process itself keeps running and is simply no longer used.
set "ENVF=D:\TAS\cc-host\node_modules\@cloudcli-ai\cloudcli\.env"
if not exist "%ENVF%" (echo [OK] already off, nothing to do & exit /b 0)
del "%ENVF%"
call "D:\TAS\cc-web\restart-cloudcli.cmd"
echo ==== %date% %time% turned OFF by deid-off.cmd>> "D:\TAS\cc-web\deid-proxy\cutover.log"
