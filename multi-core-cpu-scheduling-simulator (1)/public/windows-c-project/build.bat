@echo off
echo ============================================================
echo  Building Multi-Core CPU Scheduling Simulator (MinGW GCC)
echo ============================================================

gcc -std=c11 -O2 -Wall -Wextra server.c scheduler.c monitor.c -o simulator.exe -lws2_32 -lpsapi -ladvapi32

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Compilation failed! Make sure MinGW GCC is installed and on your PATH.
    exit /b 1
)

echo.
echo [SUCCESS] Built simulator.exe cleanly with zero errors!
echo.
echo Run terminal verification test : simulator.exe --test
echo Start web server and dashboard : simulator.exe
echo Then open in browser           : http://localhost:8080
echo.
