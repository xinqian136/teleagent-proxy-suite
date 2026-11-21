@echo off
rem ============================================================
rem  start-tashim-a.cmd — 启动方案 A（直连云网关）的 OpenAI 兼容 API
rem
rem  特点：原生支持**自定义 tools** —— pi / Cline / Cursor 这类
rem        agent 可以自己控制工具循环（方案 B 不行）
rem
rem  代价：出站是「第二客户端」特征，封号风险比方案 B 高
rem
rem  产物：http://127.0.0.1:8790/v1
rem
rem  环境变量（可选）：
rem    TA_HOST=0.0.0.0        对外监听
rem    TA_PORT=8790          端口
rem    TA_API_KEY=xxx        开启 API Key 校验
rem ============================================================
setlocal
cd /d "%~dp0"

set NODE=%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe
if not exist "%NODE%" (
  echo [!] 找不到 TeleAgent 自带 node: %NODE%
  pause
  exit /b 1
)

if "%TA_HOST%"=="" set TA_HOST=127.0.0.1
if "%TA_PORT%"=="" set TA_PORT=8790

for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%TA_PORT% " ^| findstr "LISTENING"') do (
  echo [i] 端口 %TA_PORT% 已被占用 ^(PID %%p^)
  pause
  exit /b 0
)

echo [1/3] 检查 token.key ^(safeStorage AES key^) ...
if not exist "token.key" (
  echo     未找到，正在解密 TeleAgent 的登录令牌...
  "%USERPROFILE%\.local\share\TeleAgent\runtimes\python\python.exe" "C:\Users\Administrator\WorkBuddy\2026-11-17-15-41-50\_research\teleagent-proxy-main\scripts\setup.py"
  if errorlevel 1 (
    echo [!] 解密失败：需要 TeleAgent 已运行过并登录过
    pause
    exit /b 1
  )
  if not exist "token.key" (
    echo [!] token.key 未生成
    pause
    exit /b 1
  )
) else (
  echo     token.key 已存在
)

echo [2/3] 校验登录令牌 ...
"%NODE%" -e "const {getToken}=require('./ta-token'); try{const t=getToken(); console.log('     token OK, tenant='+t.token.split(':')[0]);}catch(e){console.error('     '+e.message);process.exit(1);}"
if errorlevel 1 (
  echo [!] 令牌不可用：TeleAgent 可能需要重新登录
  pause
  exit /b 1
)

echo [3/3] 启动方案 A shim（后台隐藏）...
powershell -NoProfile -Command "Start-Process -FilePath '%NODE%' -ArgumentList 'ta-shim-a.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
timeout /t 3 /nobreak >nul

echo.
echo 完成 -> http://127.0.0.1:%TA_PORT%/v1
if "%TA_HOST%"=="0.0.0.0" (
  echo   对外监听中，局域网内可用本机 IP 访问
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
echo 支持: 自定义 tools（agent 自己控制工具循环）^| 流式 ^| Anthropic 协议 ^| Responses API
echo.
echo ⚠ 风险提示: 直连网关是「第二客户端」，封号风险高于方案 B(8788)。
echo.
pause
