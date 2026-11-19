@echo off
REM ============================================================
REM  Import an account package.
REM  Put account.bundle in this folder, then double-click this file.
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

REM ---- find the package ----
set "PKG="
if exist "account.bundle" set "PKG=account.bundle"
if "%PKG%"=="" goto :find2
goto :have

:find2
for %%f in (*.bundle) do set "PKG=%%f"
if "%PKG%"=="" goto :find3
goto :have

:find3
for %%f in (data\*.bundle) do set "PKG=%%f"

:have
if "%PKG%"=="" goto :nopkg

echo.
echo   Importing: %PKG%
echo.
"%NODE%" "%~dp0bin\tav2.js" import "%PKG%"

echo.
echo   Done. Now double-click the START file to launch the service.
echo.
timeout /t 3 >nul
endlocal
goto :eof

:nopkg
echo.
echo   No .bundle file found in this folder.
echo.
echo   Copy account.bundle here (same folder as this file), then run again.
echo.
timeout /t 3 >nul
exit /b 1

:nonode
echo.
echo   [X] Node.js not found.
echo       Install Node.js 18+ from https://nodejs.org
echo.
timeout /t 3 >nul
exit /b 1
