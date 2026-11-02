@echo off
REM TAS-LibraryBuild: daily conversation summary cards (haiku) + folder index. 2026-10-25.
"D:\TAS\node\node.exe" "D:\TAS\jev\library\build.cjs" >> "D:\TAS\jev\library\build-run.log" 2>&1
"D:\TAS\node\node.exe" "D:\TAS\jev\library\index.cjs" >> "D:\TAS\jev\library\build-run.log" 2>&1
