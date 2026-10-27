@echo off
rem doc-scan: read-only inventory of document files (path, size, modified time).
rem Never opens file contents. Writes only to .\scan_out_<COMPUTERNAME>\.
rem Usage: doc-scan.cmd                  (all drives C-Z, skipping system folders)
rem        doc-scan.cmd "D:\" "\\srv\share\dept"
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

set "OUT=%~dp0scan_out_%COMPUTERNAME%"
if not exist "%OUT%" mkdir "%OUT%"
set "RAW=%OUT%\raw.tmp"
set "FILES=%OUT%\files.tsv"
set "DIRS=%OUT%\folders.tsv"
set "EXTS=.doc .docx .pdf .txt .md .rtf .xls .xlsx .xlsm .csv .ppt .pptx .htm .html .msg"
type nul > "%RAW%"

if "%~1"=="" (
  for %%D in (C D E F G H I J K L M N O P Q R S T U V W X Y Z) do if exist "%%D:\" call :scanroot "%%D:\"
) else (
  for %%R in (%*) do call :scanroot "%%~R"
)

echo [filter] removing AppData / temp paths
> "%FILES%" echo path	size_bytes	modified
findstr /v /i /l /c:"\\AppData\\" /c:"\\Temp\\" /c:"\\$Recycle.Bin\\" < "%RAW%" >> "%FILES%"
del "%RAW%"

echo [summary] counting documents per folder
> "%DIRS%" echo folder	doc_count
set "PREV="
set /a N=0
for /f "usebackq skip=1 tokens=1 delims=	" %%P in ("%FILES%") do call :count "%%~dpP"
call :flush

for /f %%C in ('find /c /v "" ^< "%FILES%"') do set /a NF=%%C-1
for /f %%C in ('find /c /v "" ^< "%DIRS%"') do set /a ND=%%C-1
echo.
echo Done. %NF% files in %ND% folders.
echo   %FILES%
echo   %DIRS%
echo Review both files before sharing them with any cloud model.
endlocal
goto :eof

:scanroot
rem Drive root: skip system folders at the top level. Other paths: scan as-is.
set "ROOT=%~1"
if not "%ROOT:~-1%"=="\" set "ROOT=%ROOT%\"
if not "%ROOT:~1%"==":\" (
  call :scan "%ROOT%"
  goto :eof
)
echo [scan] "%ROOT%" (top level)
for %%F in ("%ROOT%*") do for %%E in (%EXTS%) do if /i "%%~xF"=="%%E" >>"%RAW%" echo %%~fF	%%~zF	%%~tF
for /d %%T in ("%ROOT%*") do (
  if /i not "%%~nxT"=="Windows" if /i not "%%~nxT"=="Program Files" if /i not "%%~nxT"=="Program Files (x86)" if /i not "%%~nxT"=="ProgramData" if /i not "%%~nxT"=="$Recycle.Bin" if /i not "%%~nxT"=="System Volume Information" if /i not "%%~nxT"=="Recovery" if /i not "%%~nxT"=="PerfLogs" call :scan "%%~fT"
)
goto :eof

:scan
echo [scan] "%~1"
for /r "%~1" %%F in (*) do for %%E in (%EXTS%) do if /i "%%~xF"=="%%E" >>"%RAW%" echo %%~fF	%%~zF	%%~tF
goto :eof

:count
if /i "%~1"=="%PREV%" (
  set /a N+=1
  goto :eof
)
call :flush
set "PREV=%~1"
set /a N=1
goto :eof

:flush
if not defined PREV goto :eof
setlocal EnableDelayedExpansion
>>"%DIRS%" echo !PREV!	!N!
endlocal
goto :eof
