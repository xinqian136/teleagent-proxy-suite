@echo off
REM ============================================================
REM  Export accounts to a package you can copy to another PC.
REM  Double-click this file.
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

REM ---- scan first so the package is fresh ----
"%NODE%" "%~dp0bin\tav2.js" scan >nul 2>&1

"%NODE%" "%~dp0bin\tav2.js" export --format bundle --out "%~dp0account.bundle"

echo.
echo   Package created:  %~dp0account.bundle
echo.
echo   Copy it to the other PC together with this whole folder.
echo   IMPORTANT: this file works like a password. Do not share it.
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
