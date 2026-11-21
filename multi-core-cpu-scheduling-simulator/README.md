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

Copy `.env.example` to `.env.local` if you want to override the local Windows C11 backend URL (defaults to `http://localhost:8080` when running over HTTP). No API keys or secrets are required.
