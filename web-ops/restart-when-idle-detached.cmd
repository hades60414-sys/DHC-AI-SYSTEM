@echo off
REM Starts restart-when-idle.cmd from Task Scheduler, so the CloudCLI restart does not kill it (or the DHC CLI chat
REM that started it). Same one-shot task pattern as deploy-nightqueue-detached.cmd: created, run at once, deleted
REM (the run keeps going). Watch %USERPROFILE%\cc-web\restart-when-idle.log
schtasks /Create /TN CC-RestartWhenIdle-Once /TR "\"%USERPROFILE%\cc-web\restart-when-idle.cmd\"" /SC ONCE /ST 23:59 /F >nul
schtasks /Run /TN CC-RestartWhenIdle-Once >nul
ping -n 4 127.0.0.1 >nul
schtasks /Delete /TN CC-RestartWhenIdle-Once /F >nul
echo [OK] waiting for CloudCLI to go idle, then it restarts. Log: %USERPROFILE%\cc-web\restart-when-idle.log
