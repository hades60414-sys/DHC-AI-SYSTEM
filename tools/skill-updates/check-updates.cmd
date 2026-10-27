@echo off
REM Weekly third-party skill/plugin update check (2026-10-25). Posts to the assistant DM; never installs.
"D:\TAS\node\node.exe" "D:\TAS\ai-tools\skill-updates\check-updates.cjs" %* >> "D:\TAS\ai-tools\skill-updates\check-updates.out.log" 2>&1
