@echo off
chcp 65001 >nul
REM CC Web UI host: CloudCLI on 127.0.0.1:3001 + Cloudflare quick tunnel watchdog publishing to the tasui Worker.
REM Public URL (fixed): https://tas-ui.example.workers.dev   Login = CloudCLI's own account (set on first visit).
title CC Web UI
set "CC_BIN=D:\TAS\cc-host"
set "PATH=%CC_BIN%;D:\TAS\node;%PATH%"
set "DISABLE_AUTOUPDATER=1"
set "MCP_SDK_GENERATION=v1"
REM UTF-8 everywhere so Chinese in tool output is not garbled (matches what the app shows)
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "LANG=zh_TW.UTF-8"
set "HOST=127.0.0.1"
set "SERVER_PORT=3001"
set "PORT=3001"
set "CLAUDE_CLI_PATH=D:\TAS\cc-host\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
REM TAS 2026-10-20: one-year Claude token (claude setup-token), read at start
if exist "C:\Users\demo\.tas\claude-token.txt" set /p CLAUDE_CODE_OAUTH_TOKEN=<"C:\Users\demo\.tas\claude-token.txt"
set "DATABASE_PATH=D:\TAS\cc-web\data\auth.db"
set "NODE_ENV=production"
REM Context-window size used for the context % meter (default model = Opus 5 / Fable 1M context)
set "CONTEXT_WINDOW=1000000"
REM 2026-09-09 user decision: no login at all (same as the backtest platform). Platform mode skips auth on server;
REM the client bundle in cc-host was rebuilt with VITE_IS_PLATFORM=true so the login screen is gone too.
set "VITE_IS_PLATFORM=true"
if not exist "D:\TAS\cc-web\data" mkdir "D:\TAS\cc-web\data"
if not exist "%CC_BIN%\cloudcli.cmd" (echo [ERROR] cloudcli not installed in %CC_BIN% & pause & exit /b 1)
start "cc-web seal-proxy" /min "D:\TAS\node\node.exe" "D:\TAS\cc-web\seal-proxy.js"
:loop
echo [CC Web UI] starting CloudCLI on http://127.0.0.1:%SERVER_PORT%  (public: https://tas-ui.example.workers.dev)
call "%CC_BIN%\cloudcli.cmd" start >> "D:\TAS\cc-web\server.log" 2>&1
echo.
echo [CC Web UI] server exited (%ERRORLEVEL%). Restarting in 5s, Ctrl+C to stop.
timeout /t 5 >nul
REM 2026-10-18: before each relaunch, move server.log aside once it passes 50MB (server.log.1 is overwritten).
if exist "D:\TAS\cc-web\server.log" for %%A in ("D:\TAS\cc-web\server.log") do if %%~zA GTR 52428800 move /y "D:\TAS\cc-web\server.log" "D:\TAS\cc-web\server.log.1" >nul
goto loop
