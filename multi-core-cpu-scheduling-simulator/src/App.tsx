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

// Distinct, similar-weight hues that stay legible as white text on a Gantt bar
// and as a small dot on a white table row.
const PROC_SOLID = [
  '#2563eb',
  '#7c3aed',
  '#c2410c',
  '#15803d',
  '#b91c1c',
  '#4338ca',
  '#0e7490',
  '#a16207',
];
// Kept as a separate name because the Gantt code styles bars with it; flat
// solids read as an ordinary UI chart instead of a neon gradient.
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
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[210px] overflow-visible">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.44" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 25, 50, 75, 100].map((tick) => {
        const y = h - pad - (tick / 100) * (h - pad * 2);
        return (
          <g key={tick}>
            <line x1={pad} y1={y} x2={w - pad} y2={y} stroke="rgba(15,23,42,0.10)" strokeDasharray="4 4" />
            <text x={0} y={y + 4} fill="#64748b" fontSize="10" className="tabular-nums">
              {tick}%
            </text>
          </g>
        );
      })}
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path d={linePath} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
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

  const pushToast = (message: string, color = '#2563eb') => {
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

  // Escape dismisses the source viewer, and the page behind it must not scroll
  // while the dialog is open.
  useEffect(() => {
    if (!codeDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCodeDrawerOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [codeDrawerOpen]);

  // The local C backend (simulator.exe) only listens on plain HTTP at
  // localhost:8080. An HTTPS page can still reach it — localhost is a secure
  // context, and server.c answers Private Network Access preflights — so the
  // page probes the backend on HTTPS too. It just probes gently (once every
  // 10s) instead of every second, so a missing backend does not spam the
  // console; the moment simulator.exe answers, live polling switches on.
  // Easiest reliable setup is still running this page over http://localhost.
  const canReachLocalBackend = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.location.protocol !== 'https:';
  }, []);
  // HTTPS only: flips true once the gentle probe finds simulator.exe.
  const [httpsBackendUp, setHttpsBackendUp] = useState(false);

  // Poll 1s live metrics (tries localhost:8080 C backend first; cleanly falls back to smooth browser preview telemetry)
  useEffect(() => {
    let active = true;
    if (!canReachLocalBackend && !httpsBackendUp) {
      // HTTPS page, backend not found yet: preview telemetry + a quiet
      // probe every 10s. A successful probe flips httpsBackendUp, which
      // re-runs this effect into live polling below.
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
      const probeBackend = async () => {
        try {
          const res = await fetch('http://localhost:8080/api/hardware', { signal: AbortSignal.timeout(1500) });
          if (res.ok && active) setHttpsBackendUp(true);
        } catch {
          // simulator.exe not running yet — keep previewing, probe again soon.
        }
      };
      probeBackend();
      const probeTimer = setInterval(probeBackend, 10000);
      return () => {
        active = false;
        clearInterval(previewTimer);
        clearInterval(probeTimer);
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
      // stopReplay()/tab switches can unmount this effect between ticks; bail
      // before issuing a request that will resolve into a dead closure.
      if (!active) return;
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
        // Local C server is not answering. On HTTPS that means it went away:
        // hand back to the gentle 10s probe. Skipping this on a dev server
        // (http://localhost) would leave a 1 Hz request storm running forever.
        if (!canReachLocalBackend && active) setHttpsBackendUp(false);
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
  }, [canReachLocalBackend, httpsBackendUp]);

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
      pushToast('Add at least one process first', '#b91c1c');
      return;
    }
    stopReplay();
    setPlayTick(null);
    playProgressRef.current = 0;
    const res = runMultiCoreSimulation(processes, algorithm, cores, quantum, priorityMode);
    setSimResult(res);
    pushToast(`Simulation complete (${res.algorithm}, ${res.cores} cores)`, '#15803d');
  };

  const handleCompareAll = () => {
    if (!processes.length) {
      pushToast('Add processes in the Simulator tab first', '#b91c1c');
      return;
    }
    const cmp = compareAllAlgorithms(processes, cores, quantum, priorityMode);
    setCompareResult(cmp);
    pushToast('Compared all 5 scheduling algorithms', '#7c3aed');
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
        pushToast('Gantt replay finished', '#0e7490');
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
    pushToast(`Added process ${pid}`, '#15803d');
  };

  // Refreshes the process table from the real Win32 backend when it answers.
  // The preview list is static, so the button reports what actually happened
  // instead of always claiming a refresh succeeded.
  const [procBusy, setProcBusy] = useState(false);
  const handleRefreshProcesses = async () => {
    setProcBusy(true);
    try {
      const res = await fetch('http://localhost:8080/api/processes', { signal: AbortSignal.timeout(1500) });
      if (!res.ok) throw new Error(`Backend returned ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : data?.processes;
      if (!Array.isArray(list)) throw new Error('Unexpected response shape');
      const cleaned: OSProcess[] = list
        .map((p: { pid?: unknown; name?: unknown; memoryMB?: unknown }) => ({
          pid: Number(p.pid),
          name: String(p.name ?? 'unknown'),
          memoryMB: Number(p.memoryMB ?? 0),
        }))
        .filter((p) => Number.isFinite(p.pid) && p.pid > 0);
      if (!cleaned.length) throw new Error('No usable rows');
      setOsProcs(cleaned);
      pushToast(`Loaded ${cleaned.length} processes from the backend`, '#15803d');
    } catch {
      pushToast('Preview process list — start simulator.exe on this PC for live data', '#a16207');
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
    pushToast('Sample workload loaded (P1–P5, 2 cores, Q=3)', '#2563eb');
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
    pushToast(`Generated ${count} random processes`, '#7c3aed');
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
    pushToast('Report downloaded (cpu_scheduler_report.csv)', '#15803d');
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
      // A successful launch proves the backend is up — flip the status
      // at once, even before the next probe runs.
      setBackendConnected(true);
      if (!canReachLocalBackend) setHttpsBackendUp(true);
      pushToast(data.message, '#15803d');
    } catch {
      pushToast(
        `${names[app]} not launched — backend not reachable. Run build.bat, then simulator.exe on this Windows PC, and try again.`,
        '#b91c1c'
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

  const gaugeCirc = 2 * Math.PI * 56;

  return (
    <div className="relative min-h-screen bg-[var(--page)] text-[var(--ink)]">
      {/* Main Responsive Shell */}
      <div className="relative mx-auto max-w-[1600px] p-4 lg:p-6 grid grid-cols-1 lg:grid-cols-[268px_minmax(0,1fr)] gap-6 min-h-screen">
        {/* Floating Glass Sidebar */}
        <aside className="liquid-glass p-4 lg:sticky lg:top-6 lg:h-[calc(100vh-48px)] flex flex-col justify-between">
          <div>
            <div className="px-3 pb-4 mb-4 border-b border-[var(--border)]">
              <div className="text-[17px] font-bold tracking-tight text-[var(--ink)]">
                CoreOS Simulator
              </div>
              <div className="text-xs text-[var(--ink-subtle)] mt-1">C11 Multi-Core Engine &amp; Monitor</div>
            </div>

            <nav className="relative flex flex-row lg:flex-col gap-2 flex-wrap">
              {navItems.map((item) => {
                const active = activeTab === item.key;
                return (
                  <button
                    key={item.key}
                    onClick={() => setActiveTab(item.key)}
                    aria-current={active ? 'page' : undefined}
                    className={`relative z-10 h-11 px-3.5 rounded-[var(--radius)] flex items-center gap-3 text-sm font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                      active
                        ? 'bg-[var(--surface-sunken)] font-semibold text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="mt-4 lg:mt-0 space-y-3">
            <button
              onClick={() => setCodeDrawerOpen(true)}
              className="w-full h-11 px-4 rounded-[var(--radius)] bg-[var(--surface-muted)] hover:bg-[var(--surface-sunken)] border border-[var(--border-strong)] text-xs font-semibold text-[var(--ink)] flex items-center justify-center gap-2 cursor-pointer spring-btn whitespace-nowrap"
            >
              <Code2 className="w-4 h-4 text-[var(--cyan-ink)]" />
              <span>View Windows C11 Project (8 Files)</span>
            </button>
            <div className="p-3 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-xs text-[var(--ink-muted)] leading-relaxed">
              <div className="font-semibold text-[var(--ink)] mb-1">Windows MinGW C11 Stack</div>
              Winsock2 HTTP + Win32 Threads (`CreateThread`, `CRITICAL_SECTION`, `GetSystemTimes`).
            </div>
          </div>
        </aside>

        {/* Workspace Column */}
        <div className="flex flex-col gap-5 min-w-0">
          {/* Glass Top Bar */}
          <header className="liquid-glass px-5 py-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="text-[15px] font-semibold tracking-tight whitespace-nowrap text-[var(--ink)]">
              Multi-Core CPU Scheduling Simulator
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={() => setCodeDrawerOpen(true)}
                className="h-9 px-4 rounded-[var(--radius)] bg-[var(--surface-muted)] hover:bg-[var(--surface-sunken)] border border-[var(--border-strong)] text-xs font-semibold flex items-center gap-2 cursor-pointer spring-btn whitespace-nowrap"
              >
                <Code2 className="w-3.5 h-3.5 text-[var(--cyan-ink)]" />
                <span>C11 Source Files</span>
              </button>
              <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-[var(--radius)] bg-[var(--surface-muted)] border border-[var(--border)] text-xs font-semibold whitespace-nowrap">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${
                    backendConnected
                      ? 'bg-[var(--green-ink)] '
                      : 'bg-[var(--red)] '
                  }`}
                />
                <span>
                  {backendConnected
                    ? 'Backend connected'
                    : canReachLocalBackend
                      ? 'Disconnected (Browser Preview)'
                      : 'Browser Preview (local backend needs http://localhost)'}
                </span>
              </div>
            </div>
          </header>

          {/* ================= TAB 1: SCHEDULING SIMULATOR ================= */}
          {activeTab === 'scheduler' && (
            <div className="flex flex-col gap-5">
              {/* Hero Card with 4 Animated Glowing Cores */}
              <div className="liquid-glass p-6 grid grid-cols-1 xl:grid-cols-[1.35fr_1fr] gap-6 items-center">
                <div>
                  <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-[var(--ink-subtle)] mb-2">
                    Operating Systems · Multi-Core Engine
                  </div>
                  <h1 className="text-2xl lg:text-3xl font-bold tracking-tight leading-tight mb-2">
                    Multi-Core CPU Scheduling Simulator
                  </h1>
                  <p className="text-sm text-[var(--ink-muted)] leading-relaxed max-w-[56ch]">
                    Simulate FCFS, SJF, SRTF, Priority, and Round Robin across 1–8 CPU cores with real-time tick replay,
                    per-core utilization metrics, and exact Windows C11 thread synchronization.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {Array.from({ length: Math.min(4, simResult.cores) }, (_, i) => {
                    const core = simResult.metrics.coreUtilization[i];
                    const busy = (core?.utilization ?? 0) > 0;
                    return (
                      <div
                        key={i}
                        className={`p-3 rounded-[var(--radius)] bg-[var(--surface-muted)] border border-[var(--border)] flex flex-col items-center gap-1.5 text-[11px] font-semibold tracking-wide ${
                          busy ? 'text-[var(--ink)]' : 'text-[var(--ink-subtle)]'
                        }`}
                      >
                        <Cpu
                          className="w-6 h-6"
                          style={{ color: busy ? 'var(--blue-ink)' : 'var(--border-strong)' }}
                        />
                        <span>CORE {i}</span>
                        <span className="text-[10px] font-medium tabular-nums text-[var(--ink-subtle)]">
                          {(core?.utilization ?? 0).toFixed(0)}%
                        </span>
                      </div>
                    );
                  })}
                  {simResult.cores > 4 && (
                    <div className="col-span-2 p-2 rounded-[var(--radius)] bg-[var(--surface-muted)] border border-[var(--border)] text-center text-[11px] font-semibold text-[var(--ink-subtle)]">
                      +{simResult.cores - 4} more cores
                    </div>
                  )}
                </div>
              </div>

              {/* Config & Process Builder */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                <div className="liquid-glass liquid-card-hover p-6">
                  <div className="mb-4">
                    <h2 className="text-[17px] font-bold">Simulation Parameters</h2>
                    <p className="text-xs text-[var(--ink-muted)] mt-0.5">Select algorithm, cores, quantum, and priority preemption</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-xs font-semibold text-[var(--ink-muted)] block mb-1.5">Algorithm</span>
                      <select
                        value={algorithm}
                        onChange={(e) => setAlgorithm(e.target.value as AlgorithmType)}
                        className="w-full h-10 px-3 rounded-lg bg-white border border-[var(--border)] text-sm text-[var(--ink)] outline-none focus:border-[var(--blue)] focus:ring-2 focus:ring-[var(--blue)]/25"
                      >
                        <option value="FCFS">FCFS (Non-Preemptive)</option>
                        <option value="SJF">SJF (Non-Preemptive)</option>
                        <option value="SRTF">SRTF (Preemptive)</option>
                        <option value="Priority">Priority Scheduling</option>
                        <option value="Round Robin">Round Robin</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-[var(--ink-muted)] block mb-1.5">CPU Cores (1–8)</span>
                      <input
                        type="number"
                        min={1}
                        max={MAX_CORES}
                        value={cores}
                        onChange={(e) => setCores(Math.min(MAX_CORES, Math.max(1, Number(e.target.value) || 1)))}
                        className="w-full h-10 px-3 rounded-lg bg-white border border-[var(--border)] text-sm text-[var(--ink)] tabular-nums outline-none focus:border-[var(--blue)] focus:ring-2 focus:ring-[var(--blue)]/25"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-[var(--ink-muted)] block mb-1.5">Time Quantum (RR)</span>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={quantum}
                        onChange={(e) => setQuantum(Math.max(1, Number(e.target.value) || 1))}
                        className="w-full h-10 px-3 rounded-lg bg-white border border-[var(--border)] text-sm text-[var(--ink)] tabular-nums outline-none focus:border-[var(--blue)] focus:ring-2 focus:ring-[var(--blue)]/25"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-[var(--ink-muted)] block mb-1.5">Priority Mode</span>
                      <select
                        value={priorityMode}
                        onChange={(e) => setPriorityMode(e.target.value as PriorityMode)}
                        className="w-full h-10 px-3 rounded-lg bg-white border border-[var(--border)] text-sm text-[var(--ink)] outline-none focus:border-[var(--blue)] focus:ring-2 focus:ring-[var(--blue)]/25"
                      >
                        <option value="preemptive">Preemptive</option>
                        <option value="non-preemptive">Non-Preemptive</option>
                      </select>
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-2.5 mt-5">
                    <button
                      onClick={handleRunSimulation}
                      className="h-11 px-5 rounded-[var(--radius)] text-sm font-semibold text-white flex items-center gap-2 cursor-pointer spring-btn whitespace-nowrap"
                      style={{ background: 'var(--blue)' }}
                    >
                      <Play className="w-4 h-4 fill-current" />
                      <span>Run Simulation</span>
                    </button>
                    <button
                      onClick={handleLoadSample}
                      className="h-11 px-4 rounded-[var(--radius)] bg-[var(--surface-muted)] hover:bg-[var(--surface-sunken)] border border-[var(--border-strong)] text-sm font-semibold flex items-center gap-2 cursor-pointer spring-btn whitespace-nowrap"
                    >
                      <Sparkles className="w-4 h-4 text-[var(--cyan-ink)]" />
                      <span>Load Sample Data</span>
                    </button>
                    <button
                      onClick={handleRandomize}
                      className="h-11 px-4 rounded-[var(--radius)] bg-[var(--surface-muted)] hover:bg-[var(--surface-sunken)] border border-[var(--border-strong)] text-sm font-semibold flex items-center gap-2 cursor-pointer spring-btn whitespace-nowrap"
                    >
                      <Shuffle className="w-4 h-4 text-[var(--purple-ink)]" />
                      <span>Random Generator</span>
                    </button>
                  </div>
                </div>

                {/* Add / Manage Processes */}
                <div className="liquid-glass liquid-card-hover p-6">
                  <div className="mb-4 flex items-center justify-between gap-2">
                    <div>
                      <h2 className="text-[17px] font-bold">Process Queue ({processes.length})</h2>
                      <p className="text-xs text-[var(--ink-muted)] mt-0.5">Lower priority number = higher urgency</p>
                    </div>
                    <button
                      onClick={() => setProcesses([])}
                      className="h-8 px-3 rounded-[var(--radius)] bg-[var(--surface-muted)] hover:bg-[var(--surface-sunken)] border border-[var(--border)] text-xs font-semibold cursor-pointer spring-btn"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="grid grid-cols-4 gap-2.5">
                    <label className="block">
                      <span className="text-[11px] font-semibold text-[var(--ink-muted)] block mb-1">PID</span>
                      <input
                        value={newPid}
                        onChange={(e) => setNewPid(e.target.value)}
                        className="w-full h-10 px-3 rounded-lg bg-white border border-[var(--border)] text-sm text-[var(--ink)] outline-none focus:border-[var(--blue)]"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] font-semibold text-[var(--ink-muted)] block mb-1">Arrival</span>
                      <input
                        type="number"
                        min={0}
                        value={newArrival}
                        onChange={(e) => setNewArrival(Number(e.target.value))}
                        className="w-full h-10 px-3 rounded-lg bg-white border border-[var(--border)] text-sm text-[var(--ink)] tabular-nums outline-none focus:border-[var(--blue)]"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] font-semibold text-[var(--ink-muted)] block mb-1">Burst</span>
                      <input
                        type="number"
                        min={1}
                        value={newBurst}
                        onChange={(e) => setNewBurst(Number(e.target.value))}
                        className="w-full h-10 px-3 rounded-lg bg-white border border-[var(--border)] text-sm text-[var(--ink)] tabular-nums outline-none focus:border-[var(--blue)]"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] font-semibold text-[var(--ink-muted)] block mb-1">Priority</span>
                      <input
                        type="number"
                        min={1}
                        value={newPriority}
                        onChange={(e) => setNewPriority(Number(e.target.value))}
                        className="w-full h-10 px-3 rounded-lg bg-white border border-[var(--border)] text-sm text-[var(--ink)] tabular-nums outline-none focus:border-[var(--blue)]"
                      />
                    </label>
                  </div>
                  <div className="mt-3">
                    <button
                      onClick={handleAddProcess}
                      className="h-9 px-4 rounded-[var(--radius)] bg-[var(--surface-muted)] hover:bg-[var(--green-soft)] border border-[var(--border-strong)] text-xs font-semibold text-[var(--ink)] inline-flex items-center gap-1.5 cursor-pointer spring-btn"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Process</span>
                    </button>
                  </div>
                  <div className="mt-3 max-h-[168px] overflow-y-auto">
                    <table className="w-full text-sm tabular-nums">
                      <thead>
                        <tr className="text-left text-xs text-[var(--ink-subtle)] border-b border-[var(--border)]">
                          <th className="py-2 pr-2">PID</th>
                          <th className="py-2 px-2">Arrival</th>
                          <th className="py-2 px-2">Burst</th>
                          <th className="py-2 px-2">Priority</th>
                          <th className="py-2 pl-2 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {processes.map((p, idx) => (
                          <tr key={`${p.pid}-${idx}`} className="border-b border-[var(--border)] hover:bg-[var(--surface-muted)]">
                            <td className="py-2 pr-2 font-semibold flex items-center gap-2">
                              <span
                                className="w-2.5 h-2.5 rounded-full inline-block"
                                style={{ background: PROC_SOLID[pidColorIndex[p.pid] ?? 0] }}
                              />
                              {p.pid}
                            </td>
                            <td className="py-2 px-2">{p.arrival}</td>
                            <td className="py-2 px-2">{p.burst}</td>
                            <td className="py-2 px-2">{p.priority}</td>
                            <td className="py-2 pl-2 text-right">
                              <button
                                onClick={() => setProcesses((prev) => prev.filter((_, i) => i !== idx))}
                                className="text-[var(--red-ink)] hover:text-[var(--red-ink)] p-1 cursor-pointer"
                                title="Remove process"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                        {!processes.length && (
                          <tr>
                            <td colSpan={5} className="py-5 text-center text-xs text-[var(--ink-subtle)]">
                              Queue is empty. Add processes or click Load Sample Data.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Live Core Cards */}
              <div className="liquid-glass liquid-card-hover p-6">
                <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                  <div>
                    <h2 className="text-[17px] font-bold">Live Multi-Core Execution Units</h2>
                    <p className="text-xs text-[var(--ink-muted)] mt-0.5 tabular-nums">
                      {activeSnap
                        ? `Live Tick ${activeSnap.tick} · Ready Queue: ${
                            activeSnap.readyQueue.length ? activeSnap.readyQueue.join(', ') : 'Empty'
                          } · Completed: ${activeSnap.completed}/${simResult.processes.length}`
                        : 'Press Play Replay to animate processes moving across cores in real time'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleTogglePlay}
                      className="h-9 px-4 rounded-[var(--radius)] text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer spring-btn"
                      style={{ background: 'var(--blue)' }}
                    >
                      {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                      <span>{isPlaying ? 'Pause' : 'Play Replay'}</span>
                    </button>
                    <button
                      onClick={handleResetReplay}
                      className="h-9 px-3.5 rounded-[var(--radius)] bg-[var(--surface-muted)] hover:bg-[var(--surface-sunken)] border border-[var(--border)] text-xs font-semibold flex items-center gap-1.5 cursor-pointer spring-btn"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Reset</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3.5">
                  {simResult.metrics.coreUtilization.map((c) => {
                    const livePid = activeSnap ? activeSnap.cores[c.core] : c.busyTime > 0 ? 'ACTIVE' : 'IDLE';
                    const isBusy = livePid !== 'IDLE';
                    return (
                      <div
                        key={c.core}
                        className={`p-4 rounded-[var(--radius)] bg-[var(--surface-muted)] border transition-all duration-300 ${
                          isBusy
                            ? 'border-[var(--blue)] core-busy-pulse'
                            : 'border-[var(--border)] opacity-60'
                        }`}
                      >
                        <div className="flex items-center justify-between text-xs font-bold text-[var(--ink-muted)] mb-2">
                          <span>CORE {c.core}</span>
                          <span className="text-[var(--cyan-ink)] tabular-nums">{c.utilization.toFixed(1)}%</span>
                        </div>
                        <div
                          className="text-xl font-extrabold tracking-tight mb-2.5"
                          style={{
                            color:
                              livePid !== 'IDLE' && livePid !== 'ACTIVE'
                                ? PROC_SOLID[pidColorIndex[livePid] ?? 0]
                                : isBusy
                                ? 'var(--ink)'
                                : 'var(--ink-subtle)',
                          }}
                        >
                          {livePid}
                        </div>
                        <div className="h-1.5 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
                          <div
                            className="h-full rounded-[var(--radius)] transition-all duration-500"
                            style={{
                              width: `${Math.min(100, c.utilization)}%`,
                              background: 'var(--blue)',
                            }}
                          />
                        </div>
                        <div className="text-[11px] text-[var(--ink-subtle)] mt-2 tabular-nums">
                          Busy {c.busyTime}t · Idle {c.idleTime}t
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Multi-Core Gantt Chart */}
              <div className="liquid-glass liquid-card-hover p-6">
                <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                  <div>
                    <h2 className="text-[17px] font-bold">Multi-Core Gantt Timeline</h2>
                    <p className="text-xs text-[var(--ink-muted)] mt-0.5">
                      {simResult.algorithm}
                      {simResult.algorithm === 'Priority' ? ` (${simResult.priorityMode})` : ''} · {simResult.cores}{' '}
                      Cores · Makespan {simResult.metrics.makespan} ticks
                    </p>
                  </div>
                  <div className="text-xs font-bold text-[var(--cyan-ink)] tabular-nums">
                    Tick: {playTick !== null ? playTick.toFixed(1) : '0.0'} / {simResult.metrics.makespan}
                  </div>
                </div>

                <div className="overflow-x-auto pb-2">
                  <div className="relative min-w-[660px]">
                    {/* Playhead: 2px marker aligned to the row grid's track column */}
                    {playTick !== null && simResult.metrics.makespan > 0 && (
                      <div className="absolute top-0 bottom-6 left-[76px] right-0 pointer-events-none z-20">
                        <div
                          className="absolute top-0 bottom-0 w-0.5 -translate-x-px bg-[var(--ink)]"
                          style={{
                            left: `${Math.min(100, (playTick / simResult.metrics.makespan) * 100)}%`,
                            opacity: 0.75,
                          }}
                        />
                      </div>
                    )}

                    {Array.from({ length: simResult.cores }, (_, c) => {
                      const segs = simResult.gantt.filter((s) => s.core === c);
                      const makespan = simMakespan;
                      return (
                        <div key={c} className="grid grid-cols-[76px_1fr] items-center gap-3 mb-2.5">
                          <div className="text-xs font-bold text-[var(--ink-muted)] text-right">CORE {c}</div>
                          <div className="relative h-10 rounded-lg bg-[var(--surface-sunken)] border border-[var(--border)] overflow-hidden">
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
                                  className={`absolute top-1 bottom-1 rounded-md flex items-center justify-center text-xs font-bold px-1 overflow-hidden whitespace-nowrap gantt-grow transition-[opacity,filter] duration-200 ${
                                    s.idle
                                      ? 'gantt-idle-stripe text-[var(--ink-subtle)] border border-dashed border-[var(--border)]'
                                      : 'text-white shadow-sm'
                                  } ${dimmed ? 'opacity-25 saturate-50' : ''} ${
                                    lit ? 'ring-2 ring-[var(--ink)] z-10' : ''
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
                    <div className="grid grid-cols-[76px_1fr] gap-3 mt-1.5">
                      <div />
                      <div className="relative h-5 text-[11px] text-[var(--ink-subtle)] tabular-nums">
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
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
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
                  <div key={k.label} className="liquid-glass p-4 shadow-none">
                    <div className="text-xs font-semibold text-[var(--ink-muted)] mb-1">{k.label}</div>
                    <div className="text-2xl font-extrabold tracking-tight">
                      <AnimatedNumber value={k.val} decimals={k.dec} suffix={k.suf} />
                    </div>
                    <div className="text-[11px] text-[var(--ink-subtle)] mt-1">{k.hint}</div>
                  </div>
                ))}
              </div>

              {/* Per-Process Results Table */}
              <div className="liquid-glass liquid-card-hover p-6">
                <h2 className="text-[17px] font-bold mb-1">Per-Process Scheduling Metrics</h2>
                <p className="text-xs text-[var(--ink-muted)] mb-4">Exact Module 3 timing formulas</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm tabular-nums">
                    <thead>
                      <tr className="text-left text-xs text-[var(--ink-muted)] border-b border-[var(--border)]">
                        <th className="py-2.5 pr-3">PID</th>
                        <th className="py-2.5 px-3">Arrival</th>
                        <th className="py-2.5 px-3">Burst</th>
                        <th className="py-2.5 px-3">Priority</th>
                        <th className="py-2.5 px-3">First Start</th>
                        <th className="py-2.5 px-3">Completion</th>
                        <th className="py-2.5 px-3">Turnaround</th>
                        <th className="py-2.5 px-3">Waiting</th>
                        <th className="py-2.5 pl-3">Response</th>
                      </tr>
                    </thead>
                    <tbody>
                      {simResult.processes.map((p, idx) => (
                        <tr key={`${p.pid}-${idx}`} className="border-b border-[var(--border)] hover:bg-[var(--surface-muted)]">
                          <td className="py-2.5 pr-3 font-bold flex items-center gap-2">
                            <span
                              className="w-2.5 h-2.5 rounded-full"
                              style={{ background: PROC_SOLID[pidColorIndex[p.pid] ?? 0] }}
                            />
                            {p.pid}
                          </td>
                          <td className="py-2.5 px-3">{p.arrival}</td>
                          <td className="py-2.5 px-3">{p.burst}</td>
                          <td className="py-2.5 px-3">{p.priority}</td>
                          <td className="py-2.5 px-3">{p.firstStart}</td>
                          <td className="py-2.5 px-3">{p.completion}</td>
                          <td className="py-2.5 px-3 font-bold text-[var(--cyan-ink)]">{p.turnaround}</td>
                          <td className="py-2.5 px-3">{p.waiting}</td>
                          <td className="py-2.5 pl-3">{p.response}</td>
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
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="liquid-glass liquid-card-hover p-5">
                  <div className="text-xs font-semibold text-[var(--ink-muted)]">Processor Model (Win32 Registry)</div>
                  <div className="text-base font-bold mt-2 leading-snug">{hwInfo.cpuModel}</div>
                </div>
                <div className="liquid-glass liquid-card-hover p-5">
                  <div className="text-xs font-semibold text-[var(--ink-muted)]">Physical Cores</div>
                  <div className="text-3xl font-extrabold mt-1 tabular-nums">{hwInfo.physicalCores}</div>
                  <div className="text-[11px] text-[var(--ink-subtle)] mt-1">GetLogicalProcessorInformation</div>
                </div>
                <div className="liquid-glass liquid-card-hover p-5">
                  <div className="text-xs font-semibold text-[var(--ink-muted)]">Logical Processors</div>
                  <div className="text-3xl font-extrabold mt-1 tabular-nums">{hwInfo.logicalProcessors}</div>
                  <div className="text-[11px] text-[var(--ink-subtle)] mt-1">Hardware execution threads</div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Circular CPU Gauge */}
                <div className="liquid-glass liquid-card-hover p-6 flex items-center gap-6 flex-wrap">
                  <div className="relative w-36 h-36 shrink-0">
                    <svg className="w-36 h-36 -rotate-90" viewBox="0 0 140 140">
                      <defs>
                        <linearGradient id="cpuGaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="#2563eb" />
                          <stop offset="100%" stopColor="#0e7490" />
                        </linearGradient>
                      </defs>
                      <circle cx="70" cy="70" r="56" fill="none" stroke="rgba(15,23,42,0.10)" strokeWidth="12" />
                      <circle
                        cx="70"
                        cy="70"
                        r="56"
                        fill="none"
                        stroke="url(#cpuGaugeGrad)"
                        strokeWidth="12"
                        strokeLinecap="round"
                        strokeDasharray={gaugeCirc}
                        strokeDashoffset={gaugeCirc * (1 - liveCpu / 100)}
                        className="transition-all duration-500"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <div className="text-2xl font-extrabold">
                        <AnimatedNumber value={liveCpu} decimals={1} suffix="%" />
                      </div>
                      <div className="text-[11px] text-[var(--ink-muted)] font-semibold">CPU Load</div>
                    </div>
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <h3 className="text-base font-bold">Live System CPU Utilization</h3>
                    <p className="text-xs text-[var(--ink-muted)] mt-1.5 leading-relaxed">
                      Calculated every 1 second via Windows <code className="text-[var(--cyan-ink)]">GetSystemTimes</code> delta
                      across idle, kernel, and user time counters.
                    </p>
                  </div>
                </div>

                {/* Circular RAM Gauge */}
                <div className="liquid-glass liquid-card-hover p-6 flex items-center gap-6 flex-wrap">
                  <div className="relative w-36 h-36 shrink-0">
                    <svg className="w-36 h-36 -rotate-90" viewBox="0 0 140 140">
                      <defs>
                        <linearGradient id="ramGaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="#7c3aed" />
                          <stop offset="100%" stopColor="#c2410c" />
                        </linearGradient>
                      </defs>
                      <circle cx="70" cy="70" r="56" fill="none" stroke="rgba(15,23,42,0.10)" strokeWidth="12" />
                      <circle
                        cx="70"
                        cy="70"
                        r="56"
                        fill="none"
                        stroke="url(#ramGaugeGrad)"
                        strokeWidth="12"
                        strokeLinecap="round"
                        strokeDasharray={gaugeCirc}
                        strokeDashoffset={gaugeCirc * (1 - liveRamPct / 100)}
                        className="transition-all duration-500"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <div className="text-2xl font-extrabold">
                        <AnimatedNumber value={liveRamPct} decimals={1} suffix="%" />
                      </div>
                      <div className="text-[11px] text-[var(--ink-muted)] font-semibold">Memory</div>
                    </div>
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <h3 className="text-base font-bold">Live Physical Memory (RAM)</h3>
                    <div className="text-sm font-semibold text-[var(--ink)] mt-1.5 tabular-nums">
                      {liveRamUsedGB.toFixed(2)} GB / {liveRamTotalGB.toFixed(2)} GB used
                    </div>
                    <p className="text-xs text-[var(--ink-muted)] mt-1">
                      Observed via Windows <code className="text-[var(--purple-ink)]">GlobalMemoryStatusEx</code>.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="liquid-glass liquid-card-hover p-6">
                  <h3 className="text-base font-bold mb-1">CPU Utilization — Last 60 Seconds</h3>
                  <p className="text-xs text-[var(--ink-subtle)] mb-4">1 Hz live rolling window</p>
                  <LiveSparkChart data={cpuSeries} stroke="#2563eb" gradientId="cpuAreaFill" />
                </div>
                <div className="liquid-glass liquid-card-hover p-6">
                  <h3 className="text-base font-bold mb-1">RAM Utilization — Last 60 Seconds</h3>
                  <p className="text-xs text-[var(--ink-subtle)] mb-4">1 Hz live rolling window</p>
                  <LiveSparkChart data={ramSeries} stroke="#7c3aed" gradientId="ramAreaFill" />
                </div>
              </div>
            </div>
          )}

          {/* ================= TAB 3: PROCESS MONITOR ================= */}
          {activeTab === 'processes' && (
            <div className="flex flex-col gap-5">
              <div className="liquid-glass liquid-card-hover p-6">
                <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                  <div>
                    <h2 className="text-[17px] font-bold">Approved Application Launcher (Hardcoded Whitelist)</h2>
                    <p className="text-xs text-[var(--ink-muted)] mt-0.5">
                      Spawns only verified executables via <code className="text-[var(--cyan-ink)]">CreateProcessA</code> + optional{' '}
                      <code className="text-[var(--purple-ink)]">SetProcessAffinityMask</code>
                    </p>
                    <p className="text-xs mt-1.5 font-semibold">
                      {backendConnected ? (
                        <span className="text-[var(--green-ink)]">Backend connected (localhost:8080) — launches are real.</span>
                      ) : (
                        <span className="text-[var(--orange-ink)]">Backend not connected — nothing will launch until simulator.exe is running on this PC.</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <span className="text-xs font-semibold text-[var(--ink-muted)]">Pin to Core:</span>
                    <select
                      value={pinCore}
                      onChange={(e) => setPinCore(Number(e.target.value))}
                      className="h-9 px-3 rounded-lg bg-white border border-[var(--border)] text-xs text-[var(--ink)] outline-none focus:border-[var(--blue)]"
                    >
                      <option value={-1}>OS Default (Auto)</option>
                      {Array.from({ length: Math.min(MAX_CORES, hwInfo.logicalProcessors) }, (_, i) => (
                        <option key={i} value={i}>
                          Core {i}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2.5">
                  <button
                    onClick={() => handleLaunchApp('chrome')}
                    className="h-10 px-5 rounded-[var(--radius)] text-xs font-semibold text-white cursor-pointer spring-btn"
                    style={{ background: '#2563eb' }}
                  >
                    Launch Chrome
                  </button>
                  <button
                    onClick={() => handleLaunchApp('vscode')}
                    className="h-10 px-5 rounded-[var(--radius)] text-xs font-semibold text-white cursor-pointer spring-btn"
                    style={{ background: '#7c3aed' }}
                  >
                    Launch VS Code
                  </button>
                  <button
                    onClick={() => handleLaunchApp('notepad')}
                    className="h-10 px-5 rounded-[var(--radius)] bg-[var(--surface-muted)] border border-[var(--border-strong)] text-xs font-semibold text-[var(--ink)] cursor-pointer spring-btn"
                  >
                    Launch Notepad
                  </button>
                  <button
                    onClick={() => handleLaunchApp('calculator')}
                    className="h-10 px-5 rounded-[var(--radius)] bg-[var(--surface-muted)] border border-[var(--border-strong)] text-xs font-semibold text-[var(--ink)] cursor-pointer spring-btn"
                  >
                    Launch Calculator
                  </button>
                </div>
              </div>

              <div className="liquid-glass liquid-card-hover p-6">
                <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                  <div>
                    <h2 className="text-[17px] font-bold">
                      Running Windows Processes (<span className="tabular-nums">{filteredOsProcs.length}</span>)
                    </h2>
                    <p className="text-xs text-[var(--ink-muted)] mt-0.5">
                      Toolhelp32Snapshot + GetProcessMemoryInfo (click columns to sort)
                    </p>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <div className="relative">
                      <Search className="w-4 h-4 text-[var(--ink-subtle)] absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        value={procSearch}
                        onChange={(e) => setProcSearch(e.target.value)}
                        placeholder="Search process or PID..."
                        className="h-9 pl-9 pr-3.5 rounded-[var(--radius)] bg-white border border-[var(--border)] text-xs text-[var(--ink)] outline-none focus:border-[var(--blue)] w-56"
                      />
                    </div>
                    <button
                      onClick={handleRefreshProcesses}
                      disabled={procBusy}
                      className="h-9 px-3.5 rounded-[var(--radius)] bg-[var(--surface-muted)] hover:bg-[var(--surface-sunken)] disabled:opacity-60 disabled:cursor-progress border border-[var(--border)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer spring-btn"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${procBusy ? 'animate-spin' : ''}`} />
                      <span>{procBusy ? 'Refreshing…' : 'Refresh'}</span>
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto max-h-[420px]">
                  <table className="w-full text-sm tabular-nums">
                    <thead>
                      <tr className="text-left text-xs text-[var(--ink-muted)] border-b border-[var(--border)]">
                        <th
                          onClick={() =>
                            setProcSort((s) => ({ key: 'name', dir: s.key === 'name' ? (s.dir === 1 ? -1 : 1) : 1 }))
                          }
                          className="py-2.5 pr-4 cursor-pointer hover:text-[var(--ink)] select-none"
                        >
                          Process Name ↕
                        </th>
                        <th
                          onClick={() =>
                            setProcSort((s) => ({ key: 'pid', dir: s.key === 'pid' ? (s.dir === 1 ? -1 : 1) : 1 }))
                          }
                          className="py-2.5 px-4 cursor-pointer hover:text-[var(--ink)] select-none"
                        >
                          PID ↕
                        </th>
                        <th
                          onClick={() =>
                            setProcSort((s) => ({
                              key: 'memoryMB',
                              dir: s.key === 'memoryMB' ? (s.dir === 1 ? -1 : 1) : -1,
                            }))
                          }
                          className="py-2.5 pl-4 cursor-pointer hover:text-[var(--ink)] select-none"
                        >
                          Working Set Memory (MB) ↕
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOsProcs.map((p) => (
                        <tr
                          key={p.pid}
                          className={`border-b border-[var(--border)] hover:bg-[var(--surface-muted)] transition-colors ${
                            p.isNew ? 'bg-[var(--green-soft)]' : ''
                          }`}
                        >
                          <td className="py-2.5 pr-4 font-semibold">{p.name}</td>
                          <td className="py-2.5 px-4 text-[var(--ink-muted)]">{p.pid}</td>
                          <td className="py-2.5 pl-4 font-medium">{p.memoryMB.toFixed(2)} MB</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ================= TAB 4: PERFORMANCE ANALYTICS ================= */}
          {activeTab === 'analytics' && (
            <div className="flex flex-col gap-5">
              <div className="liquid-glass liquid-card-hover p-6 flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <h2 className="text-[17px] font-bold">Multi-Algorithm Comparative Analysis</h2>
                  <p className="text-xs text-[var(--ink-muted)] mt-0.5">
                    Runs all 5 scheduling algorithms on the identical workload ({processes.length} processes, {cores} cores, Q=
                    {quantum})
                  </p>
                </div>
                <div className="flex flex-wrap gap-2.5">
                  <button
                    onClick={handleCompareAll}
                    className="h-10 px-5 rounded-[var(--radius)] text-xs font-semibold text-white cursor-pointer spring-btn"
                    style={{ background: 'var(--blue)' }}
                  >
                    Compare All Algorithms
                  </button>
                  <button
                    onClick={handleDownloadCsv}
                    className="h-10 px-5 rounded-[var(--radius)] bg-[var(--surface-muted)] hover:bg-[var(--green-soft)] border border-[var(--border-strong)] text-xs font-semibold text-[var(--ink)] inline-flex items-center gap-2 cursor-pointer spring-btn"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download CSV Report</span>
                  </button>
                </div>
              </div>

              <div className="liquid-glass liquid-card-hover p-6">
                <h3 className="text-base font-bold mb-1">Comparative Metrics Matrix</h3>
                <p className="text-xs text-[var(--ink-muted)] mb-4">Best algorithm for each metric is highlighted in green</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm tabular-nums">
                    <thead>
                      <tr className="text-left text-xs text-[var(--ink-muted)] border-b border-[var(--border)]">
                        <th className="py-2.5 pr-3">Algorithm</th>
                        <th className="py-2.5 px-3">Avg Waiting ↓</th>
                        <th className="py-2.5 px-3">Avg Turnaround ↓</th>
                        <th className="py-2.5 px-3">Avg Response ↓</th>
                        <th className="py-2.5 px-3">CPU Util ↑</th>
                        <th className="py-2.5 px-3">Throughput ↑</th>
                        <th className="py-2.5 px-3">Context Switches ↓</th>
                        <th className="py-2.5 pl-3">Makespan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compareResult.results.map((r) => {
                        const m = r.metrics;
                        const b = compareResult.best;
                        return (
                          <tr key={r.algorithm} className="border-b border-[var(--border)] hover:bg-[var(--surface-muted)]">
                            <td className="py-3 pr-3 font-bold">{r.algorithm}</td>
                            <td className={`py-3 px-3 ${r.algorithm === b.avgWaiting ? 'text-[var(--green-ink)] font-extrabold' : ''}`}>
                              {m.avgWaiting.toFixed(2)} {r.algorithm === b.avgWaiting && '★'}
                            </td>
                            <td className={`py-3 px-3 ${r.algorithm === b.avgTurnaround ? 'text-[var(--green-ink)] font-extrabold' : ''}`}>
                              {m.avgTurnaround.toFixed(2)} {r.algorithm === b.avgTurnaround && '★'}
                            </td>
                            <td className={`py-3 px-3 ${r.algorithm === b.avgResponse ? 'text-[var(--green-ink)] font-extrabold' : ''}`}>
                              {m.avgResponse.toFixed(2)} {r.algorithm === b.avgResponse && '★'}
                            </td>
                            <td className={`py-3 px-3 ${r.algorithm === b.cpuUtilization ? 'text-[var(--green-ink)] font-extrabold' : ''}`}>
                              {m.cpuUtilization.toFixed(2)}% {r.algorithm === b.cpuUtilization && '★'}
                            </td>
                            <td className="py-3 px-3">{m.throughput.toFixed(4)}</td>
                            <td className={`py-3 px-3 ${r.algorithm === b.contextSwitches ? 'text-[var(--green-ink)] font-extrabold' : ''}`}>
                              {m.contextSwitches} {r.algorithm === b.contextSwitches && '★'}
                            </td>
                            <td className="py-3 pl-3">{m.makespan}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Clean Visual Bar Comparisons */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="liquid-glass liquid-card-hover p-6">
                  <h3 className="text-base font-bold mb-4">Average Waiting, Turnaround &amp; Response Time</h3>
                  <div className="space-y-4">
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
                          <div className="flex justify-between text-xs font-semibold mb-1.5">
                            <span>{r.algorithm}</span>
                            <span className="text-[var(--ink-muted)] tabular-nums">
                              WT {r.metrics.avgWaiting.toFixed(2)} · TAT {r.metrics.avgTurnaround.toFixed(2)} · RT{' '}
                              {r.metrics.avgResponse.toFixed(2)}
                            </span>
                          </div>
                          <div className="space-y-1">
                            <div className="h-2 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
                              <div
                                className="h-full rounded-full bg-[var(--blue)] transition-all duration-500"
                                style={{ width: `${(r.metrics.avgWaiting / maxVal) * 100}%` }}
                              />
                            </div>
                            <div className="h-2 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
                              <div
                                className="h-full rounded-full bg-[var(--purple-ink)] transition-all duration-500"
                                style={{ width: `${(r.metrics.avgTurnaround / maxVal) * 100}%` }}
                              />
                            </div>
                            <div className="h-2 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
                              <div
                                className="h-full rounded-full bg-[var(--orange-ink)] transition-all duration-500"
                                style={{ width: `${(r.metrics.avgResponse / maxVal) * 100}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                  <div className="flex gap-4 mt-4 text-[11px] text-[var(--ink-muted)]">
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--blue)]" />Avg Waiting</span>
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--purple)]" />Avg Turnaround</span>
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--orange)]" />Avg Response</span>
                  </div>
                </div>

                <div className="liquid-glass liquid-card-hover p-6">
                  <h3 className="text-base font-bold mb-4">CPU Utilization (%) &amp; Context Switches</h3>
                  <div className="space-y-4">
                    {(() => {
                      const maxCs = Math.max(1, ...compareResult.results.map((r) => r.metrics.contextSwitches));
                      return compareResult.results.map((r) => (
                        <div key={r.algorithm}>
                          <div className="flex justify-between text-xs font-semibold mb-1.5">
                            <span>{r.algorithm}</span>
                            <span className="text-[var(--ink-muted)] tabular-nums">
                              CPU {r.metrics.cpuUtilization.toFixed(1)}% · CS {r.metrics.contextSwitches}
                            </span>
                          </div>
                          <div className="space-y-1">
                            <div className="h-2.5 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
                              <div
                                className="h-full rounded-full bg-[var(--green-ink)] transition-all duration-500"
                                style={{ width: `${Math.min(100, r.metrics.cpuUtilization)}%` }}
                              />
                            </div>
                            <div className="h-2 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
                              <div
                                className="h-full rounded-full bg-[var(--red-ink)] transition-all duration-500"
                                style={{ width: `${(r.metrics.contextSwitches / maxCs) * 100}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                  <div className="flex gap-4 mt-4 text-[11px] text-[var(--ink-muted)]">
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--green-ink)]" />CPU Utilization %</span>
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--red-ink)]" />Context Switches</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Mandatory Footer Note */}
          <footer className="liquid-glass px-5 py-3.5 text-center text-xs text-[var(--ink-muted)]">
            The agent observes real Windows activity. The simulator models scheduling independently and does not control the Windows kernel scheduler.
          </footer>
        </div>
      </div>

      {/* Windows C11 Project Source Modal */}
      {codeDrawerOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4"
          onClick={() => setCodeDrawerOpen(false)}
        >
          <div
            className="liquid-glass w-full max-w-6xl h-[86vh] flex flex-col overflow-hidden bg-white shadow-[var(--shadow-raised)]"
            role="dialog"
            aria-modal="true"
            aria-label="Windows C11 project bundle"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[var(--border)] flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold">Windows C11 / MinGW Project Bundle (8 Files)</h2>
                <p className="text-xs text-[var(--ink-muted)]">
                  Compile with: <code className="text-[var(--cyan-ink)]">gcc server.c scheduler.c monitor.c -o simulator.exe -lws2_32 -lpsapi -ladvapi32</code>
                </p>
              </div>
              <button
                onClick={() => setCodeDrawerOpen(false)}
                aria-label="Close source viewer"
                className="w-9 h-9 rounded-lg border border-[var(--border)] bg-white hover:bg-[var(--surface-sunken)] text-[var(--ink-muted)] hover:text-[var(--ink)] flex items-center justify-center cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 grid grid-cols-1 md:grid-cols-[240px_1fr] min-h-0">
              <div className="border-r border-[var(--border)] p-3 overflow-y-auto space-y-1.5">
                {C_PROJECT_FILES.map((f) => (
                  <button
                    key={f.name}
                    onClick={() => setSelectedFile(f.name)}
                    className={`w-full text-left px-3.5 py-2.5 rounded-lg transition-colors cursor-pointer ${
                      selectedFile === f.name
                        ? 'bg-[var(--blue-soft)] border border-[var(--blue)] text-[var(--ink)]'
                        : 'hover:bg-[var(--surface-muted)] text-[var(--ink-muted)] border border-transparent'
                    }`}
                  >
                    <div className="text-xs font-bold font-mono-tabular">{f.label}</div>
                    <div className="text-[11px] text-[var(--ink-subtle)] truncate mt-0.5">{f.desc}</div>
                  </button>
                ))}
              </div>
              <div className="flex flex-col min-h-0">
                <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center justify-between gap-2 bg-[var(--surface-muted)]">
                  <span className="text-xs font-bold font-mono-tabular text-[var(--cyan-ink)]">{selectedFile}</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        const text = fileContents[selectedFile] || '';
                        if (!text) {
                          pushToast('Source not loaded yet', '#b91c1c');
                          return;
                        }
                        try {
                          if (!navigator.clipboard) throw new Error('Clipboard unavailable (needs HTTPS)');
                          await navigator.clipboard.writeText(text);
                          setCopiedFile(selectedFile);
                          pushToast(`Copied ${selectedFile}`, '#15803d');
                          setTimeout(() => setCopiedFile(null), 1800);
                        } catch (err) {
                          pushToast((err as Error).message || 'Could not copy', '#b91c1c');
                        }
                      }}
                      className="h-8 px-3 rounded-[var(--radius)] bg-[var(--surface-muted)] hover:bg-[var(--surface-sunken)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      {copiedFile === selectedFile ? <Check className="w-3.5 h-3.5 text-[var(--green-ink)]" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedFile === selectedFile ? 'Copied' : 'Copy'}</span>
                    </button>
                    <a
                      href={`/windows-c-project/${selectedFile}`}
                      download={selectedFile}
                      className="h-8 px-3 rounded-[var(--radius)] bg-[var(--blue)] hover:bg-[var(--blue-hover)] border border-[var(--blue)] text-xs font-semibold inline-flex items-center gap-1.5 text-white"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download</span>
                    </a>
                  </div>
                </div>
                <pre className="flex-1 p-4 overflow-auto text-xs font-mono-tabular text-[var(--ink)] leading-relaxed bg-[var(--surface-sunken)] border-t-0">
                  <code>{fileContents[selectedFile] || 'Loading source file...'}</code>
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Glass Toast Stack */}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto px-4 py-3 rounded-lg bg-white border border-[var(--border-strong)] shadow-[var(--shadow-raised)] text-xs font-semibold text-[var(--ink)] flex items-center gap-2.5"
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: t.color }}
            />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
