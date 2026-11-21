@echo off
rem ============================================================
rem  start-tashim.cmd — 启动 TeleAgent 本地反代（OpenAI / Anthropic 兼容 API）
rem
rem  前置：TeleAgent 已打开并已登录
rem  产物：http://127.0.0.1:8788/v1
rem
rem  环境变量（可选）：
rem    TA_HOST=0.0.0.0        对外（局域网）监听
rem    TA_PORT=8788          端口
rem    TA_API_KEY=xxx        开启 API Key 校验
rem    TA_MODE=yolo          内核工具执行模式
rem ============================================================
setlocal
cd /d "%~dp0"

set NODE=%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe
if not exist "%NODE%" (
  echo [!] 找不到 TeleAgent 自带 node: %NODE%
  echo     请先启动一次 TeleAgent。
  pause
  exit /b 1
)

if "%TA_HOST%"=="" set TA_HOST=127.0.0.1
if "%TA_PORT%"=="" set TA_PORT=8788

rem 端口占用检查
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%TA_PORT% " ^| findstr "LISTENING"') do (
  echo [i] 端口 %TA_PORT% 已被占用 ^(PID %%p^)
  echo     若已是本 shim，直接用即可；否则先运行 stop-tashim.cmd
  pause
  exit /b 0
)

echo [1/2] 检查 sessionKey ...
if not exist "session.key" (
  echo     未找到 session.key，正在从 TeleAgent 进程内存提取（需 1-3 分钟）...
  "%USERPROFILE%\.local\share\TeleAgent\runtimes\python\python.exe" "find-sessionkey.py"
  if errorlevel 1 (
    echo [!] 提取失败：请确认 TeleAgent 正在运行且已登录。
    pause
    exit /b 1
  )
) else (
  echo     session.key 已存在
)

echo [2/2] 启动 shim（后台隐藏）...
powershell -NoProfile -Command "Start-Process -FilePath '%NODE%' -ArgumentList 'ta-shim.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
timeout /t 3 /nobreak >nul

echo.
echo 完成 -> http://127.0.0.1:%TA_PORT%/v1
if "%TA_HOST%"=="0.0.0.0" (
  echo   对外监听中，局域网内可用本机 IP 访问:
  ipconfig ^| findstr /c:"IPv4"
  echo   Base URL : http://^<本机IP^>:%TA_PORT%/v1
) else (
  echo   Base URL : http://127.0.0.1:%TA_PORT%/v1
)
echo   API Key  : %TA_API_KEY%
if "%TA_API_KEY%"=="" (
  echo   鉴权     : 未开启 ^(本地随便填^)
) else (
  echo   鉴权     : 已开启，客户端需带 "Authorization: Bearer ^<你的key^>"
)
echo   Model    : chat-pro / chat-lite / chat-flash / chat-flagship / chat-nano
echo.
echo 端点: /v1/chat/completions ^(OpenAI^)  /v1/messages ^(Anthropic^)  /v1/responses  /v1/models
echo.
pause
