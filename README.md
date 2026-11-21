# Multi-Core CPU Scheduling Simulator

Interactive simulator for classic CPU scheduling algorithms on multiple cores - FCFS, SJF, SRTF, Priority (preemptive / non-preemptive) and Round Robin - with Gantt charts, performance analytics, a hardware monitor view, and a complete Windows C11/MinGW source project.

Live app: the Vite + React + TypeScript frontend in `multi-core-cpu-scheduling-simulator/`.

## Run locally

```bash
cd multi-core-cpu-scheduling-simulator
npm install
npm run dev
```

Then open http://localhost:3000.

## Deploy (Vercel)

Import this repo as-is. The app lives in the `multi-core-cpu-scheduling-simulator/` subfolder, so the repo-root `vercel.json` points Vercel install, build and output steps into that folder - no dashboard Root Directory change is needed.

If the Vercel project Root Directory was set to the old upload folder name ending in ` (1)`, update it to `multi-core-cpu-scheduling-simulator` (or clear it, since `vercel.json` now handles it).

## Hardware monitor

The Hardware tab talks to the Windows C server (`server.c`, port 8080) when it is running locally. On a hosted deployment that backend is not present, so the tab falls back to simulated preview data - the scheduler itself runs fully in the browser.

## Windows C project

The full C11 source (scheduler, monitor, HTTP server, dashboard, `build.bat`) is in `multi-core-cpu-scheduling-simulator/public/windows-c-project/` - build it with MinGW GCC on Windows.
