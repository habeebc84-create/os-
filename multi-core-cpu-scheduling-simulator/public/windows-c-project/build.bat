@echo off
setlocal
cd /d "%~dp0"
echo ============================================================
echo  Building Multi-Core CPU Scheduling Simulator (MinGW GCC)
echo ============================================================

where gcc >nul 2>nul
if errorlevel 1 (
    echo [ERROR] MinGW-w64 GCC was not found. Add its bin folder to PATH and reopen PowerShell.
    exit /b 1
)

gcc -std=c11 -O2 -Wall -Wextra server.c scheduler.c monitor.c -o simulator.exe -lws2_32 -lpsapi -ladvapi32

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Compilation failed! Make sure MinGW GCC is installed and on your PATH.
    exit /b 1
)

echo.
echo [SUCCESS] Built simulator.exe.
if /i "%~1"=="--allow-hosted" goto hosted
echo.
echo Run terminal verification test : simulator.exe --test
echo Start web server and dashboard : simulator.exe
echo Then open in browser           : http://127.0.0.1:8080
echo Enable hosted connection       : simulator.exe --allow-hosted
echo.
exit /b 0

:hosted
echo Keep this window open while using the hosted dashboard. Press Ctrl+C to stop.
simulator.exe --allow-hosted
exit /b %ERRORLEVEL%
