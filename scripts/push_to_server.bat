@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push_to_server.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
