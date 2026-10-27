@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0health-check.ps1"
"D:\TAS\node\node.exe" "D:\TAS\cc-web\auto-resume.cjs" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0orphan-sweep.ps1"
