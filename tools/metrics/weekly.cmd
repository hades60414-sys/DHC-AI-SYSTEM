@echo off
rem Weekly decision-load metrics (assent rate + rework rate). Output appended to history.tsv; log in weekly.log.
"D:\TAS\node\node.exe" "D:\TAS\ai-tools\metrics\weekly.cjs" %* >> "D:\TAS\ai-tools\metrics\weekly.log" 2>&1
