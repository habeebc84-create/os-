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

The app lives in the `multi-core-cpu-scheduling-simulator/` subfolder, so Vercel must be told to build there. **Pick one** of these two setups - do not mix them:

**Option A - dashboard Root Directory (what the current project uses)**

Set in Project Settings:

| Setting | Value |
| --- | --- |
| Root Directory | `multi-core-cpu-scheduling-simulator` |
| Framework Preset | Vite |
| Install Command | `npm install` |
| Build Command | `npm run build` |
| Output Directory | `dist` |

`multi-core-cpu-scheduling-simulator/vercel.json` backs this up for the same folder.

**Option B - root directory at repo root**

Clear the Root Directory so the app is built from the repo root. The repo-root `vercel.json` then sets `"rootDirectory": "multi-core-cpu-scheduling-simulator"`.

> **Important:** Vercel only reads a `vercel.json` that sits **inside the configured Root Directory**. A root-level `vercel.json` is ignored when the Root Directory points at a subfolder, and vice versa. Running `npm install` at the repo root fails with `ENOENT: no package.json`, because there is no `package.json` there.

### Deploying

This project has automatic Git deploys turned off, so pushing to `main` does not publish anything. After a merge, deploy explicitly (for example `vercel --prod`, or Redeploy on the latest deployment). Do **not** press Redeploy on an old failed deployment - it rebuilds the old commit and reproduces its error.

## Hardware monitor

The Hardware tab talks to the Windows C server (`server.c`, port 8080) when it is running locally. On a hosted deployment that backend is not present, so the tab falls back to simulated preview data - the scheduler itself runs fully in the browser.

## Windows C project

The full C11 source (scheduler, monitor, HTTP server, dashboard, `build.bat`) is in `multi-core-cpu-scheduling-simulator/public/windows-c-project/` - build it with MinGW GCC on Windows.
