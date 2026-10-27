@echo off
rem One command: scan document folders, let you review the list, then Codex
rem classifies folders.tsv into manifest.md. Codex reads only the folder list.
rem Usage: auto-manifest.cmd                (all drives)
rem        auto-manifest.cmd "\\srv\share"  (specific paths)
setlocal EnableExtensions
set "PATH=%USERPROFILE%\codex-cli;%PATH%"
where codex >nul 2>nul || (echo codex not found. Run install-codex.cmd first. & exit /b 1)

call "%~dp0doc-scan.cmd" %*
set "OUT=%~dp0scan_out_%COMPUTERNAME%"
if not exist "%OUT%\folders.tsv" (echo folders.tsv missing. & exit /b 1)

echo.
echo === REVIEW ===
echo Notepad will open folders.tsv. This list (folder paths + counts) WILL be
echo sent to OpenAI. Delete any line with customer names, accounts or personal
echo data, save, then close Notepad to continue. Press Ctrl+C here to abort.
call notepad "%OUT%\folders.tsv"

copy /y "%~dp0codex-task\AGENTS.md" "%OUT%\AGENTS.md" >nul
echo [codex] classifying folders (read-only sandbox)...
codex exec -C "%OUT%" -s read-only --skip-git-repo-check --ephemeral -o "%OUT%\manifest.md" "Follow the instructions in AGENTS.md in the current directory."
if errorlevel 1 (echo codex failed. Check login: codex login status & exit /b 1)
echo.
echo Done: %OUT%\manifest.md
call notepad "%OUT%\manifest.md"
endlocal
