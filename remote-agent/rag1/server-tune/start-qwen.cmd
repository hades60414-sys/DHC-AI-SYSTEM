@echo off
setlocal
cd /d "%~dp0" || exit /b 1
set "SRC_PWD="
set "DST_PWD="
set "MktData_PWD="
set "SQLCMDPASSWORD="
set "LLAMA_ARG_TOOLS="
set "LLAMA_ARG_MCP_SERVERS_CONFIG="
set "LLAMA_ARG_MCP_SERVERS_JSON="
if "%QWEN_PORT%"=="" set "QWEN_PORT=8087"
if "%QWEN_THREADS%"=="" set "QWEN_THREADS=8"
if "%QWEN_THREADS_BATCH%"=="" set "QWEN_THREADS_BATCH=12"
if not exist "Qwen3.5-4B-Q4_0.gguf" (echo STOP: run install-rag1.cmd first. & pause & exit /b 1)
echo Chat model Qwen3.5-4B at 127.0.0.1:%QWEN_PORT%, %QWEN_THREADS% threads, %QWEN_THREADS_BATCH% for reading. Keep this window open.
rem cache-ram 512 / ctx-checkpoints 4: the defaults (8192 MiB, 32) let this server grow past 4 GB on a 16 GB PC.
"runtime\llama-server.exe" --model "Qwen3.5-4B-Q4_0.gguf" --alias gemma-local --host 127.0.0.1 --port %QWEN_PORT% --ctx-size 8192 --parallel 1 --threads %QWEN_THREADS% --threads-batch %QWEN_THREADS_BATCH% --cache-ram 512 --ctx-checkpoints 4 --n-gpu-layers 0 --offline --jinja --reasoning-budget 0 --chat-template-kwargs "{\"enable_thinking\":false}" --no-agent --no-webui --no-ui-mcp-proxy --cors-origins localhost
exit /b %errorlevel%
