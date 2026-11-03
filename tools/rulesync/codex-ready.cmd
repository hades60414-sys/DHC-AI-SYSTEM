@echo off
REM Make a project readable by both Claude Code and Codex: CLAUDE.md + .claude\skills -> AGENTS.md + .agents\skills.
REM   codex-ready.cmd <project folder> [--dry-run]
REM First run imports from the Claude files into .rulesync\ (the source from then on); later runs only regenerate.
REM Never uses rulesync init or --delete (see README.md).
chcp 65001 >nul
setlocal
set "RS=D:\TAS\ai-tools\rulesync\node_modules\.bin\rulesync.cmd"
if "%~1"=="" (echo usage: codex-ready.cmd ^<project folder^> [--dry-run] & exit /b 2)
cd /d "%~1" || exit /b 2
if not exist ".rulesync\" (
  call "%RS%" import --targets claudecode --features rules,skills || exit /b 1
)
call "%RS%" generate --targets claudecode,codexcli --features rules,skills %2
