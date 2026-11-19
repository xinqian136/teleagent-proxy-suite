@echo off
REM tav2 start — 启动反代服务（自动找 node）
REM
REM 拷贝到别的机器后，双击这个文件就能跑。
REM 不需要装 TeleAgent，不需要 npm install，没有任何第三方依赖。

setlocal
cd /d "%~dp0.."

REM ---- 找 node ----
set "NODE="
where node >nul 2>nul && set "NODE=node"

if "%NODE%"=="" (
  if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
)

if "%NODE%"=="" (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
)

if "%NODE%"=="" (
  REM TeleAgent 自带的 node（如果装了）
  if exist "%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe" set "NODE=%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe"
)

if "%NODE%"=="" (
  echo [X] 找不到 Node.js
  echo.
  echo 请安装 Node.js 18 或更高版本：https://nodejs.org
  echo 或者从 https://nodejs.org/dist/ 下载免安装版，解压后把 node.exe 放到本目录。
  echo.
  pause
  exit /b 1
)

echo 使用 Node: %NODE%
"%NODE%" --version
echo.

"%NODE%" "%~dp0..\bin\tav2.js" %*

if errorlevel 1 (
  echo.
  echo [X] 启动失败
  pause
)
endlocal
