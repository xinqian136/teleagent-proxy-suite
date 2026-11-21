@echo off
rem stop-tashim.cmd — 停止本地反代 shim（方案 B 8788 + 方案 A 8790）
setlocal

for %%P in (8788 8790) do (
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
    echo 停止 %%P (PID %%p) ...
    taskkill /PID %%p /F >nul 2>&1
  )
)

echo 完成。
timeout /t 2 /nobreak >nul
