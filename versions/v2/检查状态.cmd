@echo off
REM ============================================================
REM  Status check.  Double-click this file.
REM
REM  NOTE: keep this file pure ASCII + CRLF.
REM ============================================================
setlocal
cd /d "%~dp0"

set "NODE="
where node >nul 2>nul && set "NODE=node"
if "%NODE%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if "%NODE%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if "%NODE%"=="" goto :nonode

"%NODE%" "%~dp0bin\tav2.js" accounts
"%NODE%" "%~dp0bin\tav2.js" doctor

echo.
timeout /t 3 >nul
endlocal
goto :eof

:nonode
echo.
echo   [X] Node.js not found.
echo       Install Node.js 18+ from https://nodejs.org
echo.
timeout /t 3 >nul
exit /b 1
