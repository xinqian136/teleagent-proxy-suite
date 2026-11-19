@echo off
REM ============================================================
REM  Start the proxy.  Double-click this file.
REM  Requires: Node.js 18+   (https://nodejs.org)
REM
REM  NOTE: keep this file pure ASCII + CRLF. cmd.exe reads it as
REM        ANSI/GBK and will choke on UTF-8 Chinese text.
REM ============================================================
setlocal
cd /d "%~dp0"

REM ---- locate node ----
set "NODE="
where node >nul 2>nul && set "NODE=node"
if "%NODE%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if "%NODE%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if "%NODE%"=="" goto :nonode

REM ---- first run: scan local accounts ----
if not exist "data\accounts.vault" (
  echo.
  echo   First run - scanning for TeleAgent accounts...
  echo.
  "%NODE%" "%~dp0bin\tav2.js" scan
)

"%NODE%" "%~dp0bin\tav2.js" serve %*
goto :done

:nonode
echo.
echo   [X] Node.js not found.
echo.
echo   Please install Node.js 18 or newer:  https://nodejs.org
echo   (or download the portable zip and put node.exe next to this file)
echo.
timeout /t 3 >nul
exit /b 1

:done
if errorlevel 1 (
  echo.
  echo   [X] Failed to start.
  echo.
  timeout /t 3 >nul
)
endlocal
