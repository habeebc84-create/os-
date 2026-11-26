# Multi-Core CPU Scheduling Simulator with Real-Time Hardware Monitoring

A complete Operating Systems project written in pure **C11** for Windows (MinGW GCC) with a single-file Apple **Liquid Glass** (`dashboard.html`) web frontend.

## Project Structure

- `scheduler.h` / `scheduler.c` — Multi-core tick-based scheduling engine using real Windows threads (`CreateThread`, `CRITICAL_SECTION`, auto-reset `Event` barriers) supporting FCFS, SJF, SRTF, Priority (Preemptive & Non-Preemptive), and Round Robin, plus exact Module 3 performance metrics and `--test` CLI suite.
- `monitor.h` / `monitor.c` — Real-time Windows API observer reading CPU model (Registry), physical/logical cores (`GetLogicalProcessorInformation`), live CPU % (`GetSystemTimes`), live RAM (`GlobalMemoryStatusEx`), running processes (`CreateToolhelp32Snapshot` + `GetProcessMemoryInfo`), and whitelisted app launching (`CreateProcessA` + optional `SetProcessAffinityMask`).
- `server.c` — Multi-threaded Winsock2 HTTP/1.1 REST server (`http://127.0.0.1:8080`), hand-written JSON parser/serializer, CORS headers, and downloadable CSV report generator.
- `dashboard.html` — Single-file visionOS / Apple Liquid Glass frontend with 4 interactive tabs, animated Gantt chart playhead, live SVG gauges, CPU and RAM history and comparison charts, and toast notifications.
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
   gcc -std=c11 -O2 server.c scheduler.c monitor.c -o simulator.exe -lws2_32 -lpsapi -ladvapi32
   ```
2. Verify all 5 scheduling algorithms in the terminal (without browser):
   ```cmd
   simulator.exe --test
   ```
3. Start the HTTP server:
   ```cmd
   simulator.exe
   ```
4. Open **http://127.0.0.1:8080** in any modern browser.

## Connect the Hosted Simulator

In PowerShell, open the extracted folder and run `.\build.bat --allow-hosted` to compile and start the agent. Keep that window open while connected. For an existing build, follow the steps below.

1. Stop any running local-only instance with **Ctrl+C**. From the same project folder, start the agent with hosted access enabled:

   ```cmd
   simulator.exe --allow-hosted
   ```

2. Open the [hosted simulator](https://multi-core-cpu-scheduling-simulator.vercel.app/), select **Connect Windows Agent**, and grant the browser's local network permission if prompted.
3. Open **Live Hardware Monitor** for CPU and RAM readings or **Process Monitor** to view Windows processes and launch apps. Chrome and VS Code must be installed in a standard system or per-user installation folder. The affinity selector lists the logical CPU IDs available to the agent. Windows may delegate a launch to an existing app instance, so the displayed affinity applies to the new process created by the agent.
4. If the hosted site cannot reach the agent, open [the local dashboard](http://127.0.0.1:8080/) on the same Windows computer. This dashboard also works with the default `simulator.exe` command.

The agent listens on the Windows computer's loopback address. `--allow-hosted` permits the production simulator origin to read local hardware and process data and request launches from the whitelist. Stop the agent when you want to end that access.

## Launch Results (opening time and cores)

After each launch from the Process Monitor tab, the **Launch Results** panel below the launcher shows real numbers measured by the agent on this PC:

- **Opening time**: `QueryPerformanceCounter` from just before `CreateProcessA` until `WaitForInputIdle` reports the app is ready for input (maximum 10 s). If the started process hands off to an already-running instance or a Store app and exits (common for Chrome, and for Calculator/Notepad on Windows 11), it is shown as "Handed off and exited".
- **Cores**: the requested core, the cores Windows actually allows the process to use (`GetProcessAffinityMask`), and whether the pin was verified.
- **Per-core load**: every logical core's busy % before and during the launch and live every second (`NtQuerySystemInformation`), with the pinned core highlighted.
- **Process stats**: CPU %, CPU time (`GetProcessTimes`), working-set memory and peak (`GetProcessMemoryInfo`) and thread count.
- **History**: every launch this session, with CSV export.

Endpoints: `POST /api/launch`, `GET /api/launch/stats?pid=N` (only PIDs this agent launched), `GET /api/cores`.

## Demo Script for Viva / Presentation

1. **Scheduling Simulator Tab**: Click **Load Sample Data** (`P1..P5`, 2 cores, quantum 3), click **Run Simulation**, inspect the multi-core Gantt chart, then click **Play** to animate the glowing playhead and watch the live Core Cards light up per tick.
2. **Live Hardware Monitor Tab**: Show your real CPU model, physical/logical core count, live circular gauges, and 60-second scrolling CPU/RAM charts.
3. **Process Monitor Tab**: Search for `simulator.exe` or sort by memory, pick a target core in the affinity selector, and click **Launch Notepad** or **Launch Calculator** to demonstrate `CreateProcess` + `SetProcessAffinityMask`.
4. **Performance Analytics Tab**: Click **Compare All Algorithms**, show the highlighted best algorithm per metric and comparison bar charts, then click **Download CSV Report**.

> **Disclaimer**: The agent observes real Windows activity. The simulator models scheduling independently and does not control the Windows kernel scheduler.
