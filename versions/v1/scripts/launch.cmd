@echo off
REM TeleAgent shim launcher. Args: <port> <apiKey> <host> <a|b> [nodePath]
REM IMPORTANT: the default node lives under TeleAgent\runtimes\, and TeleAgent
REM kills processes under that directory on startup. Pass a different nodePath
REM (or set TA_NODE) when the shim must survive a TeleAgent restart.
setlocal
set "TA_PORT=%~1"
set "TA_API_KEY=%~2"
set "TA_HOST=%~3"
set "HERE=%~dp0"
if "%TA_NODE%"=="" set "NODE=%USERPROFILE%\.local\share\TeleAgent\runtimes\node\node.exe"
if not "%TA_NODE%"=="" set "NODE=%TA_NODE%"
if not "%~5"=="" set "NODE=%~5"

if "%TA_PORT%"=="" set "TA_PORT=8790"
if "%TA_API_KEY%"=="" set "TA_API_KEY=teleagent-local"
if "%TA_HOST%"=="" set "TA_HOST=127.0.0.1"

set "SCRIPT=%HERE%ta-shim-a.js"
if /I "%~4"=="b" set "SCRIPT=%HERE%ta-shim.js"

echo [%DATE% %TIME%] start %SCRIPT% port=%TA_PORT% node=%NODE% >> "%HERE%shim-launch.log"
"%NODE%" "%SCRIPT%" >> "%HERE%shim-%~4.log" 2>&1
