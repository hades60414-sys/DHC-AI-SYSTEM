@echo off
setlocal
cd /d "%~dp0" || exit /b 1
if "%DOCQA_THREADS%"=="" set "DOCQA_THREADS=8"
if "%DOCQA_THREADS_BATCH%"=="" set "DOCQA_THREADS_BATCH=12"
if not exist "qwen3-reranker-0.6b-q8_0.gguf" (echo STOP: run install-rag1.cmd first. & pause & exit /b 1)
echo doc-qa rerank server at 127.0.0.1:8089. Keep this window open.
"runtime\llama-server.exe" --model "qwen3-reranker-0.6b-q8_0.gguf" --port 8089 --reranking --ctx-size 2048 --batch-size 512 --ubatch-size 512 --parallel 1 --threads %DOCQA_THREADS% --threads-batch %DOCQA_THREADS_BATCH% --host 127.0.0.1 --n-gpu-layers 0 --offline --no-webui
exit /b %errorlevel%
