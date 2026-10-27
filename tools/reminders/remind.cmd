@echo off
REM One-shot reminder poster (2026-10-25). Usage: remind.cmd <reminder.json>
"D:\TAS\node\node.exe" "D:\TAS\ai-tools\reminders\remind.cjs" %* >> "D:\TAS\ai-tools\reminders\remind.log" 2>&1
