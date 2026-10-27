@echo off
setlocal
cd /d "C:\dbclone\local-ai" || exit /b 1
echo [1/3] Local Gemma health
curl.exe --noproxy "*" -fS --connect-timeout 5 --max-time 10 http://127.0.0.1:8087/health || goto fail
echo.
echo [2/3] Fresh inference
curl.exe --noproxy "*" -fS --connect-timeout 5 --max-time 180 -H "Content-Type: application/json" --data-binary "@smoke-request.json" http://127.0.0.1:8087/v1/chat/completions -o dhc-handshake-model.json || goto fail
findstr /c:"GEMMA_READY" dhc-handshake-model.json >nul || goto fail
echo DHC_GEMMA_HANDSHAKE_V1_7d4e930a>dhc-handshake.txt
hostname >>dhc-handshake.txt
type dhc-handshake-model.json >>dhc-handshake.txt
echo [3/3] Return test result through DHC
curl.exe --ssl-revoke-best-effort -fS --connect-timeout 20 --max-time 60 -F "files=@dhc-handshake.txt;filename=demo-gemma-handshake-v1.txt;type=text/plain" https://tas-ui.example.workers.dev/api/assets/files -o dhc-handshake-receipt.json || goto fail
echo.
type dhc-handshake-receipt.json
echo.
echo UPLOAD COMPLETE. Ask the outer agent to verify receipt from demo.
echo No database commands executed. Job dispatch is not enabled yet.
exit /b 0
:fail
echo BREAK: handshake failed. Send the exact error; do not continue to database work.
exit /b 1
