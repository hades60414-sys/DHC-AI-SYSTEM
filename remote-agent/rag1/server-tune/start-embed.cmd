@echo off
setlocal
cd /d "%~dp0" || exit /b 1
if "%DOCQA_THREADS%"=="" set "DOCQA_THREADS=8"
if "%DOCQA_THREADS_BATCH%"=="" set "DOCQA_THREADS_BATCH=12"
if not exist "Qwen3-Embedding-0.6B-Q8_0.gguf" (echo STOP: run install-rag1.cmd first. & pause & exit /b 1)
echo doc-qa embedding server at 127.0.0.1:8088. Keep this window open.
"runtime\llama-server.exe" --model "Qwen3-Embedding-0.6B-Q8_0.gguf" --port 8088 --embeddings --pooling last --ctx-size 2048 --batch-size 512 --ubatch-size 512 --parallel 1 --threads %DOCQA_THREADS% --threads-batch %DOCQA_THREADS_BATCH% --host 127.0.0.1 --n-gpu-layers 0 --offline --no-webui
exit /b %errorlevel%
