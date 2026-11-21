# Multi-Core CPU Scheduling Simulator with Real-Time Hardware Monitoring

A complete Operating Systems project written in pure **C11** for Windows (MinGW GCC) with a single-file Apple **Liquid Glass** (`dashboard.html`) web frontend.

## Project Structure

- `scheduler.h` / `scheduler.c` — Multi-core tick-based scheduling engine using real Windows threads (`CreateThread`, `CRITICAL_SECTION`, auto-reset `Event` barriers) supporting FCFS, SJF, SRTF, Priority (Preemptive & Non-Preemptive), and Round Robin, plus exact Module 3 performance metrics and `--test` CLI suite.
- `monitor.h` / `monitor.c` — Real-time Windows API observer reading CPU model (Registry), physical/logical cores (`GetLogicalProcessorInformation`), live CPU % (`GetSystemTimes`), live RAM (`GlobalMemoryStatusEx`), running processes (`CreateToolhelp32Snapshot` + `GetProcessMemoryInfo`), and whitelisted app launching (`CreateProcessA` + optional `SetProcessAffinityMask`).
- `server.c` — Multi-threaded Winsock2 HTTP/1.1 REST server (`http://localhost:8080`), hand-written JSON parser/serializer, CORS headers, and downloadable CSV report generator.
- `dashboard.html` — Single-file visionOS / Apple Liquid Glass frontend with 4 interactive tabs, animated Gantt chart playhead, live SVG gauges, Chart.js graphs, and toast notifications.
- `build.bat` — One-click Windows MinGW compilation script.

## Prerequisites (Windows)

- Windows 10 or Windows 11
- MinGW-w64 GCC (`gcc --version` available in Command Prompt / PowerShell)

## Build & Run

1. Open Command Prompt in the project folder and compile:
   ```cmd
   build.bat
   ```
   Or compile manually:
   ```cmd
   gcc server.c scheduler.c monitor.c -o simulator.exe -lws2_32 -lpsapi -ladvapi32
   ```
2. Verify all 5 scheduling algorithms in the terminal (without browser):
   ```cmd
   simulator.exe --test
   ```
3. Start the HTTP server:
   ```cmd
   simulator.exe
   ```
4. Open **http://localhost:8080** in any modern browser.

## Demo Script for Viva / Presentation

1. **Scheduling Simulator Tab**: Click **Load Sample Data** (`P1..P5`, 2 cores, quantum 3), click **Run Simulation**, inspect the multi-core Gantt chart, then click **Play** to animate the glowing playhead and watch the live Core Cards light up per tick.
2. **Live Hardware Monitor Tab**: Show your real CPU model, physical/logical core count, live circular gauges, and 60-second scrolling CPU/RAM charts.
3. **Process Monitor Tab**: Search for `simulator.exe` or sort by memory, pick a target core in the affinity selector, and click **Launch Notepad** or **Launch Calculator** to demonstrate `CreateProcess` + `SetProcessAffinityMask`.
4. **Performance Analytics Tab**: Click **Compare All Algorithms**, show the highlighted best algorithm per metric and Chart.js comparison bar charts, then click **Download CSV Report**.

> **Disclaimer**: The agent observes real Windows activity. The simulator models scheduling independently and does not control the Windows kernel scheduler.
