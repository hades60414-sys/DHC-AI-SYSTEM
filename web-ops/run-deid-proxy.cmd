@echo off
REM Keeps the de-identification proxy (127.0.0.1:3003) running; restarts it a few seconds after any exit.
REM Started hidden at logon by cc-hosts\autostart.vbs, or right now by start-deid-proxy-detached.cmd.
REM While CloudCLI's .env points ANTHROPIC_BASE_URL here, every DHC CLI chat depends on this process.
:loop
"D:\TAS\node\node.exe" "D:\TAS\cc-web\deid-proxy\server.cjs" >> "D:\TAS\cc-web\deid-proxy\proxy.log" 2>&1
ping -n 4 127.0.0.1 >nul
goto loop
