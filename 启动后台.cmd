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

"%NODE%" "%~dp0bin\tav3.js" %*
goto :done

:nonode
echo.
echo   [X] Node.js not found.
echo.
echo   Please install Node.js 18 or newer:  https://nodejs.org
echo   (or download the portable zip and put node.exe next to this file)
echo.
timeout /t 10 >nul
exit /b 1

:done
if errorlevel 1 (
  echo.
  echo   [X] Failed to start.
  echo.
  timeout /t 10 >nul
)
endlocal
