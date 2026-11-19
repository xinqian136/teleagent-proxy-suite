@echo off
REM tav2 install-task — 装成 Windows 计划任务（登录时自动启动）
REM
REM 用法: scripts\install-task.cmd
REM 装完以后：开机登录 → 反代自动起来，WorkBuddy 关了也不影响。

setlocal
cd /d "%~dp0.."

set "TASKNAME=TeleAgent Proxy V2"

REM ---- 找 node ----
set "NODE="
where node >nul 2>nul && set "NODE=node"
if "%NODE%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if "%NODE%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if "%NODE%"=="" (
  echo [X] 找不到 Node.js，无法创建计划任务
  pause
  exit /b 1
)

REM node 可能是 "node"（靠 PATH），计划任务里要用绝对路径
for /f "delims=" %%i in ('where node 2^>nul') do (
  set "NODEABS=%%i"
  goto :gotnode
)
:gotnode
if "%NODEABS%"=="" set "NODEABS=%NODE%"

echo 任务名  : %TASKNAME%
echo Node   : %NODEABS%
echo 命令   : %NODEABS% "%~dp0..\bin\tav2.js" serve
echo.

schtasks /Delete /TN "%TASKNAME%" /F >nul 2>nul
schtasks /Create /TN "%TASKNAME%" /TR "\"%NODEABS%\" \"%~dp0..\bin\tav2.js\" serve" /SC ONLOGON /RL LIMITED /F

if errorlevel 1 (
  echo.
  echo [X] 创建失败。可以改用手动启动：scripts\start.cmd serve
  pause
  exit /b 1
)

echo.
echo [OK] 已创建。开机登录后会自动启动。
echo     立即启动: schtasks /Run /TN "%TASKNAME%"
echo     停止    : schtasks /End /TN "%TASKNAME%"
echo     删除    : schtasks /Delete /TN "%TASKNAME%" /F
echo.
pause
endlocal
