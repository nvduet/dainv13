@echo off
if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%APPDATA%\npm\wrangler.cmd" set "PATH=%APPDATA%\npm;%PATH%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0change_pass.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
