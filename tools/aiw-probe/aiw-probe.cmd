@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem aiw-probe: a sandbox under the intranet web root for checking test pages, then deleting them.
rem Every rule lives here, so a caller cannot delete outside the sandbox. See README.txt (copied into the sandbox).
rem No scheduled task: each "new" sweeps leftovers older than a day, and a test .php stops working after 30 minutes.
rem Server moved or new IP: change WEBROOT and BASEURL below. Nothing else needs to change.
set "WEBROOT=\\10.255.0.10\htdocs"
set "BASEURL=http://10.255.0.10"
rem For a dry run on another machine only.
if defined AIW_WEBROOT set "WEBROOT=%AIW_WEBROOT%"
if defined AIW_BASEURL set "BASEURL=%AIW_BASEURL%"
set "BOX=%WEBROOT%\_aiw_probe"
set "BOXURL=%BASEURL%/_aiw_probe"
set "HERE=%~dp0"

if not exist "%WEBROOT%\" (
  echo RESULT=NO_WEBROOT %WEBROOT%
  echo Web root not found. If the server moved, edit WEBROOT and BASEURL at the top of %~f0
  exit /b 2
)

if /i "%~1"=="new" goto new
if /i "%~1"=="put" goto put
if /i "%~1"=="check" goto check
if /i "%~1"=="del" goto del
if /i "%~1"=="sweep" goto sweep
if /i "%~1"=="status" goto status
echo usage: aiw-probe new ^| put ID URL NAME ^| check ID NAME ^| del ID ^| sweep ^| status
exit /b 1

:new
if not exist "%BOX%\" mkdir "%BOX%"
if not exist "%BOX%\" (echo RESULT=FAIL cannot create %BOX% & exit /b 1)
if not exist "%BOX%\README.txt" copy /y "%HERE%README.txt" "%BOX%\README.txt" >nul
call :sweep_all
set "ID=aiw%RANDOM%%RANDOM%%RANDOM%"
mkdir "%BOX%\%ID%"
>"%BOX%\%ID%\.aiw_owned" echo %ID%
call :checkid >nul
if errorlevel 1 (
  rd /s /q "%BOX%\%ID%" 2>nul
  echo RESULT=FAIL marker not written
  exit /b 1
)
echo RESULT=OK ID=%ID% URL=%BOXURL%/%ID%/
exit /b 0

:put
set "ID=%~2"
set "URL=%~3"
set "NAME=%~4"
call :checkid || exit /b 1
echo(%NAME%| findstr /r /x "[A-Za-z0-9_-][A-Za-z0-9._-]*" >nul || (echo RESULT=BAD_NAME & exit /b 1)
echo(%NAME%| findstr /c:".." >nul && (echo RESULT=BAD_NAME & exit /b 1)
set "EXTOK="
for %%E in (.php .html .htm .css .js .json .png .jpg .svg .txt .csv) do if /i "%~x4"=="%%E" set "EXTOK=1"
if not defined EXTOK (echo RESULT=BAD_EXT & exit /b 1)
curl.exe -s -f -o "%BOX%\%ID%\%NAME%" "%URL%"
if not exist "%BOX%\%ID%\%NAME%" (echo RESULT=FAIL download & exit /b 1)
if /i not "%~x4"==".php" goto put_done
rem A test .php must start with the guard from guard-template.php, so a leftover page stops working by itself.
findstr /n /c:"/*aiw-guard*/" "%BOX%\%ID%\%NAME%" | findstr /b "1:" >nul
if errorlevel 1 (
  del /q "%BOX%\%ID%\%NAME%"
  echo RESULT=NO_GUARD file removed
  exit /b 1
)
:put_done
for %%F in ("%BOX%\%ID%\%NAME%") do echo RESULT=OK %%~zF bytes URL=%BOXURL%/%ID%/%NAME%
exit /b 0

:check
set "ID=%~2"
set "NAME=%~3"
call :checkid || exit /b 1
curl.exe -s -o "%TEMP%\aiw-check.out" -w "HTTP=%%{http_code}\n" "%BOXURL%/%ID%/%NAME%"
type "%TEMP%\aiw-check.out"
exit /b 0

:del
set "ID=%~2"
call :checkid || exit /b 1
call :remove_run
if errorlevel 1 (
  echo RESULT=LEFTOVER %BOX%\%ID%
  echo Could not delete. Any .php inside stops working 30 minutes after upload; the next "new" retries after a day.
  exit /b 3
)
set "CODE="
for /f %%C in ('curl.exe -s -o nul -w "%%{http_code}" "%BOXURL%/%ID%/"') do set "CODE=%%C"
echo RESULT=DELETED HTTP=%CODE%
exit /b 0

:sweep
call :sweep_all
echo RESULT=SWEPT
exit /b 0

:status
if not exist "%BOX%\" (echo RESULT=NO_SANDBOX & exit /b 0)
dir /b /ad "%BOX%"
echo RESULT=OK
exit /b 0

rem Deletes run folders that are ours (name and marker match) and last changed before today.
:sweep_all
if not exist "%BOX%\" exit /b 0
for /d %%D in ("%BOX%\aiw*") do call :sweep_one "%%~nxD"
exit /b 0

:sweep_one
set "ID=%~1"
call :checkid >nul || exit /b 0
forfiles /p "%BOX%" /m "%ID%" /d -1 >nul 2>&1 || exit /b 0
call :remove_run
exit /b 0

rem The marker goes last: if a file is locked or denied, the folder keeps its marker and a later run can retry.
:remove_run
for /d %%S in ("%BOX%\%ID%\*") do rd /s /q "%%S" 2>nul
for %%F in ("%BOX%\%ID%\*") do if /i not "%%~nxF"==".aiw_owned" del /f /q "%%F" 2>nul
for /d %%S in ("%BOX%\%ID%\*") do exit /b 1
for %%F in ("%BOX%\%ID%\*") do if /i not "%%~nxF"==".aiw_owned" exit /b 1
rd /s /q "%BOX%\%ID%" 2>nul
if exist "%BOX%\%ID%\" exit /b 1
exit /b 0

rem ID must look like aiw<digits> and its folder must hold a marker naming it; nothing else is ever touched.
:checkid
echo(%ID%| findstr /r /x "aiw[0-9][0-9]*" >nul || (echo RESULT=BAD_ID & exit /b 1)
if not exist "%BOX%\%ID%\.aiw_owned" (echo RESULT=NOT_OURS & exit /b 1)
set "MARK="
set /p MARK=<"%BOX%\%ID%\.aiw_owned"
if not "%MARK%"=="%ID%" (echo RESULT=NOT_OURS & exit /b 1)
exit /b 0
