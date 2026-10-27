@echo off
rem RAG1 server tuning (2026-10-01): more threads for reading (embedding, rerank, chat prompt) and a capped
rem prompt cache for the chat model. Answers and retrieval are unchanged. Copies the three start scripts and restarts.
set "R=%USERPROFILE%\rag1-rag"
if not exist "%R%\local-ai\runtime\llama-server.exe" (echo STOP: rag1-rag is not installed on this PC. & exit /b 1)
for %%F in (start-qwen.cmd start-embed.cmd start-rerank.cmd) do if not exist "%~dp0%%F" (echo STOP: %%F missing; extract the whole kit first. & exit /b 1)
for %%F in (start-qwen.cmd start-embed.cmd start-rerank.cmd) do copy /y "%~dp0%%F" "%R%\local-ai\" >nul || (echo STOP: could not copy %%F & exit /b 1)
echo Start scripts updated. Restarting models and agent...
call "%R%\stop-all.cmd"
call "%R%\start-all.cmd"
echo UPDATE DONE.
