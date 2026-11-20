@echo off
REM ============================================================
REM  Start the web admin at login (auto-start).
REM  Run this once.
REM
REM  NOTE: keep this file pure ASCII + CRLF.
REM ============================================================
setlocal
cd /d "%~dp0.."

set "TASKNAME=TeleAgent Proxy V4"

set "NODE="
where node >nul 2>nul && set "NODE=node"
if "%NODE%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if "%NODE%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if "%NODE%"=="" goto :nonode

for /f "delims=" %%i in ('where node 2^>nul') do (
  set "NODEABS=%%i"
  goto :gotnode
)
:gotnode
if "%NODEABS%"=="" set "NODEABS=%NODE%"

echo Task  : %TASKNAME%
echo Node  : %NODEABS%
echo.

schtasks /Delete /TN "%TASKNAME%" /F >nul 2>nul
schtasks /Create /TN "%TASKNAME%" /TR "\"%NODEABS%\" \"%~dp0..\bin\tav3.js\" --no-open" /SC ONLOGON /RL LIMITED /F

if errorlevel 1 (
  echo.
  echo   [X] Failed to create the task.
  echo       You can still start it manually: scripts\start.cmd
  timeout /t 10 >nul
  exit /b 1
)

echo.
echo   [OK] Created. It will start automatically at login.
echo        Start now : schtasks /Run /TN "%TASKNAME%"
echo        Stop      : schtasks /End /TN "%TASKNAME%"
echo        Remove    : schtasks /Delete /TN "%TASKNAME%" /F
echo.
timeout /t 15 >nul
endlocal
goto :eof

:nonode
echo   [X] Node.js not found.
timeout /t 10 >nul
exit /b 1
