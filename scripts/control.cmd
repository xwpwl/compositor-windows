@echo off
setlocal
set "COMPOSITOR_RUNTIME=%~dp0..\Compositor Windows.exe"
if exist "%COMPOSITOR_RUNTIME%" goto electron
set "COMPOSITOR_RUNTIME=%~dp0..\release\win-unpacked\Compositor Windows.exe"
if exist "%COMPOSITOR_RUNTIME%" goto electron
set "COMPOSITOR_RUNTIME=%~dp0..\node_modules\electron\dist\electron.exe"
if exist "%COMPOSITOR_RUNTIME%" goto electron
where node.exe >nul 2>&1
if errorlevel 1 goto missing
node.exe "%~dp0control.mjs" %*
exit /b %ERRORLEVEL%
:electron
set "ELECTRON_RUN_AS_NODE=1"
"%COMPOSITOR_RUNTIME%" "%~dp0control.mjs" %*
exit /b %ERRORLEVEL%
:missing
echo Compositor runtime was not found. Keep scripts beside Compositor Windows.exe, or install Node.js. 1>&2
exit /b 1
