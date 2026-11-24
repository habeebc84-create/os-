# Multi-Core CPU Scheduling Simulator (Frontend)

Vite + React + TypeScript + Tailwind CSS frontend for the Multi-Core CPU Scheduling Simulator, paired with the downloadable Windows C11/MinGW source project in `public/windows-c-project/`.

## Prerequisites

- Node.js 20+ and npm 10+

## Run Locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Scripts

- `npm run dev` — Start Vite dev server on port 3000
- `npm run build` — Production build to `dist/`
- `npm run preview` — Preview production build locally on port 3000
- `npm run lint` / `npm run typecheck` — Run TypeScript strict type checking (`tsc --noEmit`)

## Optional Environment Variables

Copy `.env.example` to `.env.local` if you want to override the local Windows C11 backend URL (defaults to `http://127.0.0.1:8080`). No API keys or secrets are required.

## Live Windows Monitor and Launcher

The hosted simulator and analytics run in the browser. For live Windows telemetry, process refresh and application launching, download the eight-file C11 ZIP from either monitor or the C11 source viewer. Extract it on Windows, run `build.bat` with MinGW-w64, then start `simulator.exe --allow-hosted` in that folder.

Open the [hosted dashboard](https://multi-core-cpu-scheduling-simulator.vercel.app/), select **Connect Windows Agent** on either monitor, and allow local network access if prompted. You can also run `simulator.exe` and open the [local dashboard](http://127.0.0.1:8080/) directly. The agent listens only on loopback. See the [Windows C11 instructions](public/windows-c-project/README.md) for more details.
