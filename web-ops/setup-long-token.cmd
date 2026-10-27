@echo off
REM Make a one-year Claude token for DHC CLI conversations and save it where start-cc-web.cmd reads it. 2026-10-12.
REM Run on this machine (a browser opens). Takes effect after CloudCLI restarts: restart-when-idle-detached.cmd.
REM The 30-day login (cc-hosts\claude-relogin.cmd) is still what the sidebar usage numbers use.
set "CLAUDE=D:\TAS\cc-host\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
set "OUT=D:\TAS\cc-web\claude-token.txt"
"%CLAUDE%" setup-token
echo.
set "TOK="
set /p "TOK=Paste the token shown above (starts with sk-ant-oat) and press Enter: "
if not defined TOK (echo [ERROR] nothing pasted, nothing saved & pause & exit /b 1)
if /i not "%TOK:~0,10%"=="sk-ant-oat" (echo [ERROR] that does not look like the token, nothing saved & pause & exit /b 1)
>"%OUT%" (echo %TOK%)
echo [OK] saved to %OUT%
pause
