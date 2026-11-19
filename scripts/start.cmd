@echo off
REM tav2 start   node
REM
REM 
REM  TeleAgent npm install

setlocal
cd /d "%~dp0.."

REM ----  node ----
set "NODE="
where node >nul 2>nul && set "NODE=node"

if "%NODE%"=="" (
  if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
)

if "%NODE%"=="" (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
)

if "%NODE%"=="" (
  REM TeleAgent  node
  if exist "%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe" set "NODE=%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe"
)

if "%NODE%"=="" (
  echo [X]  Node.js
  echo.
  echo  Node.js 18 https://nodejs.org
  echo  https://nodejs.org/dist/  node.exe 
  echo.
  pause
  exit /b 1
)

echo  Node: %NODE%
"%NODE%" --version
echo.

"%NODE%" "%~dp0..\bin\tav2.js" %*

if errorlevel 1 (
  echo.
  echo [X] 
  pause
)
endlocal
