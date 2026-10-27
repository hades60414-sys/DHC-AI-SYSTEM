@echo off
rem Convert the PDFs listed in rag-pick.txt to .docx with Word.
rem Sources are opened read-only. Output: .\rag_docx\ plus convert-log.tsv.
rem Usage: pdf2docx.cmd [listfile]
setlocal
set "LIST=%~1"
if "%LIST%"=="" set "LIST=%~dp0rag-pick.txt"
if not exist "%LIST%" (echo list not found: %LIST% & exit /b 1)
set "OUT=%~dp0rag_docx"
cscript //nologo "%~dp0pdf2docx.vbs" "%LIST%" "%OUT%"
echo Output: %OUT%
echo Log:    %OUT%\convert-log.tsv
endlocal
