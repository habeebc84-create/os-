import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Check,
  Code2,
  Copy,
  Cpu,
  Download,
  ListTree,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Shuffle,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  AlgorithmType,
  buildCsvReport,
  compareAllAlgorithms,
  CompareResponse,
  PriorityMode,
  ProcessInput,
  runMultiCoreSimulation,
  SAMPLE_WORKLOAD,
  SimResult,
} from './lib/schedulerEngine';

type TabKey = 'scheduler' | 'hardware' | 'processes' | 'analytics';

interface ToastItem {
  id: number;
  message: string;
  color: string;
}

interface OSProcess {
  pid: number;
  name: string;
  memoryMB: number;
  isNew?: boolean;
}

// Hard ceiling on simulated cores, mirrored by runMultiCoreSimulation.
const MAX_CORES = 8;

// Per-process identity colours, read from the design system so the chart is
// defined in one place (index.css). Same weight, all legible as white text.
const PROC_SOLID = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
];
// Alias kept so the Gantt and queue code share one source of truth.
const PROC_GRADIENTS = PROC_SOLID;

const C_PROJECT_FILES = [
  { name: 'scheduler.h', label: 'scheduler.h', desc: 'Data structures & scheduling API' },
  { name: 'scheduler.c', label: 'scheduler.c', desc: 'Win32 threads, CRITICAL_SECTION & 5 algorithms' },
  { name: 'monitor.h', label: 'monitor.h', desc: 'Hardware & process monitor header' },
  { name: 'monitor.c', label: 'monitor.c', desc: 'Win32 Registry, GetSystemTimes, PSAPI & CreateProcess' },
  { name: 'server.c', label: 'server.c', desc: 'Winsock2 HTTP server, manual JSON & CSV report' },
  { name: 'dashboard.html', label: 'dashboard.html', desc: 'Single-file Apple Liquid Glass frontend' },
  { name: 'build.bat', label: 'build.bat', desc: 'MinGW GCC Windows compile script' },
  { name: 'README.md', label: 'README.md', desc: 'Build, run & viva demo guide' },
];

const PREVIEW_PROCESSES: OSProcess[] = [
  { pid: 1420, name: 'chrome.exe', memoryMB: 642.4 },
  { pid: 4812, name: 'Code.exe', memoryMB: 518.9 },
  { pid: 892, name: 'dwm.exe', memoryMB: 134.2 },
  { pid: 3104, name: 'explorer.exe', memoryMB: 112.7 },
  { pid: 7220, name: 'simulator.exe', memoryMB: 14.6 },
  { pid: 6108, name: 'MsMpEng.exe', memoryMB: 204.5 },
  { pid: 2216, name: 'svchost.exe', memoryMB: 68.3 },
  { pid: 5510, name: 'WindowsTerminal.exe', memoryMB: 89.1 },
  { pid: 1096, name: 'SearchHost.exe', memoryMB: 96.4 },
  { pid: 408, name: 'csrss.exe', memoryMB: 8.2 },
];

function AnimatedNumber({ value, decimals = 2, suffix = '' }: { value: number; decimals?: number; suffix?: string }) {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);

  useEffect(() => {
    const start = prevRef.current;
    const end = value;
    prevRef.current = value;
    if (Math.abs(end - start) < 0.0001) {
      setDisplay(end);
      return;
    }
    const startTime = performance.now();
    const duration = 420;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(start + (end - start) * eased);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <span className="tabular-nums">{display.toFixed(decimals)}{suffix}</span>;
}

function LiveSparkChart({ data, stroke, gradientId }: { data: number[]; stroke: string; gradientId: string }) {
  const w = 520;
  const h = 190;
  const pad = 12;
  const pts = data.map((v, i) => {
    const x = pad + (i / Math.max(1, data.length - 1)) * (w - pad * 2);
    const y = h - pad - (Math.min(100, Math.max(0, v)) / 100) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M ${pts.join(' L ')}`;
  const areaPath = `${linePath} L ${(w - pad).toFixed(1)},${(h - pad).toFixed(1)} L ${pad},${(h - pad).toFixed(1)} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[168px] overflow-visible" role="img" aria-label="Utilisation over the last 60 seconds">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.16" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {[0, 25, 50, 75, 100].map((tick) => {
        const y = h - pad - (tick / 100) * (h - pad * 2);
        return (
          <g key={tick}>
            <line
              x1={pad}
              y1={y}
              x2={w - pad}
              y2={y}
              stroke={tick === 0 ? '#cbd5e1' : '#e8edf4'}
              strokeWidth={1}
            />
            <text x={0} y={y + 3.5} fill="#94a3b8" fontSize="9" className="tabular-nums">
              {tick}
            </text>
          </g>
        );
      })}
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path d={linePath} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('scheduler');
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Scheduler state
  const [processes, setProcesses] = useState<ProcessInput[]>(SAMPLE_WORKLOAD);
  const [algorithm, setAlgorithm] = useState<AlgorithmType>('FCFS');
  const [cores, setCores] = useState<number>(2);
  const [quantum, setQuantum] = useState<number>(3);
  const [priorityMode, setPriorityMode] = useState<PriorityMode>('preemptive');
  const [newPid, setNewPid] = useState('P6');
  const [newArrival, setNewArrival] = useState(0);
  const [newBurst, setNewBurst] = useState(5);
  const [newPriority, setNewPriority] = useState(2);

  const [simResult, setSimResult] = useState<SimResult>(() =>
    runMultiCoreSimulation(SAMPLE_WORKLOAD, 'FCFS', 2, 3, 'preemptive')
  );
  const [compareResult, setCompareResult] = useState<CompareResponse>(() =>
    compareAllAlgorithms(SAMPLE_WORKLOAD, 2, 3, 'preemptive')
  );

  // Gantt animated replay
  const [isPlaying, setIsPlaying] = useState(false);
  const [playTick, setPlayTick] = useState<number | null>(null);
  const playProgressRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Hardware & Process monitor preview (detects local C backend on :8080 if running)
  const [backendConnected, setBackendConnected] = useState(false);
  const browserLogicalCpus = Math.max(1, navigator.hardwareConcurrency || 8);
  const hwInfoDefault = {
    cpuModel: 'Interactive Preview (Run simulator.exe on Windows for real Win32 Registry)',
    physicalCores: Math.max(1, Math.floor(browserLogicalCpus / 2)),
    logicalProcessors: browserLogicalCpus,
  };
  const [hwInfo, setHwInfo] = useState(hwInfoDefault);
  const [liveCpu, setLiveCpu] = useState(24.5);
  const [liveRamPct, setLiveRamPct] = useState(56.2);
  const [liveRamUsedGB, setLiveRamUsedGB] = useState(8.99);
  const [liveRamTotalGB, setLiveRamTotalGB] = useState(16.0);
  const [cpuSeries, setCpuSeries] = useState<number[]>(() =>
    Array.from({ length: 60 }, (_, i) => 18 + Math.sin(i * 0.25) * 8 + (i % 5))
  );
  const [ramSeries, setRamSeries] = useState<number[]>(() =>
    Array.from({ length: 60 }, (_, i) => 54 + Math.cos(i * 0.15) * 3)
  );

  const [osProcs, setOsProcs] = useState<OSProcess[]>(PREVIEW_PROCESSES);
  const [procSearch, setProcSearch] = useState('');
  const [procSort, setProcSort] = useState<{ key: 'name' | 'pid' | 'memoryMB'; dir: 1 | -1 }>({
    key: 'memoryMB',
    dir: -1,
  });
  const [pinCore, setPinCore] = useState<number>(-1);

  // Windows C11 Source Drawer
  const [codeDrawerOpen, setCodeDrawerOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState(C_PROJECT_FILES[0].name);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [copiedFile, setCopiedFile] = useState<string | null>(null);

  // Toast dismiss timers are tracked so they can be cleared on unmount. Without
  // this, every toast leaves a timer that fires setToasts on an unmounted
  // component, and rapid actions stack unbounded pending timers.
  const toastTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const pushToast = (message: string, color = 'var(--accent)') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, color }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      toastTimers.current.delete(timer);
    }, 3200);
    toastTimers.current.add(timer);
  };

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  // The local C backend (simulator.exe) only listens on plain HTTP at
  // localhost:8080. Polling it every second from an HTTPS page would spam the
  // console (Private Network Access preflights), so polling stays off there —
  // but a user-initiated Launch still tries once, and it can succeed because
  // server.c answers preflights with Access-Control-Allow-Private-Network.
  // Easiest reliable setup is still running this page over http://localhost.
  const canReachLocalBackend = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.location.protocol !== 'https:';
  }, []);

  // Poll 1s live metrics (tries localhost:8080 C backend first; cleanly falls back to smooth browser preview telemetry)
  useEffect(() => {
    let active = true;
    if (!canReachLocalBackend) {
      // HTTPS page: the local HTTP backend is unreachable, stay on preview telemetry.
      setBackendConnected(false);
      const previewTimer = setInterval(() => {
        setLiveCpu((prev) => {
          const next = Math.min(92, Math.max(8, prev + (Math.random() - 0.48) * 9));
          setCpuSeries((s) => [...s.slice(1), Number(next.toFixed(1))]);
          return Number(next.toFixed(1));
        });
        setLiveRamPct((prev) => {
          const next = Math.min(84, Math.max(38, prev + (Math.random() - 0.5) * 1.4));
          setRamSeries((s) => [...s.slice(1), Number(next.toFixed(1))]);
          setLiveRamUsedGB(Number(((next / 100) * 16.0).toFixed(2)));
          return Number(next.toFixed(1));
        });
      }, 1000);
      return () => {
        active = false;
        clearInterval(previewTimer);
      };
    }
    const checkHw = async () => {
      try {
        const res = await fetch('http://localhost:8080/api/hardware', { signal: AbortSignal.timeout(800) });
        if (res.ok && active) {
          const data = await res.json();
          const logical = Math.floor(Number(data?.logicalProcessors));
          const physical = Math.floor(Number(data?.physicalCores));
          setHwInfo({
            cpuModel: data?.cpuModel || 'Unknown processor',
            physicalCores: Number.isFinite(physical) && physical > 0 ? physical : hwInfoDefault.physicalCores,
            logicalProcessors:
              Number.isFinite(logical) && logical > 0 ? logical : hwInfoDefault.logicalProcessors,
          });
          setBackendConnected(true);
        }
      } catch {
        if (active) setBackendConnected(false);
      }
    };
    checkHw();

    const timer = setInterval(async () => {
      try {
        const res = await fetch('http://localhost:8080/api/live', { signal: AbortSignal.timeout(700) });
        if (res.ok && active) {
          const m = await res.json();
          setBackendConnected(true);
          setLiveCpu(m.cpuPercent);
          setLiveRamPct(m.ramPercent);
          setLiveRamUsedGB(m.ramUsedMB / 1024);
          setLiveRamTotalGB(m.ramTotalMB / 1024);
          setCpuSeries((prev) => [...prev.slice(1), m.cpuPercent]);
          setRamSeries((prev) => [...prev.slice(1), m.ramPercent]);
          return;
        }
      } catch {
        // Local C server not running on user's machine yet — run live preview waveform
      }
      if (!active) return;
      setBackendConnected(false);
      setLiveCpu((prev) => {
        const next = Math.min(92, Math.max(8, prev + (Math.random() - 0.48) * 9));
        setCpuSeries((s) => [...s.slice(1), Number(next.toFixed(1))]);
        return Number(next.toFixed(1));
      });
      setLiveRamPct((prev) => {
        const next = Math.min(84, Math.max(38, prev + (Math.random() - 0.5) * 1.4));
        setRamSeries((s) => [...s.slice(1), Number(next.toFixed(1))]);
        setLiveRamUsedGB(Number(((next / 100) * 16.0).toFixed(2)));
        return Number(next.toFixed(1));
      });
    }, 1000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [canReachLocalBackend]);

  // Load C source files on demand when drawer opens
  useEffect(() => {
    if (!codeDrawerOpen || fileContents[selectedFile]) return;
    let cancelled = false;
    fetch(`/windows-c-project/${encodeURIComponent(selectedFile)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (!cancelled) setFileContents((prev) => ({ ...prev, [selectedFile]: text }));
      })
      .catch(() => {
        if (cancelled) return;
        setFileContents((prev) => ({
          ...prev,
          [selectedFile]: `// Could not load ${selectedFile} (file missing or network error).\n// The source lives in public/windows-c-project/ in the repository.`,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [codeDrawerOpen, selectedFile, fileContents]);

  const pidColorIndex = useMemo(() => {
    const map: Record<string, number> = {};
    processes.forEach((p, idx) => {
      if (!(p.pid in map)) map[p.pid] = idx % PROC_GRADIENTS.length;
    });
    simResult.processes.forEach((p, idx) => {
      if (!(p.pid in map)) map[p.pid] = idx % PROC_GRADIENTS.length;
    });
    return map;
  }, [processes, simResult]);

  const stopReplay = () => {
    setIsPlaying(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  // Cancel the replay animation if the component unmounts mid-play, otherwise
  // the rAF loop keeps running against an unmounted tree.
  useEffect(() => stopReplay, []);

  const handleRunSimulation = () => {
    if (!processes.length) {
      pushToast('Add at least one process first', 'var(--danger)');
      return;
    }
    stopReplay();
    setPlayTick(null);
    playProgressRef.current = 0;
    const res = runMultiCoreSimulation(processes, algorithm, cores, quantum, priorityMode);
    setSimResult(res);
    pushToast(`Simulation complete (${res.algorithm}, ${res.cores} cores)`, 'var(--success)');
  };

  const handleCompareAll = () => {
    if (!processes.length) {
      pushToast('Add processes in the Simulator tab first', 'var(--danger)');
      return;
    }
    const cmp = compareAllAlgorithms(processes, cores, quantum, priorityMode);
    setCompareResult(cmp);
    pushToast('Compared all 5 scheduling algorithms', 'var(--chart-2)');
  };

  const handleTogglePlay = () => {
    const makespan = simResult.metrics.makespan;
    if (!makespan) return;
    if (isPlaying) {
      stopReplay();
      return;
    }
    setIsPlaying(true);
    if (playProgressRef.current >= makespan) playProgressRef.current = 0;
    let lastTs = performance.now();
    const speed = Math.max(2.2, Math.min(5.5, makespan / 5));

    const frame = (ts: number) => {
      const dt = (ts - lastTs) / 1000;
      lastTs = ts;
      playProgressRef.current += dt * speed;
      if (playProgressRef.current >= makespan) {
        setPlayTick(makespan);
        stopReplay();
        pushToast('Gantt replay finished', 'var(--info)');
        return;
      }
      setPlayTick(playProgressRef.current);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
  };

  const handleResetReplay = () => {
    stopReplay();
    playProgressRef.current = 0;
    setPlayTick(null);
  };

  const handleAddProcess = () => {
    const pid = newPid.trim() || `P${processes.length + 1}`;
    const next = [
      ...processes,
      {
        pid,
        arrival: Math.max(0, Number(newArrival) || 0),
        burst: Math.max(1, Number(newBurst) || 1),
        priority: Math.max(1, Number(newPriority) || 1),
      },
    ];
    setProcesses(next);
    setNewPid(`P${next.length + 1}`);
    pushToast(`Added process ${pid}`, 'var(--success)');
  };

  // Refreshes the process table from the real Win32 backend when it is
  // reachable. The preview list is static, so the button reports what actually
  // happened instead of always claiming a refresh succeeded.
  const [procBusy, setProcBusy] = useState(false);
  const handleRefreshProcesses = async () => {
    setProcBusy(true);
    try {
      const res = await fetch('http://localhost:8080/api/processes', { signal: AbortSignal.timeout(1500) });
      if (!res.ok) throw new Error(`Backend returned ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.processes;
      if (!Array.isArray(list) || !list.length) throw new Error('Backend returned no processes');
      const cleaned: OSProcess[] = list
        .map((p: any) => ({
          pid: Number(p.pid),
          name: String(p.name ?? 'unknown'),
          memoryMB: Number(p.memoryMB ?? p.memory ?? 0),
        }))
        .filter((p) => Number.isFinite(p.pid) && p.pid > 0);
      if (!cleaned.length) throw new Error('Backend returned no usable process rows');
      setOsProcs(cleaned);
      pushToast(`Loaded ${cleaned.length} processes from the backend`, 'var(--success)');
    } catch {
      pushToast(
        'Showing the preview process list — start simulator.exe on this PC to load live data.',
        'var(--warning)'
      );
    } finally {
      setProcBusy(false);
    }
  };

  const handleLoadSample = () => {
    setProcesses(SAMPLE_WORKLOAD);
    setCores(2);
    setQuantum(3);
    setNewPid('P6');
    const res = runMultiCoreSimulation(SAMPLE_WORKLOAD, algorithm, 2, 3, priorityMode);
    setSimResult(res);
    pushToast('Sample workload loaded (P1–P5, 2 cores, Q=3)', 'var(--accent)');
  };

  const handleRandomize = () => {
    const count = 5 + Math.floor(Math.random() * 4);
    const list: ProcessInput[] = Array.from({ length: count }, (_, i) => ({
      pid: `P${i + 1}`,
      arrival: Math.floor(Math.random() * 7),
      burst: 2 + Math.floor(Math.random() * 9),
      priority: 1 + Math.floor(Math.random() * 5),
    }));
    setProcesses(list);
    setNewPid(`P${count + 1}`);
    pushToast(`Generated ${count} random processes`, 'var(--chart-2)');
  };

  const handleDownloadCsv = () => {
    const csv = buildCsvReport(simResult, compareResult);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cpu_scheduler_report.csv';
    a.rel = 'noopener';
    // The anchor must be in the document for the download to fire in Firefox,
    // and the object URL must outlive the click or the download is cancelled.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    pushToast('Report downloaded (cpu_scheduler_report.csv)', 'var(--success)');
  };

  const handleLaunchApp = async (app: 'chrome' | 'vscode' | 'notepad' | 'calculator') => {
    const names: Record<string, string> = {
      chrome: 'Google Chrome',
      vscode: 'VS Code',
      notepad: 'Notepad',
      calculator: 'Calculator',
    };
    // Always try the real backend when the user clicks Launch: it may have
    // started after this page loaded, and on an HTTPS page the attempt can
    // succeed once simulator.exe answers Private Network Access preflights
    // (see server.c send_response). Never fake a launch — if the backend is
    // not reachable, say so and stop.
    try {
      const res = await fetch('http://localhost:8080/api/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app, core: pinCore }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Launch failed');
      pushToast(data.message, 'var(--success)');
    } catch {
      pushToast(
        `${names[app]} not launched — backend not reachable. Run build.bat, then simulator.exe on this Windows PC, and try again.`,
        'var(--danger)'
      );
    }
  };

  const filteredOsProcs = useMemo(() => {
    const q = procSearch.trim().toLowerCase();
    return osProcs
      .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.pid).includes(q))
      .sort((a, b) => {
        const av = a[procSort.key];
        const bv = b[procSort.key];
        if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * procSort.dir;
        return ((av as number) - (bv as number)) * procSort.dir;
      });
  }, [osProcs, procSearch, procSort]);

  // Single source of truth for "how long is this run". Guarded so a degenerate
  // simulation (zero makespan) never divides by zero in the Gantt layout.
  const simMakespan = Math.max(1, simResult.metrics.makespan);

  const activeSnap = useMemo(() => {
    if (playTick === null || !simResult.ticks.length) return null;
    const idx = Math.min(simResult.ticks.length - 1, Math.floor(playTick));
    return simResult.ticks[idx];
  }, [playTick, simResult]);

  const navItems: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'scheduler', label: 'Scheduling Simulator', icon: <Cpu className="w-5 h-5" /> },
    { key: 'hardware', label: 'Live Hardware Monitor', icon: <Activity className="w-5 h-5" /> },
    { key: 'processes', label: 'Process Monitor', icon: <ListTree className="w-5 h-5" /> },
    { key: 'analytics', label: 'Performance Analytics', icon: <BarChart3 className="w-5 h-5" /> },
  ];

  return (
    <div className="min-h-screen bg-[var(--page)] text-[var(--ink)]">
      <div className="mx-auto max-w-[1560px] px-4 py-4 lg:px-6 lg:py-6 grid grid-cols-1 lg:grid-cols-[254px_minmax(0,1fr)] gap-5 min-h-screen items-start">
        <aside className="liquid-glass p-3 lg:sticky lg:top-6 flex flex-col justify-between lg:h-[calc(100vh-3rem)]">
          <div>
            <div className="px-2 pt-1 pb-3 mb-3 border-b border-[var(--border)]">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-[var(--radius-sm)] bg-[var(--accent)] text-white grid place-items-center shrink-0">
                  <Cpu className="w-3.5 h-3.5" />
                </span>
                <span className="text-sm font-semibold tracking-tight">CoreOS Simulator</span>
              </div>
              <div className="text-[11px] text-[var(--ink-subtle)] mt-1.5 pl-8">
                C11 multi-core engine
              </div>
            </div>

            <nav className="flex flex-row lg:flex-col gap-0.5 flex-wrap">
              {navItems.map((item) => {
                const active = activeTab === item.key;
                return (
                  <button
                    key={item.key}
                    onClick={() => setActiveTab(item.key)}
                    aria-current={active ? 'page' : undefined}
                    className={`nav-btn ${active ? 'nav-btn-active' : ''}`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="mt-3 lg:mt-0 space-y-2">
            <button
              onClick={() => setCodeDrawerOpen(true)}
              className="btn w-full"
            >
              <Code2 className="w-3.5 h-3.5 text-[var(--ink-subtle)]" />
              <span>C11 Project (8 files)</span>
            </button>
            <p className="px-1 text-[11px] leading-relaxed text-[var(--ink-subtle)]">
              Winsock2 HTTP + Win32 threads — CreateThread, CRITICAL_SECTION, GetSystemTimes.
            </p>
          </div>
        </aside>

        {/* Workspace Column */}
        <div className="flex flex-col gap-5 min-w-0">
          <header className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-[15px] font-semibold tracking-tight truncate">
                Multi-Core CPU Scheduling Simulator
              </div>
              <div className="text-[11px] text-[var(--ink-subtle)]">
                {navItems.find((t) => t.key === activeTab)?.label}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`pill ${
                  backendConnected
                    ? 'pill-ok'
                    : canReachLocalBackend
                      ? 'pill-warn'
                      : 'pill-off'
                }`}
                title={
                  canReachLocalBackend
                    ? 'simulator.exe on localhost:8080'
                    : 'Open this page over http://localhost to reach the local backend'
                }
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{
                    background: backendConnected
                      ? 'var(--success)'
                      : canReachLocalBackend
                        ? 'var(--warning)'
                        : 'var(--ink-subtle)',
                  }}
                />
                {backendConnected ? 'Backend connected' : 'Browser preview'}
              </span>
              <button onClick={() => setCodeDrawerOpen(true)} className="btn">
                <Code2 className="w-3.5 h-3.5 text-[var(--ink-subtle)]" />
                <span>C11 Source Files</span>
              </button>
            </div>
          </header>

          {/* ================= TAB 1: SCHEDULING SIMULATOR ================= */}
          {activeTab === 'scheduler' && (
            <div className="flex flex-col gap-5">
              {/* Page heading + at-a-glance summary */}
              <div className="liquid-glass px-5 py-4">
                <div className="flex items-start justify-between gap-6 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[var(--ink-subtle)]">
                      Operating Systems
                    </div>
                    <h1 className="text-xl font-semibold tracking-tight mt-1">
                      Multi-Core CPU Scheduling Simulator
                    </h1>
                    <p className="text-[13px] text-[var(--ink-muted)] leading-relaxed max-w-[62ch] mt-1.5">
                      Compare FCFS, SJF, SRTF, Priority and Round Robin across 1–8 cores, replay execution
                      tick by tick, and inspect per-core utilisation.
                    </p>
                  </div>
                  <div className="flex items-stretch gap-5 shrink-0">
                    {[
                      { label: 'Algorithm', value: simResult.algorithm },
                      { label: 'Cores', value: String(simResult.cores) },
                      { label: 'Makespan', value: `${simResult.metrics.makespan}t` },
                      {
                        label: 'Utilisation',
                        value: `${simResult.metrics.cpuUtilization.toFixed(0)}%`,
                      },
                    ].map((k) => (
                      <div key={k.label}>
                        <div className="text-[10px] font-semibold tracking-[0.06em] uppercase text-[var(--ink-subtle)]">
                          {k.label}
                        </div>
                        <div className="text-sm font-semibold tabular-nums mt-0.5">{k.value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Config & Process Builder */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                <div className="liquid-glass p-5">
                  <div className="card-head">
                    <div>
                      <h2 className="card-title">Simulation Parameters</h2>
                      <p className="card-sub">Algorithm, core count, quantum and preemption</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="field-label">Algorithm</span>
                      <select
                        value={algorithm}
                        onChange={(e) => setAlgorithm(e.target.value as AlgorithmType)}
                        className="field"
                      >
                        <option value="FCFS">FCFS (Non-Preemptive)</option>
                        <option value="SJF">SJF (Non-Preemptive)</option>
                        <option value="SRTF">SRTF (Preemptive)</option>
                        <option value="Priority">Priority Scheduling</option>
                        <option value="Round Robin">Round Robin</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="field-label">CPU Cores (1–8)</span>
                      <input
                        type="number"
                        min={1}
                        max={MAX_CORES}
                        value={cores}
                        onChange={(e) => setCores(Math.min(MAX_CORES, Math.max(1, Number(e.target.value) || 1)))}
                        className="field tabular-nums"
                      />
                    </label>
                    <label className="block">
                      <span className="field-label">Time Quantum (RR)</span>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={quantum}
                        onChange={(e) => setQuantum(Math.max(1, Number(e.target.value) || 1))}
                        className="field tabular-nums"
                      />
                    </label>
                    <label className="block">
                      <span className="field-label">Priority Mode</span>
                      <select
                        value={priorityMode}
                        onChange={(e) => setPriorityMode(e.target.value as PriorityMode)}
                        className="field"
                      >
                        <option value="preemptive">Preemptive</option>
                        <option value="non-preemptive">Non-Preemptive</option>
                      </select>
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-[var(--border)]">
                    <button onClick={handleRunSimulation} className="btn btn-lg btn-primary">
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Run Simulation</span>
                    </button>
                    <button onClick={handleLoadSample} className="btn btn-lg">
                      <Sparkles className="w-3.5 h-3.5 text-[var(--ink-subtle)]" />
                      <span>Load Sample</span>
                    </button>
                    <button onClick={handleRandomize} className="btn btn-lg">
                      <Shuffle className="w-3.5 h-3.5 text-[var(--ink-subtle)]" />
                      <span>Randomise</span>
                    </button>
                  </div>
                </div>

                {/* Add / Manage Processes */}
                <div className="liquid-glass p-5">
                  <div className="card-head">
                    <div>
                      <h2 className="card-title">
                        Process Queue <span className="text-[var(--ink-subtle)] font-medium">({processes.length})</span>
                      </h2>
                      <p className="card-sub">Lower priority number = higher urgency</p>
                    </div>
                    <button onClick={() => setProcesses([])} className="btn btn-sm">
                      Clear all
                    </button>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <label className="block">
                      <span className="field-label">PID</span>
                      <input
                        value={newPid}
                        onChange={(e) => setNewPid(e.target.value)}
                        className="field"
                      />
                    </label>
                    <label className="block">
                      <span className="field-label">Arrival</span>
                      <input
                        type="number"
                        min={0}
                        value={newArrival}
                        onChange={(e) => setNewArrival(Number(e.target.value))}
                        className="field tabular-nums"
                      />
                    </label>
                    <label className="block">
                      <span className="field-label">Burst</span>
                      <input
                        type="number"
                        min={1}
                        value={newBurst}
                        onChange={(e) => setNewBurst(Number(e.target.value))}
                        className="field tabular-nums"
                      />
                    </label>
                    <label className="block">
                      <span className="field-label">Priority</span>
                      <input
                        type="number"
                        min={1}
                        value={newPriority}
                        onChange={(e) => setNewPriority(Number(e.target.value))}
                        className="field tabular-nums"
                      />
                    </label>
                  </div>
                  <div className="mt-2.5">
                    <button onClick={handleAddProcess} className="btn w-full border-dashed">
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add process</span>
                    </button>
                  </div>
                  <div className="mt-3 max-h-[172px] overflow-y-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>PID</th>
                          <th>Arrival</th>
                          <th>Burst</th>
                          <th>Priority</th>
                          <th className="text-right"> </th>
                        </tr>
                      </thead>
                      <tbody>
                        {processes.map((p, idx) => (
                          <tr key={`${p.pid}-${idx}`}>
                            <td className="font-medium">
                              <span className="flex items-center gap-2">
                                <span
                                  className="w-2 h-2 rounded-full inline-block shrink-0"
                                  style={{ background: PROC_SOLID[pidColorIndex[p.pid] ?? 0] }}
                                />
                                {p.pid}
                              </span>
                            </td>
                            <td className="text-[var(--ink-muted)]">{p.arrival}</td>
                            <td className="text-[var(--ink-muted)]">{p.burst}</td>
                            <td className="text-[var(--ink-muted)]">{p.priority}</td>
                            <td className="text-right">
                              <button
                                onClick={() => setProcesses((prev) => prev.filter((_, i) => i !== idx))}
                                className="btn btn-sm btn-danger"
                                title={`Remove ${p.pid}`}
                                aria-label={`Remove ${p.pid}`}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </td>
                          </tr>
                        ))}
                        {!processes.length && (
                          <tr>
                            <td colSpan={5} className="py-6 text-center text-xs text-[var(--ink-subtle)]">
                              Queue is empty — add a process or load the sample workload.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Live Core Cards */}
              <div className="liquid-glass p-5">
                <div className="card-head">
                  <div>
                    <h2 className="card-title">Core Execution</h2>
                    <p className="card-sub tabular-nums">
                      {activeSnap
                        ? `Tick ${activeSnap.tick} · Ready: ${
                            activeSnap.readyQueue.length ? activeSnap.readyQueue.join(', ') : 'empty'
                          } · Done ${activeSnap.completed}/${simResult.processes.length}`
                        : 'Press Play to replay execution across cores'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={handleTogglePlay} className="btn btn-primary">
                      {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                      <span>{isPlaying ? 'Pause' : 'Play replay'}</span>
                    </button>
                    <button onClick={handleResetReplay} className="btn">
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Reset</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
                  {simResult.metrics.coreUtilization.map((c) => {
                    const livePid = activeSnap ? activeSnap.cores[c.core] : c.busyTime > 0 ? 'ACTIVE' : 'IDLE';
                    const isBusy = livePid !== 'IDLE';
                    const hasProc = livePid !== 'IDLE' && livePid !== 'ACTIVE';
                    return (
                      <div
                        key={c.core}
                        className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 transition-colors"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-semibold tracking-[0.06em] uppercase text-[var(--ink-subtle)]">
                            Core {c.core}
                          </span>
                          <span className="text-[11px] font-semibold text-[var(--ink-muted)] tabular-nums">
                            {c.utilization.toFixed(0)}%
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{
                              background: hasProc
                                ? PROC_SOLID[pidColorIndex[livePid] ?? 0]
                                : isBusy
                                  ? 'var(--ink-subtle)'
                                  : 'var(--border-strong)',
                            }}
                          />
                          <span
                            className={`text-[13px] font-semibold truncate ${
                              isBusy ? 'text-[var(--ink)]' : 'text-[var(--ink-subtle)]'
                            }`}
                          >
                            {hasProc ? livePid : isBusy ? 'Busy' : 'Idle'}
                          </span>
                        </div>
                        <div className="bar mt-2" style={{ height: 4 }}>
                          <div
                            className="bar-fill"
                            style={{
                              width: `${Math.min(100, c.utilization)}%`,
                              background: hasProc
                                ? PROC_SOLID[pidColorIndex[livePid] ?? 0]
                                : 'var(--accent)',
                            }}
                          />
                        </div>
                        <div className="text-[10px] text-[var(--ink-subtle)] mt-1.5 tabular-nums">
                          {c.busyTime}t busy · {c.idleTime}t idle
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Multi-Core Gantt Chart */}
              <div className="liquid-glass p-5">
                <div className="card-head">
                  <div>
                    <h2 className="card-title">Execution Timeline</h2>
                    <p className="card-sub">
                      {simResult.algorithm}
                      {simResult.algorithm === 'Priority' ? ` (${simResult.priorityMode})` : ''} · {simResult.cores}{' '}
                      cores · makespan {simResult.metrics.makespan}t
                    </p>
                  </div>
                  <div className="text-[11px] font-semibold text-[var(--ink-muted)] tabular-nums bg-[var(--surface-muted)] border border-[var(--border)] rounded-[var(--radius-sm)] px-2 py-1">
                    tick {playTick !== null ? playTick.toFixed(1) : '0.0'} / {simResult.metrics.makespan}
                  </div>
                </div>

                <div className="overflow-x-auto pb-2">
                  <div className="relative min-w-[660px]">
                    {/* Moving Glowing Playhead */}
                    {playTick !== null && simResult.metrics.makespan > 0 && (
                      <div
                        className="absolute top-0 bottom-6 w-px pointer-events-none z-20"
                        style={{
                          left: `calc(68px + (100% - 68px) * ${Math.min(1, playTick / simResult.metrics.makespan)})`,
                          background: 'var(--ink)',
                          boxShadow: '0 0 0 1px rgba(15,23,42,0.12)',
                        }}
                      />
                    )}

                    {Array.from({ length: simResult.cores }, (_, c) => {
                      const segs = simResult.gantt.filter((s) => s.core === c);
                      const makespan = simMakespan;
                      return (
                        <div key={c} className="grid grid-cols-[56px_1fr] items-center gap-3 mb-2">
                          <div className="text-[10px] font-semibold tracking-[0.06em] uppercase text-[var(--ink-subtle)] text-right">
                            Core {c}
                          </div>
                          <div className="relative h-8 rounded-[var(--radius-sm)] bg-[var(--surface-sunken)] overflow-hidden">
                            {segs.map((s, idx) => {
                              const left = (s.start / makespan) * 100;
                              const width = ((s.end - s.start) / makespan) * 100;
                              const playAt = playTick === null ? null : Math.min(playTick, simMakespan);
                              const dimmed = playAt !== null && playAt < s.start;
                              const lit =
                                playAt !== null &&
                                playAt >= s.start &&
                                (playAt < s.end || (playAt === simMakespan && s.end === simMakespan)) &&
                                !s.idle;
                              return (
                                <div
                                  key={`${c}-${s.start}-${s.end}`}
                                  title={`Core ${c} · ${s.pid} · [${s.start} → ${s.end}] (${s.end - s.start} ticks)`}
                                  className={`absolute inset-y-0 flex items-center justify-center px-1 overflow-hidden whitespace-nowrap gantt-grow transition-all duration-150 ${
                                    s.idle ? 'gantt-idle-stripe' : 'gantt-label'
                                  } ${dimmed ? 'opacity-25' : ''} ${
                                    lit ? 'z-10 ring-2 ring-[var(--ink)] ring-inset' : ''
                                  }`}
                                  style={{
                                    left: `${left}%`,
                                    width: `${width}%`,
                                    background: s.idle ? undefined : PROC_GRADIENTS[pidColorIndex[s.pid] ?? 0],
                                    animationDelay: `${idx * 35}ms`,
                                  }}
                                >
                                  {s.pid}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}

                    {/* Time Axis */}
                    <div className="grid grid-cols-[56px_1fr] gap-3 mt-1">
                      <div />
                      <div className="relative h-4 text-[10px] font-medium text-[var(--ink-subtle)] tabular-nums">
                        {(() => {
                          const ms = Math.max(1, simResult.metrics.makespan);
                          const step = ms <= 20 ? 1 : Math.ceil(ms / 15);
                          const marks: number[] = [];
                          for (let t = 0; t <= ms; t += step) marks.push(t);
                          if (marks[marks.length - 1] !== ms) marks.push(ms);
                          return marks.map((t) => (
                            <span
                              key={t}
                              className="absolute -translate-x-1/2"
                              style={{ left: `${(t / ms) * 100}%` }}
                            >
                              {t}
                            </span>
                          ));
                        })()}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Module 3 KPI Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {[
                  { label: 'Avg Turnaround', val: simResult.metrics.avgTurnaround, dec: 2, suf: '', hint: 'Completion − Arrival' },
                  { label: 'Avg Waiting', val: simResult.metrics.avgWaiting, dec: 2, suf: '', hint: 'Turnaround − Burst' },
                  { label: 'Avg Response', val: simResult.metrics.avgResponse, dec: 2, suf: '', hint: 'First Start − Arrival' },
                  { label: 'CPU Utilization', val: simResult.metrics.cpuUtilization, dec: 1, suf: '%', hint: 'Busy / (Cores × Makespan)' },
                  { label: 'Throughput', val: simResult.metrics.throughput, dec: 3, suf: '', hint: 'Processes / tick' },
                  { label: 'Context Switches', val: simResult.metrics.contextSwitches, dec: 0, suf: '', hint: 'Core process handoffs' },
                  { label: 'Total Idle Time', val: simResult.metrics.totalIdleTime, dec: 0, suf: '', hint: 'Across all cores' },
                  { label: 'Makespan', val: simResult.metrics.makespan, dec: 0, suf: '', hint: 'Total ticks elapsed' },
                ].map((k) => (
                  <div key={k.label} className="metric">
                    <div className="metric-label">{k.label}</div>
                    <div className="metric-value">
                      <AnimatedNumber value={k.val} decimals={k.dec} suffix={k.suf} />
                    </div>
                    <div className="metric-hint">{k.hint}</div>
                  </div>
                ))}
              </div>

              {/* Per-Process Results Table */}
              <div className="liquid-glass p-5">
                <div className="card-head">
                  <div>
                    <h2 className="card-title">Per-Process Metrics</h2>
                    <p className="card-sub">Timing derived from arrival, burst and completion ticks</p>
                  </div>
                </div>
                <div className="overflow-x-auto -mx-1 px-1">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>PID</th>
                        <th>Arrival</th>
                        <th>Burst</th>
                        <th>Priority</th>
                        <th>First start</th>
                        <th>Completion</th>
                        <th>Turnaround</th>
                        <th>Waiting</th>
                        <th>Response</th>
                      </tr>
                    </thead>
                    <tbody>
                      {simResult.processes.map((p, idx) => (
                        <tr key={`${p.pid}-${idx}`}>
                          <td className="font-medium">
                            <span className="flex items-center gap-2">
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ background: PROC_SOLID[pidColorIndex[p.pid] ?? 0] }}
                              />
                              {p.pid}
                            </span>
                          </td>
                          <td className="text-[var(--ink-muted)]">{p.arrival}</td>
                          <td className="text-[var(--ink-muted)]">{p.burst}</td>
                          <td className="text-[var(--ink-muted)]">{p.priority}</td>
                          <td className="text-[var(--ink-muted)]">{p.firstStart}</td>
                          <td className="text-[var(--ink-muted)]">{p.completion}</td>
                          <td className="font-semibold">{p.turnaround}</td>
                          <td>{p.waiting}</td>
                          <td>{p.response}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ================= TAB 2: LIVE HARDWARE MONITOR ================= */}
          {activeTab === 'hardware' && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                <div className="metric md:col-span-1">
                  <div className="metric-label">Processor</div>
                  <div className="text-[13px] font-semibold mt-1.5 leading-snug">{hwInfo.cpuModel}</div>
                  <div className="metric-hint">Win32 registry</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Physical cores</div>
                  <div className="metric-value">{hwInfo.physicalCores}</div>
                  <div className="metric-hint">GetLogicalProcessorInformation</div>
                </div>
                <div className="metric">
                  <div className="metric-label">Logical processors</div>
                  <div className="metric-value">{hwInfo.logicalProcessors}</div>
                  <div className="metric-hint">Hardware execution threads</div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="liquid-glass p-5 flex items-center gap-5 flex-wrap">
                  <div className="relative w-28 h-28 shrink-0">
                    <svg className="w-28 h-28 -rotate-90" viewBox="0 0 140 140">
                      <circle cx="70" cy="70" r="60" fill="none" stroke="var(--surface-sunken)" strokeWidth="10" />
                      <circle
                        cx="70"
                        cy="70"
                        r="60"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="10"
                        strokeLinecap="round"
                        strokeDasharray={2 * Math.PI * 60}
                        strokeDashoffset={2 * Math.PI * 60 * (1 - liveCpu / 100)}
                        style={{ transition: 'stroke-dashoffset 0.5s ease' }}
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <div className="text-lg font-semibold tabular-nums">
                        <AnimatedNumber value={liveCpu} decimals={1} suffix="%" />
                      </div>
                      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--ink-subtle)]">
                        CPU
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 min-w-[170px]">
                    <h3 className="card-title">System CPU utilisation</h3>
                    <p className="card-sub">
                      Sampled every second from the Windows{' '}
                      <code className="font-mono-tabular text-[11px] text-[var(--ink-muted)]">GetSystemTimes</code>{' '}
                      idle / kernel / user deltas.
                    </p>
                  </div>
                </div>

                <div className="liquid-glass p-5 flex items-center gap-5 flex-wrap">
                  <div className="relative w-28 h-28 shrink-0">
                    <svg className="w-28 h-28 -rotate-90" viewBox="0 0 140 140">
                      <circle cx="70" cy="70" r="60" fill="none" stroke="var(--surface-sunken)" strokeWidth="10" />
                      <circle
                        cx="70"
                        cy="70"
                        r="60"
                        fill="none"
                        stroke="var(--info)"
                        strokeWidth="10"
                        strokeLinecap="round"
                        strokeDasharray={2 * Math.PI * 60}
                        strokeDashoffset={2 * Math.PI * 60 * (1 - liveRamPct / 100)}
                        style={{ transition: 'stroke-dashoffset 0.5s ease' }}
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <div className="text-lg font-semibold tabular-nums">
                        <AnimatedNumber value={liveRamPct} decimals={1} suffix="%" />
                      </div>
                      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--ink-subtle)]">
                        RAM
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 min-w-[170px]">
                    <h3 className="card-title">Physical memory in use</h3>
                    <div className="text-[13px] font-semibold mt-1 tabular-nums">
                      {liveRamUsedGB.toFixed(2)} GB{' '}
                      <span className="text-[var(--ink-subtle)] font-normal">of {liveRamTotalGB.toFixed(2)} GB</span>
                    </div>
                    <p className="card-sub">
                      Observed via{' '}
                      <code className="font-mono-tabular text-[11px] text-[var(--ink-muted)]">GlobalMemoryStatusEx</code>.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="liquid-glass p-5">
                  <div className="card-head">
                    <div>
                      <h3 className="card-title">CPU utilisation</h3>
                      <p className="card-sub">Last 60 seconds · 1 Hz</p>
                    </div>
                  </div>
                  <LiveSparkChart data={cpuSeries} stroke="var(--accent)" gradientId="cpuAreaFill" />
                </div>
                <div className="liquid-glass p-5">
                  <div className="card-head">
                    <div>
                      <h3 className="card-title">Memory utilisation</h3>
                      <p className="card-sub">Last 60 seconds · 1 Hz</p>
                    </div>
                  </div>
                  <LiveSparkChart data={ramSeries} stroke="var(--info)" gradientId="ramAreaFill" />
                </div>
              </div>
            </div>
          )}

          {/* ================= TAB 3: PROCESS MONITOR ================= */}
          {activeTab === 'processes' && (
            <div className="flex flex-col gap-4">
              <div className="liquid-glass p-5">
                <div className="card-head">
                  <div>
                    <h2 className="card-title">Application Launcher</h2>
                    <p className="card-sub">
                      Whitelisted executables only, spawned with{' '}
                      <code className="font-mono-tabular text-[11px]">CreateProcessA</code> and optionally pinned with{' '}
                      <code className="font-mono-tabular text-[11px]">SetProcessAffinityMask</code>
                    </p>
                  </div>
                  <label className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-[var(--ink-muted)]">Pin to core</span>
                    <select
                      value={pinCore}
                      onChange={(e) => setPinCore(Number(e.target.value))}
                      className="field field-sm w-auto"
                    >
                      <option value={-1}>OS default</option>
                      {Array.from({ length: Math.min(MAX_CORES, hwInfo.logicalProcessors) }, (_, i) => (
                        <option key={i} value={i}>
                          Core {i}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div
                  className={`rounded-[var(--radius)] border px-3 py-2 mb-3.5 flex items-start gap-2 ${
                    backendConnected
                      ? 'bg-[var(--success-wash)] border-[var(--success-border)]'
                      : 'bg-[var(--warning-wash)] border-[var(--warning-border)]'
                  }`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full mt-[5px] shrink-0"
                    style={{ background: backendConnected ? 'var(--success)' : 'var(--warning)' }}
                  />
                  <p
                    className="text-[11px] leading-relaxed"
                    style={{ color: backendConnected ? 'var(--success)' : 'var(--warning)' }}
                  >
                    {backendConnected
                      ? 'Backend connected on localhost:8080 — launches start real Windows processes.'
                      : 'Backend not connected. Run build.bat, then simulator.exe on this Windows PC, to enable real launches.'}
                  </p>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { key: 'chrome', label: 'Chrome' },
                    { key: 'vscode', label: 'VS Code' },
                    { key: 'notepad', label: 'Notepad' },
                    { key: 'calculator', label: 'Calculator' },
                  ].map((app) => (
                    <button
                      key={app.key}
                      onClick={() => handleLaunchApp(app.key as 'chrome' | 'vscode' | 'notepad' | 'calculator')}
                      className="btn h-11 justify-center"
                    >
                      {app.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="liquid-glass p-5">
                <div className="card-head">
                  <div>
                    <h2 className="card-title">
                      Running processes{' '}
                      <span className="text-[var(--ink-subtle)] font-medium">({filteredOsProcs.length})</span>
                    </h2>
                    <p className="card-sub">Toolhelp32Snapshot + GetProcessMemoryInfo · click a column to sort</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-[var(--ink-subtle)] absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        value={procSearch}
                        onChange={(e) => setProcSearch(e.target.value)}
                        placeholder="Search name or PID"
                        className="field field-sm pl-8 w-52"
                      />
                    </div>
                    <button
                      onClick={handleRefreshProcesses}
                      disabled={procBusy}
                      className="btn"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${procBusy ? 'animate-spin' : ''}`} />
                      <span>{procBusy ? 'Refreshing…' : 'Refresh'}</span>
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto max-h-[420px] -mx-1 px-1">
                  <table className="data-table">
                    <thead className="sticky top-0 bg-[var(--surface)] z-10">
                      <tr>
                        {[
                          { key: 'name' as const, label: 'Process' },
                          { key: 'pid' as const, label: 'PID' },
                          { key: 'memoryMB' as const, label: 'Working set (MB)' },
                        ].map((col) => (
                          <th key={col.key}>
                            <button
                              onClick={() =>
                                setProcSort((s) => ({
                                  key: col.key,
                                  dir: s.key === col.key ? (s.dir === 1 ? -1 : 1) : 1,
                                }))
                              }
                              className="inline-flex items-center gap-1 cursor-pointer hover:text-[var(--ink)] uppercase"
                            >
                              {col.label}
                              <span className={procSort.key === col.key ? 'text-[var(--accent)]' : 'opacity-0'}>
                                {procSort.key === col.key && procSort.dir === -1 ? '↓' : '↑'}
                              </span>
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOsProcs.map((p) => (
                        <tr key={p.pid} className={p.isNew ? 'bg-[var(--success-wash)]' : undefined}>
                          <td className="font-medium">
                            <span className="flex items-center gap-2">
                              {p.isNew && (
                                <span className="text-[9px] font-bold uppercase tracking-wide text-[var(--success)] bg-[var(--success-wash)] border border-[var(--success-border)] rounded px-1 py-0.5">
                                  new
                                </span>
                              )}
                              {p.name}
                            </span>
                          </td>
                          <td className="text-[var(--ink-muted)]">{p.pid}</td>
                          <td>{p.memoryMB.toFixed(2)}</td>
                        </tr>
                      ))}
                      {!filteredOsProcs.length && (
                        <tr>
                          <td colSpan={3} className="py-6 text-center text-xs text-[var(--ink-subtle)]">
                            No process matches “{procSearch}”.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ================= TAB 4: PERFORMANCE ANALYTICS ================= */}
          {activeTab === 'analytics' && (
            <div className="flex flex-col gap-4">
              <div className="liquid-glass p-5 flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <h2 className="card-title">Algorithm comparison</h2>
                  <p className="card-sub">
                    All five algorithms on the same workload — {processes.length} processes, {cores} cores, quantum{' '}
                    {quantum}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={handleCompareAll} className="btn btn-primary">
                    Compare all
                  </button>
                  <button onClick={handleDownloadCsv} className="btn">
                    <Download className="w-3.5 h-3.5" />
                    <span>Download CSV</span>
                  </button>
                </div>
              </div>

              <div className="liquid-glass p-5">
                <div className="card-head">
                  <div>
                    <h2 className="card-title">Metrics matrix</h2>
                    <p className="card-sub">Best value in each column is marked</p>
                  </div>
                </div>
                <div className="overflow-x-auto -mx-1 px-1">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Algorithm</th>
                        <th>Avg wait ↓</th>
                        <th>Avg turnaround ↓</th>
                        <th>Avg response ↓</th>
                        <th>CPU util ↑</th>
                        <th>Throughput ↑</th>
                        <th>Context switches ↓</th>
                        <th>Makespan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compareResult.results.map((r) => {
                        const m = r.metrics;
                        const b = compareResult.best;
                        const cell = (isBest: boolean) =>
                          isBest ? 'text-[var(--success)] font-semibold bg-[var(--success-wash)]' : '';
                        const mark = (isBest: boolean) => (isBest ? '★' : '');
                        return (
                          <tr key={r.algorithm}>
                            <td className="font-medium">{r.algorithm}</td>
                            <td className={cell(r.algorithm === b.avgWaiting)}>
                              {m.avgWaiting.toFixed(2)} {mark(r.algorithm === b.avgWaiting)}
                            </td>
                            <td className={cell(r.algorithm === b.avgTurnaround)}>
                              {m.avgTurnaround.toFixed(2)} {mark(r.algorithm === b.avgTurnaround)}
                            </td>
                            <td className={cell(r.algorithm === b.avgResponse)}>
                              {m.avgResponse.toFixed(2)} {mark(r.algorithm === b.avgResponse)}
                            </td>
                            <td className={cell(r.algorithm === b.cpuUtilization)}>
                              {m.cpuUtilization.toFixed(2)}% {mark(r.algorithm === b.cpuUtilization)}
                            </td>
                            <td className="text-[var(--ink-muted)]">{m.throughput.toFixed(4)}</td>
                            <td className={cell(r.algorithm === b.contextSwitches)}>
                              {m.contextSwitches} {mark(r.algorithm === b.contextSwitches)}
                            </td>
                            <td className="text-[var(--ink-muted)]">{m.makespan}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="liquid-glass p-5">
                  <div className="card-head">
                    <div>
                      <h3 className="card-title">Average times</h3>
                      <p className="card-sub">Waiting · turnaround · response, in ticks</p>
                    </div>
                  </div>
                  <div className="space-y-3.5">
                    {(() => {
                      const maxVal = Math.max(
                        1,
                        ...compareResult.results.flatMap((r) => [
                          r.metrics.avgWaiting,
                          r.metrics.avgTurnaround,
                          r.metrics.avgResponse,
                        ])
                      );
                      return compareResult.results.map((r) => (
                        <div key={r.algorithm}>
                          <div className="flex justify-between items-baseline text-[11px] mb-1">
                            <span className="font-semibold">{r.algorithm}</span>
                            <span className="text-[var(--ink-subtle)] tabular-nums">
                              {r.metrics.avgWaiting.toFixed(2)} · {r.metrics.avgTurnaround.toFixed(2)} ·{' '}
                              {r.metrics.avgResponse.toFixed(2)}
                            </span>
                          </div>
                          <div className="space-y-0.5">
                            {[
                              { v: r.metrics.avgWaiting, c: 'var(--chart-1)' },
                              { v: r.metrics.avgTurnaround, c: 'var(--chart-2)' },
                              { v: r.metrics.avgResponse, c: 'var(--chart-3)' },
                            ].map((bar, i) => (
                              <div key={i} className="bar" style={{ height: 3 }}>
                                <div
                                  className="bar-fill"
                                  style={{ width: `${(bar.v / maxVal) * 100}%`, background: bar.c }}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                  <div className="flex flex-wrap gap-x-3.5 gap-y-1 mt-4 pt-3 border-t border-[var(--border)] text-[10px] text-[var(--ink-subtle)]">
                    {[
                      { c: 'var(--chart-1)', l: 'Waiting' },
                      { c: 'var(--chart-2)', l: 'Turnaround' },
                      { c: 'var(--chart-3)', l: 'Response' },
                    ].map((x) => (
                      <span key={x.l} className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-sm" style={{ background: x.c }} />
                        {x.l}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="liquid-glass p-5">
                  <div className="card-head">
                    <div>
                      <h3 className="card-title">Efficiency</h3>
                      <p className="card-sub">CPU utilisation and context-switch count</p>
                    </div>
                  </div>
                  <div className="space-y-3.5">
                    {(() => {
                      const maxCs = Math.max(1, ...compareResult.results.map((r) => r.metrics.contextSwitches));
                      return compareResult.results.map((r) => (
                        <div key={r.algorithm}>
                          <div className="flex justify-between items-baseline text-[11px] mb-1">
                            <span className="font-semibold">{r.algorithm}</span>
                            <span className="text-[var(--ink-subtle)] tabular-nums">
                              {r.metrics.cpuUtilization.toFixed(1)}% · {r.metrics.contextSwitches} cs
                            </span>
                          </div>
                          <div className="space-y-0.5">
                            <div className="bar" style={{ height: 4 }}>
                              <div
                                className="bar-fill"
                                style={{
                                  width: `${Math.min(100, r.metrics.cpuUtilization)}%`,
                                  background: 'var(--success)',
                                }}
                              />
                            </div>
                            <div className="bar" style={{ height: 3 }}>
                              <div
                                className="bar-fill"
                                style={{
                                  width: `${(r.metrics.contextSwitches / maxCs) * 100}%`,
                                  background: 'var(--chart-2)',
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                  <div className="flex flex-wrap gap-x-3.5 gap-y-1 mt-4 pt-3 border-t border-[var(--border)] text-[10px] text-[var(--ink-subtle)]">
                    {[
                      { c: 'var(--success)', l: 'CPU utilisation' },
                      { c: 'var(--chart-2)', l: 'Context switches' },
                    ].map((x) => (
                      <span key={x.l} className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-sm" style={{ background: x.c }} />
                        {x.l}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          <footer className="px-1 pb-1 text-center text-[11px] leading-relaxed text-[var(--ink-subtle)]">
            The agent observes real Windows activity. The simulator models scheduling independently and does not
            control the Windows kernel scheduler.
          </footer>
        </div>
      </div>

      {/* Windows C11 project source viewer */}
      {codeDrawerOpen && (
        <div
          className="fixed inset-0 z-50 bg-[#0f172a]/45 flex items-center justify-center p-4"
          onClick={() => setCodeDrawerOpen(false)}
          role="presentation"
        >
          <div
            className="bg-[var(--surface)] w-full max-w-5xl h-[84vh] flex flex-col overflow-hidden rounded-[var(--radius-lg)] shadow-[var(--shadow-raised)] border border-[var(--border)]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Windows C11 project bundle"
          >
            <div className="px-5 py-3.5 border-b border-[var(--border)] flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">Windows C11 / MinGW project</h2>
                <p className="text-[11px] text-[var(--ink-subtle)] font-mono-tabular mt-0.5 truncate">
                  gcc server.c scheduler.c monitor.c -o simulator.exe -lws2_32 -lpsapi -ladvapi32
                </p>
              </div>
              <button
                onClick={() => setCodeDrawerOpen(false)}
                className="btn btn-sm btn-ghost shrink-0"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 grid grid-cols-1 md:grid-cols-[230px_1fr] min-h-0">
              <div className="border-r border-[var(--border)] p-2 overflow-y-auto space-y-0.5 bg-[var(--surface-muted)]">
                {C_PROJECT_FILES.map((f) => (
                  <button
                    key={f.name}
                    onClick={() => setSelectedFile(f.name)}
                    className={`w-full text-left px-2.5 py-2 rounded-[var(--radius-sm)] transition-colors cursor-pointer ${
                      selectedFile === f.name
                        ? 'bg-[var(--accent-soft)] text-[var(--accent-ink)]'
                        : 'text-[var(--ink-muted)] hover:bg-[var(--surface-sunken)]'
                    }`}
                  >
                    <div className="text-[11px] font-semibold font-mono-tabular">{f.label}</div>
                    <div className="text-[10px] opacity-70 truncate mt-0.5">{f.desc}</div>
                  </button>
                ))}
              </div>
              <div className="flex flex-col min-h-0">
                <div className="px-4 py-2 border-b border-[var(--border)] flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold font-mono-tabular text-[var(--ink)]">
                    {selectedFile}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={async () => {
                        const text = fileContents[selectedFile] || '';
                        if (!text) {
                          pushToast('Source not loaded yet', 'var(--danger)');
                          return;
                        }
                        try {
                          if (!navigator.clipboard) throw new Error('Clipboard unavailable (needs HTTPS)');
                          await navigator.clipboard.writeText(text);
                          setCopiedFile(selectedFile);
                          pushToast(`Copied ${selectedFile}`, 'var(--success)');
                          setTimeout(() => setCopiedFile(null), 1800);
                        } catch (err) {
                          pushToast((err as Error).message || 'Could not copy', 'var(--danger)');
                        }
                      }}
                      className="btn btn-sm"
                    >
                      {copiedFile === selectedFile ? (
                        <Check className="w-3 h-3 text-[var(--success)]" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                      <span>{copiedFile === selectedFile ? 'Copied' : 'Copy'}</span>
                    </button>
                    <a
                      href={`/windows-c-project/${selectedFile}`}
                      download={selectedFile}
                      className="btn btn-sm btn-primary"
                    >
                      <Download className="w-3 h-3" />
                      <span>Download</span>
                    </a>
                  </div>
                </div>
                <pre className="flex-1 p-4 overflow-auto text-[11.5px] font-mono-tabular text-[var(--ink)] leading-relaxed bg-[var(--surface-muted)] m-0">
                  <code>{fileContents[selectedFile] || 'Loading source file…'}</code>
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-[min(92vw,22rem)]">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="toast-in pointer-events-auto px-3 py-2.5 rounded-[var(--radius)] bg-[var(--surface)] border border-[var(--border)] shadow-[var(--shadow-raised)] text-[12px] font-medium text-[var(--ink)] flex items-start gap-2.5"
          >
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0 mt-[6px]"
              style={{ background: t.color }}
            />
            <span className="leading-snug">{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
