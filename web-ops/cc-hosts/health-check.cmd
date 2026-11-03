@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0health-check.ps1"
"D:\TAS\node\node.exe" "D:\TAS\ai-tools\agy\gemini-takeover.cjs" >nul 2>&1
"D:\TAS\node\node.exe" "D:\TAS\cc-web\auto-resume.cjs" >nul 2>&1
if exist "D:\TAS\cc-web\drain.json" "D:\TAS\node\node.exe" "D:\TAS\cc-web\drain.cjs" tick >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0orphan-sweep.ps1"
