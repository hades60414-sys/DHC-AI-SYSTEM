@echo off
REM Manual run of the 07:00 morning check (Scheduled Task CC-Hosts-MorningCheck). Test: morning-check.cmd -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0morning-check.ps1" %*
