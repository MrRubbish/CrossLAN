@echo off
setlocal

set "BUILD_ARG="
if not exist "%~dp0..\..\client\dist\index.html" set "BUILD_ARG=-Build"

powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-local-background.ps1" %BUILD_ARG% %*
set "EXIT_CODE=%ERRORLEVEL%"
exit /b %EXIT_CODE%
