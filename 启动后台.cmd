@echo off
REM ============================================================
REM  Start the web admin panel.
REM  Double-click this file. A browser opens automatically.
REM  Requires: Node.js 18+
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

REM ---- if the auto-start task exists, use it (runs detached in background) ----
schtasks /Query /TN "TeleAgent Proxy V4" >nul 2>&1
if not errorlevel 1 (
  schtasks /Run /TN "TeleAgent Proxy V4" >nul 2>&1
  echo.
  echo   Started via the auto-start task.
  echo   Open: http://127.0.0.1:8796/
  echo.
  start "" "http://127.0.0.1:8796/"
  endlocal
  goto :eof
)

REM ---- otherwise run it in this window ----
"%NODE%" "%~dp0bin\tav3.js" %*
goto :done

:nonode
echo.
echo   [X] Node.js not found.
echo.
echo   Please install Node.js 18 or newer:  https://nodejs.org
echo   (or download the portable zip and put node.exe next to this file)
echo.
exit /b 1

:done
if errorlevel 1 (
  echo.
  echo   [X] Failed to start.
  echo.
)
endlocal
