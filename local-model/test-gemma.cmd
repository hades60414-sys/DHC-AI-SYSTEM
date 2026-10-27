@echo off
setlocal
cd /d "%~dp0" || exit /b 1
echo [1/2] Local health
curl.exe --noproxy "*" -fS --connect-timeout 5 --max-time 10 http://127.0.0.1:8087/health || exit /b 1
echo.
echo [2/2] Inference - allow up to 180 seconds on CPU
curl.exe --noproxy "*" -fS --connect-timeout 5 --max-time 180 -H "Content-Type: application/json" --data-binary "@smoke-request.json" http://127.0.0.1:8087/v1/chat/completions -o smoke-response.json || exit /b 1
type smoke-response.json
echo.
findstr /c:"GEMMA_READY" smoke-response.json >nul || (echo BREAK: expected response missing & exit /b 1)
echo PASS: local model responded. DHC command bridge still pending.
exit /b 0
