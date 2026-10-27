@echo off
REM Turns the de-identification proxy ON for DHC CLI: writes ANTHROPIC_BASE_URL into CloudCLI's .env, restarts
REM CloudCLI (running chats are aborted), then runs a real chat turn as a self-check (deid-proxy\smoke.cjs).
REM If the self-check fails twice, it removes the .env and restarts again, so DHC CLI is back to how it was.
REM Log: D:\TAS\cc-web\deid-proxy\cutover.log      Turn it off by hand: deid-off.cmd
setlocal
set "D=D:\TAS\cc-web\deid-proxy"
set "ENVF=D:\TAS\cc-host\node_modules\@cloudcli-ai\cloudcli\.env"
set "NODE=D:\TAS\node\node.exe"
set "LOG=%D%\cutover.log"
echo ==== %date% %time% cutover start>> "%LOG%"
call "D:\TAS\cc-web\start-deid-proxy-detached.cmd" >> "%LOG%" 2>&1
if errorlevel 1 goto abort_proxy
if exist "%ENVF%" goto abort_env
echo ANTHROPIC_BASE_URL=http://127.0.0.1:3003> "%ENVF%"
call "D:\TAS\cc-web\restart-cloudcli.cmd" >> "%LOG%" 2>&1
"%NODE%" "%D%\smoke.cjs" http://127.0.0.1:3001 >> "%LOG%" 2>&1
if not errorlevel 1 goto ok
echo [RETRY] self-check failed once, trying again>> "%LOG%"
"%NODE%" "%D%\smoke.cjs" http://127.0.0.1:3001 >> "%LOG%" 2>&1
if not errorlevel 1 goto ok
echo [ROLLBACK] self-check failed twice, removing .env and restarting>> "%LOG%"
del "%ENVF%"
call "D:\TAS\cc-web\restart-cloudcli.cmd" >> "%LOG%" 2>&1
echo ==== %date% %time% RESULT: ROLLED BACK, de-identification is OFF>> "%LOG%"
exit /b 1
:ok
echo ==== %date% %time% RESULT: ON, self-check passed>> "%LOG%"
exit /b 0
:abort_proxy
echo ==== %date% %time% RESULT: ABORTED, proxy not running, nothing changed>> "%LOG%"
exit /b 1
:abort_env
echo ==== %date% %time% RESULT: ABORTED, .env already exists, nothing changed>> "%LOG%"
exit /b 1
