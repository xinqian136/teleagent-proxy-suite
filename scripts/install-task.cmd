@echo off
REM tav2 install-task   Windows 
REM
REM : scripts\install-task.cmd
REM   WorkBuddy 

setlocal
cd /d "%~dp0.."

set "TASKNAME=TeleAgent Proxy V2"

REM ----  node ----
set "NODE="
where node >nul 2>nul && set "NODE=node"
if "%NODE%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if "%NODE%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if "%NODE%"=="" (
  echo [X]  Node.js
  pause
  exit /b 1
)

REM node  "node" PATH
for /f "delims=" %%i in ('where node 2^>nul') do (
  set "NODEABS=%%i"
  goto :gotnode
)
:gotnode
if "%NODEABS%"=="" set "NODEABS=%NODE%"

echo   : %TASKNAME%
echo Node   : %NODEABS%
echo    : %NODEABS% "%~dp0..\bin\tav2.js" serve
echo.

schtasks /Delete /TN "%TASKNAME%" /F >nul 2>nul
schtasks /Create /TN "%TASKNAME%" /TR "\"%NODEABS%\" \"%~dp0..\bin\tav2.js\" serve" /SC ONLOGON /RL LIMITED /F

if errorlevel 1 (
  echo.
  echo [X] scripts\start.cmd serve
  pause
  exit /b 1
)

echo.
echo [OK] 
echo     : schtasks /Run /TN "%TASKNAME%"
echo         : schtasks /End /TN "%TASKNAME%"
echo         : schtasks /Delete /TN "%TASKNAME%" /F
echo.
pause
endlocal
