@echo off
rem ============================================================
rem  install-autostart.cmd — 注册开机自启（Windows 计划任务）
rem
rem  开机后自动启动 shim。TeleAgent 需用户登录后手动打开（内核才起），
rem  shim 会在首次请求时自动取 sessionKey。
rem
rem  可选环境变量（在运行本脚本前设置）：
rem    TA_HOST=0.0.0.0
rem    TA_API_KEY=xxx
rem ============================================================
setlocal
cd /d "%~dp0"

set TASKNAME=TeleAgentShim
set NODE=%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe

if not exist "%NODE%" (
  echo [!] 找不到 node: %NODE%
  pause
  exit /b 1
)

if "%TA_HOST%"=="" set TA_HOST=127.0.0.1
if "%TA_API_KEY%"=="" set TA_API_KEY=teleagent-local

echo 注册计划任务 "%TASKNAME%" ...
schtasks /Create /TN "%TASKNAME%" /TR "\"%NODE%\" \"%~dp0ta-shim.js\"" /SC ONLOGON /RL LIMITED /F >nul 2>&1
if errorlevel 1 (
  echo [!] schtasks 创建失败，尝试用 PowerShell 注册 ...
  powershell -NoProfile -Command ^
    "$a=New-ScheduledTaskAction -Execute '%NODE%' -Argument '%~dp0ta-shim.js' -WorkingDirectory '%~dp0'; ^
     $t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; ^
     Register-ScheduledTask -TaskName '%TASKNAME%' -Action $a -Trigger $t -Force | Out-Null"
  if errorlevel 1 (
    echo [!] 注册失败，请以管理员身份运行
    pause
    exit /b 1
  )
)

echo.
echo [OK] 已注册开机自启
echo   任务名 : %TASKNAME%
echo   监听   : %TA_HOST%:8788
echo   API Key: %TA_API_KEY%
echo.
echo 管理命令:
echo   查看状态 : schtasks /Query /TN "%TASKNAME%" /V /FO LIST
echo   立即运行 : schtasks /Run /TN "%TASKNAME%"
echo   停止     : schtasks /End /TN "%TASKNAME%"
echo   卸载     : schtasks /Delete /TN "%TASKNAME%" /F
echo.
pause
