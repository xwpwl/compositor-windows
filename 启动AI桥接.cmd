@echo off
call "%~dp0scripts\connect-mcp.cmd" %*
exit /b %ERRORLEVEL%
