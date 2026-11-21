@echo off
REM ============================================================
REM  Pause the whole background service (web panel + proxy).
REM  Double-click this file.
REM
REM  To bring it back, run the START file again.
REM
REM  NOTE: keep this file pure ASCII + CRLF.
REM ============================================================
setlocal
cd /d "%~dp0"

schtasks /End /TN "TeleAgent Proxy V3" >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*tav3.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

echo.
echo   Paused. The web panel and proxy are both stopped.
echo.
echo   To start again: double-click the START file.
echo.
endlocal
