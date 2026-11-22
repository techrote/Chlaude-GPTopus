@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Evaluate-ULTRA.ps1" %*
exit /b %ERRORLEVEL%
