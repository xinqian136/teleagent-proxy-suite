@echo off
REM TeleAgent shim control menu - double click to use
title TeleAgent Fan Dai Kongzhi Tai
cd /d "%USERPROFILE%\.workbuddy\skills\teleagent-proxy\scripts"
set "NODE=%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe"

:menu
cls
echo ============================================================
echo   TeleAgent 反代控制台
echo ============================================================
echo.
echo   [1] 启动方案A (8790)  支持自定义 tools
echo   [2] 启动方案B (8788)  走内核、风险低
echo   [3] 启动两个
echo   [4] 停止全部
echo   [5] 查看状态
echo   [6] 发测试消息
echo   [7] 环境自检
echo   [8] 查看当前账号
echo   [9] 打开使用文档
echo   [0] 退出
echo.
set /p "c= 请选择 (0-9): "

if "%c%"=="1" "%NODE%" ta-ctl.js start a & goto :done
if "%c%"=="2" "%NODE%" ta-ctl.js start b & goto :done
if "%c%"=="3" "%NODE%" ta-ctl.js start a & "%NODE%" ta-ctl.js start b & goto :done
if "%c%"=="4" "%NODE%" ta-ctl.js stop all & goto :done
if "%c%"=="5" "%NODE%" ta-ctl.js status & goto :done
if "%c%"=="6" set /p "msg= 输入测试内容 (默认 你好): " & "%NODE%" ta-ctl.js test "%msg%" & goto :done
if "%c%"=="7" "%NODE%" ta-ctl.js doctor & goto :done
if "%c%"=="8" "%NODE%" ta-ctl.js account & goto :done
if "%c%"=="9" start "" "%USERPROFILE%\.workbuddy\skills\teleagent-proxy\USAGE.md" & goto :done
if "%c%"=="0" exit /b
echo 无效选项
timeout /t 2 >nul
goto :menu

:done
echo.
echo (any key to continue...)
pause >nul
goto :menu
