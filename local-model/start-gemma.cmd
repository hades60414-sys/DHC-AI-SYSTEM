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
echo Starting local CPU inference at 127.0.0.1:8087. Keep this window open.
echo No SQL commands or remote-control bridge are enabled by this package.
"runtime\llama-server.exe" --model "gemma-4-E4B_q4_0-it.gguf" --alias gemma-local --host 127.0.0.1 --port 8087 --ctx-size 4096 --parallel 1 --threads 4 --threads-batch 4 --n-gpu-layers 0 --offline --jinja --reasoning-budget 0 --no-agent --no-webui --no-ui-mcp-proxy --cors-origins localhost
exit /b %errorlevel%
