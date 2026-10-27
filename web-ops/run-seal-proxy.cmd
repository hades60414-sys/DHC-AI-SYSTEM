@echo off
REM Launcher for seal-proxy with a log file (used by restart-seal-proxy.cmd via Task Scheduler).
"D:\TAS\node\node.exe" "D:\TAS\cc-web\seal-proxy.js" >> "D:\TAS\cc-web\seal-proxy.log" 2>&1
