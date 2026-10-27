@echo off
REM Restart every CC host (web UI + Discord hosts) through Task Scheduler so they are NOT children of the Claude app container.
REM 2026-10-19: autostart.vbs now skips loops that are already running, so a restart has to stop them first:
REM CC-Hosts-ForceRestart runs health-check.ps1 -Force (stop everything, then run CC-Hosts-Autostart), detached from the caller.
schtasks /Run /TN CC-Hosts-ForceRestart
echo [OK] CC-Hosts-ForceRestart triggered; give it ~60s, then check https://tas-ui.example.workers.dev/health
