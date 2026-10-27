@echo off
REM Sign the DHC CLI host back in to Claude (the login runs out about every 30 days). Run on this machine: a browser opens.
REM The DHC CLI sidebar and morning-check.log warn 7 days ahead. 2026-10-12.
set "CLAUDE=D:\TAS\cc-host\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
"%CLAUDE%" auth login
"%CLAUDE%" auth status
pause
