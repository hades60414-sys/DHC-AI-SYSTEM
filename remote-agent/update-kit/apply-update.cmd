@echo off
rem srv-db remote update (v3.4, 2026-10-02). Started by the agent after a signed self-update job; the kit was hash-checked and
rem staged next to this file. Waits for the agent to exit, keeps the current agent as dbclone-agent-v1.previous.exe,
rem installs the kit's dbclone-agent-v1.exe, starts the agent and checks that it is still running and has written its first
rem heartbeat after WAIT seconds; otherwise it restores the previous agent. Models, journal, pairing and the *.txt settings
rem are not touched. The watchdog keeps running: it restarts the agent only after 2 misses 60 s apart, so it cannot start
rem the old agent during the swap, and if this script dies half-way it starts whatever agent is in place.
rem AU_* variables are for local tests only.
setlocal
set "AG=C:\dbclone\dhc-agent-v1"
set "EXE=dbclone-agent-v1.exe"
set "WAIT=30"
if defined AU_AG set "AG=%AU_AG%"
if defined AU_EXE set "EXE=%AU_EXE%"
if defined AU_WAIT set "WAIT=%AU_WAIT%"
set "SYS=%SystemRoot%\System32"
set "KIT=%~dp0"
rem Leave the staging folder: the agent started below inherits this directory and would lock it.
cd /d "%AG%"
if not exist "%AG%\update\" mkdir "%AG%\update"
set "LOG=%AG%\update\apply-%RANDOM%%RANDOM%.log"
>>"%LOG%" echo ==== %DATE% %TIME% apply start from %KIT%
set /a n=0
:wait
"%SYS%\tasklist.exe" /FI "IMAGENAME eq %EXE%" /NH 2>nul | "%SYS%\findstr.exe" /I /C:"%EXE%" >nul || goto gone
set /a n+=1
if %n% geq 90 (>>"%LOG%" echo agent still running after 90 s - update not applied & exit /b 1)
"%SYS%\PING.EXE" -n 2 127.0.0.1 >nul
goto wait
:gone
if not exist "%KIT%dbclone-agent-v1.exe" (>>"%LOG%" echo kit has no dbclone-agent-v1.exe - nothing changed & goto start_old)
copy /y "%AG%\%EXE%" "%AG%\dbclone-agent-v1.previous.exe" >nul || (>>"%LOG%" echo could not keep the current agent - update not applied & goto start_old)
copy /y "%KIT%dbclone-agent-v1.exe" "%AG%\%EXE%" >nul || (>>"%LOG%" echo could not install the new agent & goto restore)
del /q "%AG%\heartbeat.cms.b64.txt" >nul 2>nul
start "RAGENT agent" /min cmd /c "%AG%\start-agent.cmd"
"%SYS%\PING.EXE" -n %WAIT% 127.0.0.1 >nul
"%SYS%\tasklist.exe" /FI "IMAGENAME eq %EXE%" /NH 2>nul | "%SYS%\findstr.exe" /I /C:"%EXE%" >nul || (>>"%LOG%" echo new agent did not stay up & goto restore)
if not exist "%AG%\heartbeat.cms.b64.txt" (>>"%LOG%" echo new agent wrote no heartbeat & goto stop_new)
>>"%LOG%" echo ==== %DATE% %TIME% apply OK
exit /b 0
:stop_new
"%SYS%\taskkill.exe" /im "%EXE%" /f >nul 2>nul
"%SYS%\PING.EXE" -n 3 127.0.0.1 >nul
:restore
>>"%LOG%" echo restoring previous agent
copy /y "%AG%\dbclone-agent-v1.previous.exe" "%AG%\%EXE%" >nul || >>"%LOG%" echo restore copy FAILED
:start_old
start "RAGENT agent" /min cmd /c "%AG%\start-agent.cmd"
>>"%LOG%" echo ==== %DATE% %TIME% apply ROLLED BACK
exit /b 1
