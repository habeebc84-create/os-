# Multi-Core CPU Scheduling Simulator

Interactive simulator for classic CPU scheduling algorithms on multiple cores — FCFS, SJF, SRTF, Priority (preemptive / non-preemptive), and Round Robin — with animated Gantt timelines, live hardware monitoring, process monitoring, performance analytics, and a complete Windows C11/MinGW source project.

Live app: the Vite + React + TypeScript frontend in `multi-core-cpu-scheduling-simulator/`.

## Run locally

From the repository root:

```bash
npm run install:app
npm run dev
```

Or from inside the app folder:

```bash
cd multi-core-cpu-scheduling-simulator
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment variables

No secrets or API keys are required. An optional `.env.example` is provided in `multi-core-cpu-scheduling-simulator/.env.example`:

- `VITE_BACKEND_URL` (optional, default `http://localhost:8080`): Local URL for the Windows C11 `simulator.exe` backend when running the UI over `http://localhost`.

## Deploy (Vercel)

Both repo-root and subfolder deployments are supported cleanly:

- **Option A — Subfolder Root Directory**: Set Root Directory to `multi-core-cpu-scheduling-simulator` in Vercel Project Settings (`multi-core-cpu-scheduling-simulator/vercel.json` handles build, output `dist`, SPA rewrites, and headers).
- **Option B — Repo Root**: Leave Root Directory empty. The root `vercel.json` installs dependencies in `multi-core-cpu-scheduling-simulator`, builds the app, and publishes `multi-core-cpu-scheduling-simulator/dist`.

## Hardware monitor & Windows C11 project

The Hardware and Process Monitor tabs automatically connect to the local Windows C11 server (`server.c`, bound to `127.0.0.1:8080`) when running over `http://localhost`. On hosted HTTPS deployments, the frontend runs fully in the browser with smooth preview telemetry and the exact 1:1 TypeScript scheduling engine.

The full C11 source (`scheduler.c/h`, `monitor.c/h`, `server.c`, `dashboard.html`, `build.bat`, `README.md`) is in `multi-core-cpu-scheduling-simulator/public/windows-c-project/`.
