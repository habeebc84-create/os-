# Multi-Core CPU Scheduling Simulator

Interactive simulator for classic CPU scheduling algorithms on multiple cores — FCFS, SJF, SRTF, Priority (preemptive / non-preemptive), and Round Robin — with animated Gantt timelines, live hardware monitoring, process monitoring, performance analytics, and a complete Windows C11/MinGW source project.

[Live simulator](https://multi-core-cpu-scheduling-simulator.vercel.app/)

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

- `VITE_BACKEND_URL` (optional, default `http://127.0.0.1:8080`): Origin of the Windows C11 agent.

## Deploy (Vercel)

Both repo-root and subfolder deployments are supported cleanly:

- **Option A — Subfolder Root Directory**: Set Root Directory to `multi-core-cpu-scheduling-simulator` in Vercel Project Settings (`multi-core-cpu-scheduling-simulator/vercel.json` handles build, output `dist`, SPA rewrites, and headers).
- **Option B — Repo Root**: Leave Root Directory empty. The root `vercel.json` installs dependencies in `multi-core-cpu-scheduling-simulator`, builds the app, and publishes `multi-core-cpu-scheduling-simulator/dist`.

## Hardware monitor & Windows C11 project

Scheduling and Performance Analytics run directly in the browser. To view actual Windows CPU, RAM, and processes or launch approved Windows apps, download the C11 project ZIP from the hosted dashboard. On Windows, extract it, run `build.bat` with MinGW-w64, and start `simulator.exe --allow-hosted`. Choose **Connect Windows Agent** in either monitor and allow local network access if prompted.

For the same-origin dashboard, run `simulator.exe` and open [the local dashboard](http://127.0.0.1:8080/). See the [Windows project instructions](multi-core-cpu-scheduling-simulator/public/windows-c-project/README.md) for setup and launcher details.
