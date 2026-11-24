import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Check,
  Code2,
  Copy,
  Cpu,
  Download,
  ListTree,
  Moon,
  Sun,
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
  clampInt,
  compareAllAlgorithms,
  CompareResponse,
  PriorityMode,
  ProcessInput,
  runMultiCoreSimulation,
  SAMPLE_WORKLOAD,
  SIM_LIMITS,
  SimResult,
  validateProcessInput,
} from './lib/schedulerEngine';
import { runSchedulerJob } from './lib/runSchedulerJob';
import { GanttTracks } from './components/GanttTracks';
import {
  canConnectToAgent,
  fetchWithTimeout,
  LOCAL_DASHBOARD_URL,
  requestAgent,
} from './lib/windowsAgent';
import type { HardwareInfo, LaunchResult, LiveMetrics } from './lib/windowsAgent';

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

const PROC_SOLID = ['#0A84FF', '#BF5AF2', '#FF9F0A', '#30D158', '#FF453A', '#5E5CE6', '#64D2FF', '#FFD60A'];

const C_PROJECT_FILES = [
  { name: 'scheduler.h', label: 'scheduler.h', desc: 'Data structures & scheduling API' },
  { name: 'scheduler.c', label: 'scheduler.c', desc: 'Win32 threads, CRITICAL_SECTION & 5 algorithms' },
  { name: 'monitor.h', label: 'monitor.h', desc: 'Hardware & process monitor header' },
  { name: 'monitor.c', label: 'monitor.c', desc: 'Win32 Registry, GetSystemTimes, PSAPI & CreateProcess' },
  { name: 'server.c', label: 'server.c', desc: 'Winsock2 HTTP server, manual JSON & CSV report' },
  { name: 'dashboard.html', label: 'dashboard.html', desc: 'Single-file Apple Liquid Glass frontend' },
  { name: 'build.bat', label: 'build.bat', desc: 'MinGW GCC Windows compile script' },
  { name: 'README.md', label: 'README.md', desc: 'Build, run & viva demo guide' },
] as const;

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

const PREVIEW_HARDWARE: HardwareInfo = {
  cpuModel: 'Sample Windows processor',
  physicalCores: 4,
  logicalProcessors: 8,
};

const WINDOWS_SOURCE_URL = '/windows-c-project/source.zip';
const PREVIEW_CPU = 24.5;
const PREVIEW_RAM = 56.2;
const PREVIEW_CPU_SERIES = Array.from({ length: 60 }, (_, i) =>
  Number((18 + Math.sin(i * 0.25) * 8 + (i % 5)).toFixed(1)));
const PREVIEW_RAM_SERIES = Array.from({ length: 60 }, (_, i) =>
  Number((54 + Math.cos(i * 0.15) * 3).toFixed(1)));

function getNextSuggestedPid(list: ProcessInput[]): string {
  const existing = new Set(list.map((p) => p.pid.toLowerCase()));
  let idx = list.length + 1;
  while (existing.has(`p${idx}`)) idx++;
  return `P${idx}`;
}

const AnimatedNumber = React.memo(function AnimatedNumber({
  value,
  decimals = 2,
  suffix = '',
}: {
  value: number;
  decimals?: number;
  suffix?: string;
}) {
  const safeVal = Number.isFinite(value) ? value : 0;
  const [display, setDisplay] = useState(safeVal);
  // Always animate from the *currently displayed* value so updates that land
  // mid-tween continue smoothly instead of jumping to the stale target.
  const displayRef = useRef(safeVal);

  useEffect(() => {
    const start = displayRef.current;
    const end = safeVal;
    if (Math.abs(end - start) < 0.0001) {
      displayRef.current = end;
      setDisplay(end);
      return;
    }
    const startTime = performance.now();
    const duration = 420;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = start + (end - start) * eased;
      displayRef.current = p < 1 ? v : end;
      setDisplay(displayRef.current);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [safeVal]);

  return (
    <span className="tabular-nums">
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
});

const LiveSparkChart = React.memo(function LiveSparkChart({
  data,
  stroke,
  gradientId,
}: {
  data: number[];
  stroke: string;
  gradientId: string;
}) {
  const w = 520;
  const h = 190;
  const padLeft = 36;
  const padRight = 10;
  const padY = 12;
  const plotW = w - padLeft - padRight;
  const plotH = h - padY * 2;
  const safeData = data.length > 0 ? data : [0];

  const pts = safeData.map((raw, i) => {
    const v = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
    const x = padLeft + (i / Math.max(1, safeData.length - 1)) * plotW;
    const y = h - padY - (v / 100) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M ${pts.join(' L ')}`;
  const areaPath = `${linePath} L ${(w - padRight).toFixed(1)},${(h - padY).toFixed(1)} L ${padLeft},${(h - padY).toFixed(1)} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[210px] overflow-visible" role="img" aria-label="Live utilization chart">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.44" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 25, 50, 75, 100].map((tick) => {
        const y = h - padY - (tick / 100) * plotH;
        return (
          <g key={tick}>
            <line x1={padLeft} y1={y} x2={w - padRight} y2={y} stroke="var(--stroke)" strokeDasharray="4 4" />
            <text x={padLeft - 6} y={y + 3.5} textAnchor="end" fill="var(--muted)" fontSize="10" className="tabular-nums">
              {tick}%
            </text>
          </g>
        );
      })}
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path d={linePath} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
});

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('scheduler');
  const showHardware = activeTab === 'hardware';
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f3f6fb' : '#101625');
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem('cpu-simulator-theme', next);
    } catch {
      // The theme still works when storage is unavailable.
    }
  };
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastTimersRef = useRef<number[]>([]);
  const copyTimerRef = useRef<number | null>(null);

  // Scheduler state
  const [processes, setProcesses] = useState<ProcessInput[]>(SAMPLE_WORKLOAD);
  const [algorithm, setAlgorithm] = useState<AlgorithmType>('FCFS');
  const [cores, setCores] = useState<number>(2);
  const [coresInput, setCoresInput] = useState<string>('2');
  const [quantum, setQuantum] = useState<number>(3);
  const [quantumInput, setQuantumInput] = useState<string>('3');
  const [priorityMode, setPriorityMode] = useState<PriorityMode>('preemptive');

  const [newPid, setNewPid] = useState('P6');
  const [newArrival, setNewArrival] = useState('0');
  const [newBurst, setNewBurst] = useState('5');
  const [newPriority, setNewPriority] = useState('2');
  const [formError, setFormError] = useState<string | null>(null);

  const [simResult, setSimResult] = useState<SimResult>(() =>
    runMultiCoreSimulation(SAMPLE_WORKLOAD, 'FCFS', 2, 3, 'preemptive')
  );
  const [compareResult, setCompareResult] = useState<CompareResponse>(() =>
    compareAllAlgorithms(SAMPLE_WORKLOAD, 2, 3, 'preemptive', false)
  );
  const [isSimulating, setIsSimulating] = useState(false);
  const [isComparing, setIsComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const comparisonRequest = useRef(0);

  const workloadSignature = useMemo(
    () => JSON.stringify({ processes, cores, quantum, priorityMode }),
    [processes, cores, quantum, priorityMode]
  );
  const [lastComparedSignature, setLastComparedSignature] = useState<string>(() =>
    JSON.stringify({ processes: SAMPLE_WORKLOAD, cores: 2, quantum: 3, priorityMode: 'preemptive' })
  );

  // Gantt animated replay
  const [isPlaying, setIsPlaying] = useState(false);
  const [playTick, setPlayTick] = useState<number | null>(null);
  const playProgressRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const tickLabelRef = useRef<HTMLSpanElement | null>(null);

  const [backendConnected, setBackendConnected] = useState(false);
  const [autoConnect, setAutoConnect] = useState(window.location.protocol === 'http:');
  const backendConnectedRef = useRef(false);
  const connectionRequest = useRef<AbortController | null>(null);
  const processRequest = useRef<AbortController | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hwInfo, setHwInfo] = useState(PREVIEW_HARDWARE);
  const [liveCpu, setLiveCpu] = useState(PREVIEW_CPU);
  const [liveRamPct, setLiveRamPct] = useState(PREVIEW_RAM);
  const [liveRamUsedGB, setLiveRamUsedGB] = useState(8.99);
  const [liveRamTotalGB, setLiveRamTotalGB] = useState(16);
  const liveCpuRef = useRef(PREVIEW_CPU);
  const liveRamRef = useRef(PREVIEW_RAM);
  const [cpuSeries, setCpuSeries] = useState(PREVIEW_CPU_SERIES);
  const [ramSeries, setRamSeries] = useState(PREVIEW_RAM_SERIES);

  const [liveProcesses, setLiveProcesses] = useState<OSProcess[] | null>(null);
  const knownPidsRef = useRef<Set<number> | null>(null);
  const [processLoadError, setProcessLoadError] = useState(false);
  const [isRefreshingProcs, setIsRefreshingProcs] = useState(false);
  const [launchingApp, setLaunchingApp] = useState<string | null>(null);
  const [launchNotice, setLaunchNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [procSearch, setProcSearch] = useState('');
  const [procSort, setProcSort] = useState<{ key: 'name' | 'pid' | 'memoryMB'; dir: 1 | -1 }>({
    key: 'memoryMB',
    dir: -1,
  });
  const [pinCore, setPinCore] = useState<number>(-1);

  // Windows C11 Source Drawer
  const [codeDrawerOpen, setCodeDrawerOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string>(C_PROJECT_FILES[0].name);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const fileCacheRef = useRef<Record<string, string>>({});
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileReloadNonce, setFileReloadNonce] = useState(0);
  const [copiedFile, setCopiedFile] = useState<string | null>(null);

  const pushToast = useCallback((message: string, color = '#0A84FF') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-3), { id, message, color }]);
    const timer = window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      toastTimersRef.current = toastTimersRef.current.filter((t) => t !== timer);
    }, 3400);
    toastTimersRef.current.push(timer);
  }, []);

  // Cleanup animations & timers on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      toastTimersRef.current.forEach((t) => window.clearTimeout(t));
      toastTimersRef.current = [];
    };
  }, []);

  const applyLiveMetrics = useCallback((metrics: LiveMetrics, resetHistory = false) => {
    const { cpuPercent, ramPercent, ramUsedMB, ramTotalMB } = metrics;
    if (![cpuPercent, ramPercent, ramUsedMB, ramTotalMB].every(Number.isFinite)) {
      throw new Error('The Windows agent returned invalid hardware readings.');
    }
    const cpu = Math.max(0, Math.min(100, cpuPercent));
    const ram = Math.max(0, Math.min(100, ramPercent));
    setLiveCpu(cpu);
    setLiveRamPct(ram);
    setLiveRamUsedGB(ramUsedMB / 1024);
    setLiveRamTotalGB(ramTotalMB / 1024);
    setCpuSeries((series) => resetHistory ? [cpu] : [...series.slice(-59), cpu]);
    setRamSeries((series) => resetHistory ? [ram] : [...series.slice(-59), ram]);
  }, []);

  const disconnectAgent = useCallback((message: string | null = null) => {
    connectionRequest.current?.abort();
    connectionRequest.current = null;
    processRequest.current?.abort();
    processRequest.current = null;
    knownPidsRef.current = null;
    backendConnectedRef.current = false;
    liveCpuRef.current = PREVIEW_CPU;
    liveRamRef.current = PREVIEW_RAM;
    setBackendConnected(false);
    setIsConnecting(false);
    setConnectionError(message);
    setHwInfo(PREVIEW_HARDWARE);
    setLiveCpu(PREVIEW_CPU);
    setLiveRamPct(PREVIEW_RAM);
    setLiveRamUsedGB(8.99);
    setLiveRamTotalGB(16);
    setCpuSeries(PREVIEW_CPU_SERIES);
    setRamSeries(PREVIEW_RAM_SERIES);
    setLiveProcesses(null);
    setProcessLoadError(false);
    setIsRefreshingProcs(false);
    setPinCore(-1);
    setLaunchNotice(null);
  }, []);

  const connectAgent = useCallback(async (manual = true) => {
    if (!canConnectToAgent || connectionRequest.current || backendConnectedRef.current) return;
    const controller = new AbortController();
    connectionRequest.current = controller;
    if (manual) {
      setIsConnecting(true);
      setConnectionError(null);
    }

    try {
      const options = { signal: controller.signal };
      const hardware = await requestAgent<HardwareInfo>('/api/hardware', options, manual ? 30000 : 1500);
      if (typeof hardware?.cpuModel !== 'string' || !Number.isInteger(hardware.physicalCores) ||
          hardware.physicalCores <= 0 || !Number.isInteger(hardware.logicalProcessors) || hardware.logicalProcessors <= 0) {
        throw new Error('Invalid response from the Windows agent.');
      }
      const metrics = await requestAgent<LiveMetrics>('/api/live', options);
      if (controller.signal.aborted) return;
      const affinityCores = Array.isArray(hardware.affinityCores)
        ? [...new Set(hardware.affinityCores.filter((core) => Number.isInteger(core) && core >= 0 && core < 64))]
        : Array.from({ length: Math.min(32, hardware.logicalProcessors) }, (_, core) => core);
      applyLiveMetrics(metrics, true);
      setHwInfo({ ...hardware, affinityCores });
      setConnectionError(null);
      backendConnectedRef.current = true;
      setBackendConnected(true);
    } catch {
      if (manual && !controller.signal.aborted) {
        setConnectionError('Could not connect. Start the updated Windows agent and allow local network access if prompted. You can also open the local dashboard.');
      }
    } finally {
      if (connectionRequest.current === controller) {
        connectionRequest.current = null;
        if (manual) setIsConnecting(false);
      }
    }
  }, [applyLiveMetrics]);

  useEffect(() => {
    if (!autoConnect || backendConnected) return;
    void connectAgent(false);
    const timer = window.setInterval(() => {
      if (!document.hidden) void connectAgent(false);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoConnect, backendConnected, connectAgent]);

  useEffect(() => () => {
    connectionRequest.current?.abort();
    connectionRequest.current = null;
    processRequest.current?.abort();
    processRequest.current = null;
  }, []);

  useEffect(() => {
    if (backendConnected || !showHardware) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      liveCpuRef.current = Math.min(92, Math.max(8, liveCpuRef.current + (Math.random() - 0.48) * 9));
      liveRamRef.current = Math.min(84, Math.max(38, liveRamRef.current + (Math.random() - 0.5) * 1.4));
      applyLiveMetrics({
        cpuPercent: liveCpuRef.current,
        ramPercent: liveRamRef.current,
        ramUsedMB: (liveRamRef.current / 100) * 16384,
        ramTotalMB: 16384,
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [applyLiveMetrics, backendConnected, showHardware]);

  useEffect(() => {
    if (!backendConnected) return;
    const interval = showHardware ? 1000 : 3000;
    const controller = new AbortController();
    let timer: number;
    let failures = 0;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const metrics = await requestAgent<LiveMetrics>('/api/live', { signal: controller.signal }, 1500);
          if (controller.signal.aborted || !backendConnectedRef.current) return;
          if (showHardware) applyLiveMetrics(metrics);
          failures = 0;
        } catch {
          if (controller.signal.aborted) return;
          if (++failures >= 2) {
            disconnectAgent('The Windows agent connection was lost. Restart the agent and reconnect.');
            return;
          }
        }
      }
      timer = window.setTimeout(poll, interval);
    };
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [applyLiveMetrics, backendConnected, disconnectAgent, showHardware]);

  const fetchOsProcesses = useCallback(async (manual = false) => {
    if (!backendConnectedRef.current || processRequest.current) return;
    const controller = new AbortController();
    processRequest.current = controller;
    setIsRefreshingProcs(true);
    try {
      const data = await requestAgent<{ processes: OSProcess[] }>('/api/processes', { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!Array.isArray(data?.processes)) throw new Error('Invalid Windows process list.');
      const incoming = data.processes.filter((process) =>
        Number.isInteger(process?.pid) && typeof process.name === 'string' && Number.isFinite(process.memoryMB));
      const knownPids = knownPidsRef.current;
      setLiveProcesses(incoming.map((process) => ({
        ...process,
        isNew: knownPids !== null && !knownPids.has(process.pid),
      })));
      knownPidsRef.current = new Set(incoming.map(({ pid }) => pid));
      setProcessLoadError(false);
      if (manual) pushToast(`Refreshed ${incoming.length} Windows processes`, '#64D2FF');
    } catch {
      if (!controller.signal.aborted) setProcessLoadError(true);
    } finally {
      if (processRequest.current === controller) {
        processRequest.current = null;
        setIsRefreshingProcs(false);
      }
    }
  }, [pushToast]);

  useEffect(() => {
    if (activeTab !== 'processes' || !backendConnected) return;
    void fetchOsProcesses();
    const timer = window.setInterval(() => {
      if (!document.hidden) void fetchOsProcesses();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [activeTab, backendConnected, fetchOsProcesses]);

  // Load the selected C source file on demand.
  // A ref-based cache guards re-fetches so writing to `fileContents` after a
  // successful load (including after Retry) never re-triggers the effect.
  useEffect(() => {
    if (!codeDrawerOpen) return;
    if (fileCacheRef.current[selectedFile] !== undefined) return;

    const controller = new AbortController();
    setFileLoading(true);
    setFileError(null);

    fetchWithTimeout(`/windows-c-project/${selectedFile}`, { signal: controller.signal }, 6000, async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${selectedFile}`);
      const text = await response.text();
      if (!text.trim() || /<div id="root"><\/div>/.test(text) ||
          (!selectedFile.endsWith('.html') && /^\s*<!doctype html>/i.test(text))) {
        throw new Error(`Source file "${selectedFile}" was not found on the server.`);
      }
      return text;
    })
      .then((text) => {
        if (controller.signal.aborted) return;
        fileCacheRef.current[selectedFile] = text;
        setFileLoading(false);
        setFileContents((prev) => ({ ...prev, [selectedFile]: text }));
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setFileError((err as Error).message || 'Could not load source file.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setFileLoading(false);
        }
      });

    return () => controller.abort();
  }, [codeDrawerOpen, selectedFile, fileReloadNonce]);

  // Close C11 source modal on Escape key
  useEffect(() => {
    if (!codeDrawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCodeDrawerOpen(false);
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [codeDrawerOpen]);

  const pidColorIndex = useMemo(() => {
    const map: Record<string, number> = Object.create(null);
    processes.forEach((p, idx) => {
      if (!(p.pid in map)) map[p.pid] = idx % PROC_SOLID.length;
    });
    simResult.processes.forEach((p, idx) => {
      if (!(p.pid in map)) map[p.pid] = idx % PROC_SOLID.length;
    });
    return map;
  }, [processes, simResult]);

  const stopReplay = useCallback(() => {
    setIsPlaying(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const resetReplayState = useCallback(() => {
    stopReplay();
    playProgressRef.current = 0;
    setPlayTick(null);
  }, [stopReplay]);

  const commitCoresInput = (raw: string): number => {
    const clamped = clampInt(Number(raw), SIM_LIMITS.MIN_CORES, SIM_LIMITS.MAX_CORES, cores);
    setCores(clamped);
    setCoresInput(String(clamped));
    return clamped;
  };

  const commitQuantumInput = (raw: string): number => {
    const clamped = clampInt(Number(raw), SIM_LIMITS.MIN_QUANTUM, SIM_LIMITS.MAX_QUANTUM, quantum);
    setQuantum(clamped);
    setQuantumInput(String(clamped));
    return clamped;
  };

  const handleRunSimulation = async () => {
    if (!processes.length) {
      pushToast('Add at least one process first', '#FF453A');
      return;
    }
    const effectiveCores = commitCoresInput(coresInput);
    const effectiveQuantum = commitQuantumInput(quantumInput);
    resetReplayState();
    setIsSimulating(true);

    try {
      if (backendConnectedRef.current) {
        try {
          const data = await requestAgent<SimResult>(
            '/api/simulate',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                processes,
                algorithm,
                cores: effectiveCores,
                quantum: effectiveQuantum,
                priorityMode,
              }),
            },
            3000
          );
          if (!Array.isArray(data?.gantt) || !Array.isArray(data?.ticks) || !Array.isArray(data?.processes) ||
              !Array.isArray(data?.metrics?.coreUtilization)) throw new Error('Invalid Windows simulation result.');
          setSimResult(data);
          pushToast(`C11 backend simulation complete (${data.algorithm}, ${data.cores} cores)`, '#30D158');
          return;
        } catch {
          // Seamless fallback to exact local TypeScript engine
        }
      }

      const res = await runSchedulerJob({
        kind: 'simulate',
        args: [processes, algorithm, effectiveCores, effectiveQuantum, priorityMode],
      });
      setSimResult(res);
      if (res.truncated) {
        pushToast(`Simulation reached ${SIM_LIMITS.MAX_SIM_TICKS} tick safety limit`, '#FF9F0A');
      } else {
        pushToast(`Simulation complete (${res.algorithm}, ${res.cores} cores)`, '#30D158');
      }
    } catch {
      pushToast('Simulation failed. Run it again to retry.', '#FF453A');
    } finally {
      setIsSimulating(false);
    }
  };

  const executeCompareAll = useCallback(
    async (silent = false) => {
      if (!processes.length) {
        if (!silent) pushToast('Add processes in the Simulator tab first', '#FF453A');
        return;
      }
      const request = ++comparisonRequest.current;
      setCompareError(null);
      setIsComparing(true);
      try {
        if (backendConnectedRef.current) {
          try {
            const data = await requestAgent<CompareResponse>(
              '/api/compare',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ processes, cores, quantum, priorityMode }),
              },
              3500
            );
            if (request !== comparisonRequest.current) return;
            if (!Array.isArray(data?.results) || data.results.length !== 5 || !data.best) {
              throw new Error('Invalid Windows comparison result.');
            }
            setCompareResult(data);
            setLastComparedSignature(workloadSignature);
            if (!silent) pushToast('Compared all 5 scheduling algorithms (C11 backend)', '#BF5AF2');
            return;
          } catch {
            // Fall back to local engine
          }
        }
        const cmp = await runSchedulerJob({ kind: 'compare', args: [processes, cores, quantum, priorityMode] });
        if (request !== comparisonRequest.current) return;
        setCompareResult(cmp);
        setLastComparedSignature(workloadSignature);
        if (!silent) pushToast('Compared all 5 scheduling algorithms', '#BF5AF2');
      } catch {
        if (request === comparisonRequest.current) setCompareError('Comparison failed. Select Compare All Algorithms to retry.');
      } finally {
        if (request === comparisonRequest.current) setIsComparing(false);
      }
    },
    [cores, priorityMode, processes, pushToast, quantum, workloadSignature]
  );

  // Auto-sync Performance Analytics when user opens the tab after modifying workload/config
  useEffect(() => {
    if (activeTab === 'analytics' && processes.length > 0 && lastComparedSignature !== workloadSignature) {
      executeCompareAll(true);
    }
  }, [activeTab, executeCompareAll, lastComparedSignature, processes.length, workloadSignature]);

  /** Keep the replay playhead line and tick label smooth via direct DOM writes. */
  const syncPlayheadDom = useCallback((progress: number, makespan: number) => {
    const frac = makespan > 0 ? Math.min(1, Math.max(0, progress / makespan)) : 1;
    if (playheadRef.current) {
      playheadRef.current.style.left = `${frac * 100}%`;
    }
    if (tickLabelRef.current) {
      tickLabelRef.current.textContent = `Tick: ${progress.toFixed(1)} / ${makespan}`;
    }
  }, []);

  // Re-sync the playhead/label when replay state changes outside the rAF loop
  // (pause, reset, fresh simulation result, or remount after a tab switch).
  useLayoutEffect(() => {
    syncPlayheadDom(playProgressRef.current, simResult.metrics.makespan);
  }, [playTick, isPlaying, isSimulating, simResult, activeTab, syncPlayheadDom]);

  const handleTogglePlay = () => {
    const makespan = simResult.metrics.makespan;
    if (!makespan || !simResult.processes.length) {
      pushToast('Run a simulation with at least one process first', '#FF9F0A');
      return;
    }
    if (isPlaying) {
      stopReplay();
      return;
    }
    setIsPlaying(true);
    if (playProgressRef.current >= makespan) playProgressRef.current = 0;
    let lastTs = performance.now();
    // Replay always takes ~6 seconds regardless of makespan (clamped so tiny
    // simulations stay watchable and huge ones don't take minutes).
    const speed = Math.max(2.5, makespan / 6);
    let lastUiTs = 0;

    const frame = (ts: number) => {
      const dt = Math.min(0.1, (ts - lastTs) / 1000);
      lastTs = ts;
      playProgressRef.current += dt * speed;
      const p = playProgressRef.current;
      if (p >= makespan) {
        playProgressRef.current = makespan;
        syncPlayheadDom(makespan, makespan);
        setPlayTick(makespan);
        stopReplay();
        pushToast('Gantt replay finished', '#64D2FF');
        return;
      }
      syncPlayheadDom(p, makespan);
      // Throttle React state (~12fps): the playhead moves smoothly via the DOM
      // while the heavyweight panels only re-render on sampled tick changes.
      if (ts - lastUiTs >= 80) {
        lastUiTs = ts;
        const tickInt = Math.floor(p);
        setPlayTick((prev) => (prev === tickInt ? prev : tickInt));
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
  };

  const handleAddProcess = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const validation = validateProcessInput(
      {
        pid: newPid,
        arrival: Number(newArrival),
        burst: Number(newBurst),
        priority: Number(newPriority),
      },
      processes
    );
    if (!validation.ok) {
      setFormError(validation.error);
      pushToast(validation.error, '#FF453A');
      return;
    }
    setFormError(null);
    const next = [...processes, validation.value];
    setProcesses(next);
    setNewPid(getNextSuggestedPid(next));
    pushToast(`Added process ${validation.value.pid}`, '#30D158');
  };

  const handleLoadSample = () => {
    if (isSimulating) return;
    comparisonRequest.current++;
    setIsComparing(false);
    setCompareError(null);
    resetReplayState();
    setFormError(null);
    setProcesses(SAMPLE_WORKLOAD);
    setCores(2);
    setCoresInput('2');
    setQuantum(3);
    setQuantumInput('3');
    setNewPid('P6');
    const res = runMultiCoreSimulation(SAMPLE_WORKLOAD, algorithm, 2, 3, priorityMode);
    const cmp = compareAllAlgorithms(SAMPLE_WORKLOAD, 2, 3, priorityMode, false);
    setSimResult(res);
    setCompareResult(cmp);
    setLastComparedSignature(
      JSON.stringify({ processes: SAMPLE_WORKLOAD, cores: 2, quantum: 3, priorityMode })
    );
    pushToast('Sample workload loaded (P1–P5, 2 cores, Q=3)', '#0A84FF');
  };

  const handleRandomize = () => {
    if (isSimulating) return;
    resetReplayState();
    setFormError(null);
    const count = 5 + Math.floor(Math.random() * 4);
    const list: ProcessInput[] = Array.from({ length: count }, (_, i) => ({
      pid: `P${i + 1}`,
      arrival: Math.floor(Math.random() * 7),
      burst: 2 + Math.floor(Math.random() * 9),
      priority: 1 + Math.floor(Math.random() * 5),
    }));
    setProcesses(list);
    setNewPid(`P${count + 1}`);
    const effectiveCores = commitCoresInput(coresInput);
    const effectiveQuantum = commitQuantumInput(quantumInput);
    const res = runMultiCoreSimulation(list, algorithm, effectiveCores, effectiveQuantum, priorityMode);
    setSimResult(res);
    pushToast(`Generated & simulated ${count} random processes`, '#BF5AF2');
  };

  const handleClearProcesses = () => {
    if (isSimulating) return;
    resetReplayState();
    setFormError(null);
    setProcesses([]);
    setNewPid('P1');
    pushToast('Process queue cleared', '#FF9F0A');
  };

  const handleDownloadCsv = async () => {
    if (!processes.length && !simResult.processes.length) {
      pushToast('Run a simulation first to export a CSV report', '#FF453A');
      return;
    }
    let cmpForExport = compareResult;
    try {
      if (processes.length > 0 && lastComparedSignature !== workloadSignature) {
        cmpForExport = await runSchedulerJob({ kind: 'compare', args: [processes, cores, quantum, priorityMode] });
      }
    } catch {
      pushToast('Could not generate the CSV report. Please try again.', '#FF453A');
      return;
    }
    const csv = buildCsvReport(simResult, processes.length > 0 ? cmpForExport : null);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cpu_scheduler_report.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    pushToast('Report downloaded (cpu_scheduler_report.csv)', '#30D158');
  };

  const handleLaunchApp = async (app: 'chrome' | 'vscode' | 'notepad' | 'calculator') => {
    if (launchingApp || !backendConnectedRef.current) return;
    setLaunchingApp(app);
    setLaunchNotice(null);
    try {
      const data = await requestAgent<LaunchResult>('/api/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app, core: hwInfo.affinityCores?.includes(pinCore) ? pinCore : -1 }),
      }, 8000);
      if (!data?.launched || !Number.isInteger(data.pid) || data.pid <= 0) {
        throw new Error(data?.message || 'The Windows agent did not confirm the launch.');
      }
      setLaunchNotice({ message: data.message || `Application launched (PID ${data.pid}).`, error: false });
      void fetchOsProcesses();
    } catch (err) {
      const message = err instanceof Error && !['AbortError', 'TypeError'].includes(err.name)
        ? err.message
        : 'Could not confirm the launch. Check Windows before trying again.';
      setLaunchNotice({ message, error: true });
    } finally {
      setLaunchingApp(null);
    }
  };

  const handleCopySource = async () => {
    const text = fileContents[selectedFile];
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('Clipboard copy blocked by browser');
      }
      setCopiedFile(selectedFile);
      pushToast(`Copied ${selectedFile}`, '#30D158');
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedFile(null), 1800);
    } catch {
      pushToast('Clipboard access blocked — use Download instead', '#FF453A');
    }
  };

  const osProcs = backendConnected ? liveProcesses : PREVIEW_PROCESSES;
  const filteredOsProcs = useMemo(() => {
    const q = procSearch.trim().toLowerCase();
    return (osProcs ?? [])
      .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.pid).includes(q))
      .sort((a, b) => {
        const av = a[procSort.key];
        const bv = b[procSort.key];
        if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * procSort.dir;
        return ((av as number) - (bv as number)) * procSort.dir;
      });
  }, [osProcs, procSearch, procSort]);

  const activeSnap = useMemo(() => {
    if (playTick === null || !simResult.ticks.length) return null;
    if (playTick >= simResult.metrics.makespan) {
      return {
        tick: simResult.metrics.makespan,
        completed: simResult.processes.length,
        cores: Array.from({ length: simResult.cores }, () => 'IDLE'),
        readyQueue: [] as string[],
        finished: true,
      };
    }
    // Snapshots can be sparse (the engine fast-forwards pure-idle gaps), so
    // binary-search for the last snapshot at or before the current tick.
    const arr = simResult.ticks;
    let lo = 0;
    let hi = arr.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].tick <= playTick) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return { ...arr[idx], finished: false };
  }, [playTick, simResult]);

  const navItems: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'scheduler', label: 'Scheduling Simulator', icon: <Cpu className="w-5 h-5" /> },
    { key: 'hardware', label: 'Live Hardware Monitor', icon: <Activity className="w-5 h-5" /> },
    { key: 'processes', label: 'Process Monitor', icon: <ListTree className="w-5 h-5" /> },
    { key: 'analytics', label: 'Performance Analytics', icon: <BarChart3 className="w-5 h-5" /> },
  ];
  const activeTabIndex = navItems.findIndex((t) => t.key === activeTab);

  const gaugeCirc = 2 * Math.PI * 56;
  const sortArrow = (key: 'name' | 'pid' | 'memoryMB') =>
    procSort.key === key ? (procSort.dir === 1 ? '↑' : '↓') : '↕';

  return (
    <div className="relative min-h-screen text-ink selection:bg-[#0A84FF]/40">
      {/* Main Responsive Shell */}
      <div className="relative z-10 max-w-[1600px] mx-auto p-3 sm:p-4 lg:p-5 grid grid-cols-1 lg:grid-cols-[268px_minmax(0,1fr)] gap-4 sm:gap-5 min-h-screen">
        {/* Floating Glass Sidebar */}
        <aside className="liquid-glass p-4 lg:sticky lg:top-5 lg:h-[calc(100vh-40px)] flex flex-col justify-between">
          <div>
            <div className="px-3 pb-4 mb-4 border-b border-neutral-ui/12">
              <div className="text-[17px] font-extrabold tracking-tight text-ink">
                CoreOS Simulator
              </div>
              <div className="text-xs text-muted mt-1">C11 Multi-Core Engine &amp; Monitor</div>
            </div>

            <nav className="relative flex flex-row lg:flex-col gap-2 flex-wrap" aria-label="Primary Navigation">
              {/* Sliding Glass Pill Indicator (Desktop) */}
              <div
                aria-hidden="true"
                className="hidden lg:block absolute left-0 right-0 h-12 rounded-2xl pointer-events-none transition-transform duration-300"
                style={{
                  transform: `translateY(${activeTabIndex * 56}px)`,
                  transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
                  background: 'linear-gradient(135deg, rgba(10,132,255,0.4), rgba(191,90,242,0.32))',
                  border: '1px solid rgba(255,255,255,0.32)',
                  boxShadow: '0 8px 24px rgba(10,132,255,0.28), inset 0 1px 1px rgba(255,255,255,0.4)',
                }}
              />
              {navItems.map((item) => {
                const active = activeTab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      if (item.key !== 'scheduler') stopReplay();
                      setActiveTab(item.key);
                    }}
                    aria-current={active ? 'page' : undefined}
                    className={`relative z-10 h-11 lg:h-12 px-3.5 rounded-2xl flex items-center gap-2.5 lg:gap-3 text-xs sm:text-sm font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-all ${
                      active
                        ? 'text-ink lg:bg-transparent bg-gradient-to-r from-[#0A84FF]/40 to-[#BF5AF2]/35'
                        : 'text-muted hover:text-ink hover:translate-x-0.5'
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
              type="button"
              onClick={() => setCodeDrawerOpen(true)}
              className="w-full h-11 px-4 rounded-full bg-neutral-ui/10 hover:bg-neutral-ui/16 border border-neutral-ui/22 text-xs font-semibold text-ink flex items-center justify-center gap-2 cursor-pointer spring-btn whitespace-nowrap"
            >
              <Code2 className="w-4 h-4 text-info" />
              <span>View Windows C11 Project (8 Files)</span>
            </button>
            <div className="p-3.5 rounded-2xl bg-neutral-ui/5 border border-neutral-ui/10 text-xs text-muted leading-relaxed">
              <div className="font-semibold text-ink mb-1">Windows MinGW C11 Stack</div>
              Winsock2 HTTP + Win32 Threads (<code className="text-info">CreateThread</code>,{' '}
              <code className="text-info">CRITICAL_SECTION</code>,{' '}
              <code className="text-info">GetSystemTimes</code>).
            </div>
          </div>
        </aside>

        {/* Workspace Column */}
        <main className="flex flex-col gap-5 min-w-0">
          {/* Glass Top Bar */}
          <header className="liquid-glass px-4 sm:px-6 py-3.5 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[15px] sm:text-[16px] font-bold tracking-tight">
              Multi-Core CPU Scheduling Simulator
            </div>
            <div className="flex items-center gap-2.5 sm:gap-3 flex-wrap">
              <button type="button" onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                className="h-9 px-3 rounded-full bg-neutral-ui/8 hover:bg-neutral-ui/16 border border-neutral-ui/16 text-xs font-semibold inline-flex items-center gap-2 cursor-pointer">
                {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                {theme === 'dark' ? 'Light' : 'Dark'}
              </button>
              <button
                type="button"
                onClick={() => setCodeDrawerOpen(true)}
                className="h-9 px-3.5 sm:px-4 rounded-full bg-neutral-ui/10 hover:bg-neutral-ui/18 border border-neutral-ui/20 text-xs font-semibold flex items-center gap-2 cursor-pointer spring-btn whitespace-nowrap"
              >
                <Code2 className="w-3.5 h-3.5 text-info" />
                <span>C11 Source Files</span>
              </button>
              <div className="inline-flex items-center gap-2 px-3 sm:px-3.5 py-1.5 rounded-full bg-neutral-ui/8 border border-neutral-ui/16 text-xs font-semibold max-w-full">
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    backendConnected
                      ? 'bg-[#30D158] shadow-[0_0_12px_#30D158]'
                      : 'bg-[#FF453A] shadow-[0_0_10px_#FF453A]'
                  }`}
                />
                <span className="truncate">
                  {backendConnected ? 'Windows agent connected' : 'Browser preview'}
                </span>
              </div>
            </div>
          </header>

          {/* ================= TAB 1: SCHEDULING SIMULATOR ================= */}
          {activeTab === 'scheduler' && (
            <div className="flex flex-col gap-5">
              {/* Simulation overview */}
              <div
                className="liquid-glass p-5 sm:p-7 grid grid-cols-1 xl:grid-cols-[1.35fr_1fr] gap-6 items-center"
                style={{
                  background:
                    'linear-gradient(135deg, rgba(10,132,255,0.16) 0%, rgba(191,90,242,0.11) 55%, rgba(255,159,10,0.08) 100%)',
                }}
              >
                <div>
                  <div className="text-xs font-bold tracking-[0.16em] uppercase text-info mb-2">
                    Operating Systems · Multi-Core Engine
                  </div>
                  <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight leading-[1.12] mb-3">
                    Multi-Core CPU Scheduling Simulator
                  </h1>
                  <p className="text-sm text-muted leading-relaxed max-w-[56ch]">
                    Simulate FCFS, SJF, SRTF, Priority, and Round Robin across 1–8 CPU cores with real-time tick replay,
                    per-core utilization metrics, and exact Windows C11 thread synchronization.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {simResult.metrics.coreUtilization.slice(0, 4).map((core) => (
                    <div key={core.core} className="p-3.5 rounded-xl panel-inset border border-neutral-ui/16 flex items-center justify-between gap-2 text-xs font-bold">
                      <span className="flex items-center gap-1.5"><Cpu className="w-4 h-4" /> Core {core.core}</span>
                      <span className="text-info tabular-nums">{core.utilization.toFixed(1)}%</span>
                    </div>
                  ))}
                  {simResult.cores > 4 && <span className="col-span-2 text-xs text-muted">+{simResult.cores - 4} more cores</span>}
                </div>
              </div>

              {/* Config & Process Builder */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                <div className="liquid-glass p-5 sm:p-6">
                  <div className="mb-4">
                    <h2 className="text-[17px] font-bold">Simulation Parameters</h2>
                    <p className="text-xs text-muted mt-0.5">Select algorithm, cores, quantum, and priority preemption</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-xs font-semibold text-muted block mb-1.5">Algorithm</span>
                      <select
                        value={algorithm}
                        onChange={(e) => setAlgorithm(e.target.value as AlgorithmType)}
                        className="w-full h-11 px-3.5 rounded-2xl panel-inset border border-neutral-ui/18 text-sm text-ink outline-none focus:border-[#0A84FF] focus:ring-2 focus:ring-[#0A84FF]/35"
                      >
                        <option value="FCFS">FCFS (Non-Preemptive)</option>
                        <option value="SJF">SJF (Non-Preemptive)</option>
                        <option value="SRTF">SRTF (Preemptive)</option>
                        <option value="Priority">Priority Scheduling</option>
                        <option value="Round Robin">Round Robin</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-muted block mb-1.5">CPU Cores (1–8)</span>
                      <input
                        type="number"
                        min={SIM_LIMITS.MIN_CORES}
                        max={SIM_LIMITS.MAX_CORES}
                        value={coresInput}
                        onChange={(e) => {
                          setCoresInput(e.target.value);
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n >= SIM_LIMITS.MIN_CORES && n <= SIM_LIMITS.MAX_CORES) {
                            setCores(Math.floor(n));
                          }
                        }}
                        onBlur={(e) => commitCoresInput(e.target.value)}
                        className="w-full h-11 px-3.5 rounded-2xl panel-inset border border-neutral-ui/18 text-sm text-ink tabular-nums outline-none focus:border-[#0A84FF] focus:ring-2 focus:ring-[#0A84FF]/35"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-muted block mb-1.5">Time Quantum (1–50)</span>
                      <input
                        type="number"
                        min={SIM_LIMITS.MIN_QUANTUM}
                        max={SIM_LIMITS.MAX_QUANTUM}
                        value={quantumInput}
                        onChange={(e) => {
                          setQuantumInput(e.target.value);
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n >= SIM_LIMITS.MIN_QUANTUM && n <= SIM_LIMITS.MAX_QUANTUM) {
                            setQuantum(Math.floor(n));
                          }
                        }}
                        onBlur={(e) => commitQuantumInput(e.target.value)}
                        className="w-full h-11 px-3.5 rounded-2xl panel-inset border border-neutral-ui/18 text-sm text-ink tabular-nums outline-none focus:border-[#0A84FF] focus:ring-2 focus:ring-[#0A84FF]/35"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-muted block mb-1.5">Priority Mode</span>
                      <select
                        value={priorityMode}
                        onChange={(e) => setPriorityMode(e.target.value as PriorityMode)}
                        className="w-full h-11 px-3.5 rounded-2xl panel-inset border border-neutral-ui/18 text-sm text-ink outline-none focus:border-[#0A84FF] focus:ring-2 focus:ring-[#0A84FF]/35"
                      >
                        <option value="preemptive">Preemptive</option>
                        <option value="non-preemptive">Non-Preemptive</option>
                      </select>
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-2.5 mt-5">
                    <button
                      type="button"
                      onClick={handleRunSimulation}
                      disabled={isSimulating || !processes.length}
                      className="h-11 px-5 rounded-full text-sm font-semibold text-white flex items-center gap-2 cursor-pointer spring-btn whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{
                        background: 'var(--primary-action)',
                        boxShadow: '0 10px 26px rgba(10,132,255,0.42), inset 0 1px 1px rgba(255,255,255,0.45)',
                      }}
                    >
                      <Play className="w-4 h-4 fill-current" />
                      <span>{isSimulating ? 'Running...' : 'Run Simulation'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleLoadSample}
                      disabled={isSimulating}
                      className="h-11 px-4 rounded-full bg-neutral-ui/10 hover:bg-neutral-ui/18 border border-neutral-ui/20 text-sm font-semibold flex items-center gap-2 cursor-pointer spring-btn whitespace-nowrap"
                    >
                      <Sparkles className="w-4 h-4 text-info" />
                      <span>Load Sample Data</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRandomize}
                      disabled={isSimulating}
                      className="h-11 px-4 rounded-full bg-neutral-ui/10 hover:bg-neutral-ui/18 border border-neutral-ui/20 text-sm font-semibold flex items-center gap-2 cursor-pointer spring-btn whitespace-nowrap"
                    >
                      <Shuffle className="w-4 h-4 text-accent" />
                      <span>Random Generator</span>
                    </button>
                  </div>
                </div>

                {/* Add / Manage Processes */}
                <div className="liquid-glass p-5 sm:p-6">
                  <div className="mb-4 flex items-center justify-between gap-2">
                    <div>
                      <h2 className="text-[17px] font-bold">
                        Process Queue ({processes.length}/{SIM_LIMITS.MAX_PROCS})
                      </h2>
                      <p className="text-xs text-muted mt-0.5">Lower priority number = higher urgency</p>
                    </div>
                    <button
                      type="button"
                      onClick={handleClearProcesses}
                      disabled={isSimulating || !processes.length}
                      className="h-8 px-3 rounded-full bg-neutral-ui/8 hover:bg-neutral-ui/16 border border-neutral-ui/16 text-xs font-semibold cursor-pointer spring-btn disabled:opacity-45 disabled:cursor-not-allowed"
                    >
                      Clear
                    </button>
                  </div>
                  <form onSubmit={handleAddProcess}>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <label className="block">
                        <span className="text-[11px] font-semibold text-muted block mb-1">PID</span>
                        <input
                          value={newPid}
                          maxLength={SIM_LIMITS.PID_MAX_LEN}
                          onChange={(e) => {
                            setNewPid(e.target.value);
                            if (formError) setFormError(null);
                          }}
                          className="w-full h-10 px-3 rounded-xl panel-inset border border-neutral-ui/18 text-sm text-ink outline-none focus:border-[#0A84FF]"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] font-semibold text-muted block mb-1">Arrival (0–500)</span>
                        <input
                          type="number"
                          min={SIM_LIMITS.MIN_ARRIVAL}
                          max={SIM_LIMITS.MAX_ARRIVAL}
                          value={newArrival}
                          onChange={(e) => {
                            setNewArrival(e.target.value);
                            if (formError) setFormError(null);
                          }}
                          className="w-full h-10 px-3 rounded-xl panel-inset border border-neutral-ui/18 text-sm text-ink tabular-nums outline-none focus:border-[#0A84FF]"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] font-semibold text-muted block mb-1">Burst (1–200)</span>
                        <input
                          type="number"
                          min={SIM_LIMITS.MIN_BURST}
                          max={SIM_LIMITS.MAX_BURST}
                          value={newBurst}
                          onChange={(e) => {
                            setNewBurst(e.target.value);
                            if (formError) setFormError(null);
                          }}
                          className="w-full h-10 px-3 rounded-xl panel-inset border border-neutral-ui/18 text-sm text-ink tabular-nums outline-none focus:border-[#0A84FF]"
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] font-semibold text-muted block mb-1">Priority (1–99)</span>
                        <input
                          type="number"
                          min={SIM_LIMITS.MIN_PRIORITY}
                          max={SIM_LIMITS.MAX_PRIORITY}
                          value={newPriority}
                          onChange={(e) => {
                            setNewPriority(e.target.value);
                            if (formError) setFormError(null);
                          }}
                          className="w-full h-10 px-3 rounded-xl panel-inset border border-neutral-ui/18 text-sm text-ink tabular-nums outline-none focus:border-[#0A84FF]"
                        />
                      </label>
                    </div>
                    {formError && (
                      <p className="text-xs text-danger mt-2" role="alert">
                        {formError}
                      </p>
                    )}
                    <div className="mt-3">
                      <button
                        type="submit"
                        disabled={processes.length >= SIM_LIMITS.MAX_PROCS}
                        className="h-9 px-4 rounded-full bg-[#30D158]/25 hover:bg-[#30D158]/35 border border-[#30D158]/45 text-xs font-semibold text-ink inline-flex items-center gap-1.5 cursor-pointer spring-btn disabled:opacity-45 disabled:cursor-not-allowed"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add Process</span>
                      </button>
                    </div>
                  </form>
                  <div className="mt-3 max-h-[168px] overflow-y-auto overflow-x-auto">
                    <table className="w-full text-sm tabular-nums">
                      <thead>
                        <tr className="text-left text-xs text-muted border-b border-neutral-ui/12">
                          <th className="py-2 pr-2">PID</th>
                          <th className="py-2 px-2">Arrival</th>
                          <th className="py-2 px-2">Burst</th>
                          <th className="py-2 px-2">Priority</th>
                          <th className="py-2 pl-2 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {processes.map((p, idx) => (
                          <tr key={`${p.pid}-${idx}`} className="border-b border-neutral-ui/6 hover:bg-neutral-ui/5">
                            <td className="py-2 pr-2 font-semibold flex items-center gap-2">
                              <span
                                className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
                                style={{ background: PROC_SOLID[pidColorIndex[p.pid] ?? 0] }}
                              />
                              {p.pid}
                            </td>
                            <td className="py-2 px-2">{p.arrival}</td>
                            <td className="py-2 px-2">{p.burst}</td>
                            <td className="py-2 px-2">{p.priority}</td>
                            <td className="py-2 pl-2 text-right">
                              <button
                                type="button"
                                onClick={() => {
                                  resetReplayState();
                                  const next = processes.filter((_, i) => i !== idx);
                                  setProcesses(next);
                                  setNewPid(getNextSuggestedPid(next));
                                }}
                                className="text-danger hover:text-danger p-1 cursor-pointer"
                                title={`Remove ${p.pid}`}
                                aria-label={`Remove process ${p.pid}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                        {!processes.length && (
                          <tr>
                            <td colSpan={5} className="py-5 text-center text-xs text-muted">
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
              <div className="liquid-glass p-5 sm:p-6">
                <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                  <div>
                    <h2 className="text-[17px] font-bold">Live Multi-Core Execution Units</h2>
                    <p className="text-xs text-muted mt-0.5 tabular-nums">
                      {activeSnap
                        ? activeSnap.finished
                          ? `Replay Complete (Tick ${activeSnap.tick}) · Ready Queue: Empty · Completed: ${activeSnap.completed}/${simResult.processes.length}`
                          : `Live Tick ${Math.floor(playTick ?? 0)} · Ready Queue: ${
                              activeSnap.readyQueue.length ? activeSnap.readyQueue.join(', ') : 'Empty'
                            } · Completed: ${activeSnap.completed}/${simResult.processes.length}`
                        : 'Press Play Replay to animate processes moving across cores in real time'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleTogglePlay}
                      disabled={isSimulating || !simResult.metrics.makespan}
                      className="h-9 px-4 rounded-full text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer spring-btn disabled:opacity-45 disabled:cursor-not-allowed"
                      style={{
                        background: 'var(--primary-action)',
                        boxShadow: '0 6px 20px rgba(10,132,255,0.38)',
                      }}
                    >
                      {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                      <span>{isPlaying ? 'Pause' : 'Play Replay'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={resetReplayState}
                      className="h-9 px-3.5 rounded-full bg-neutral-ui/10 hover:bg-neutral-ui/18 border border-neutral-ui/18 text-xs font-semibold flex items-center gap-1.5 cursor-pointer spring-btn"
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
                        className={`p-4 rounded-2xl panel-inset border ${
                          isBusy ? 'border-[#0A84FF]/65' : 'border-neutral-ui/12 opacity-60'
                        }`}
                      >
                        <div className="flex items-center justify-between text-xs font-bold text-muted mb-2">
                          <span>CORE {c.core}</span>
                          <span className="text-info tabular-nums">{c.utilization.toFixed(1)}%</span>
                        </div>
                        <div
                          className="text-xl font-extrabold tracking-tight mb-2.5"
                          style={{
                            color:
                              livePid !== 'IDLE' && livePid !== 'ACTIVE'
                                ? PROC_SOLID[pidColorIndex[livePid] ?? 0]
                                : isBusy
                                  ? 'var(--ink)'
                                  : 'var(--muted)',
                          }}
                        >
                          {livePid}
                        </div>
                        <div className="h-1.5 rounded-full bg-neutral-ui/10 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.min(100, c.utilization)}%`,
                              background: 'linear-gradient(90deg, #0A84FF, #BF5AF2)',
                            }}
                          />
                        </div>
                        <div className="text-[11px] text-muted mt-2 tabular-nums">
                          Busy {c.busyTime}t · Idle {c.idleTime}t
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Multi-Core Gantt Chart */}
              <div className="liquid-glass p-5 sm:p-6">
                <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                  <div>
                    <h2 className="text-[17px] font-bold">Multi-Core Gantt Timeline</h2>
                    <p className="text-xs text-muted mt-0.5">
                      {simResult.algorithm}
                      {simResult.algorithm === 'Priority' ? ` (${simResult.priorityMode})` : ''} · {simResult.cores}{' '}
                      Cores · Makespan {simResult.metrics.makespan} ticks
                    </p>
                  </div>
                  <div className="text-xs font-bold text-info tabular-nums">
                    {isSimulating ? (
                      <span role="status">Building timeline…</span>
                    ) : (
                      <span ref={tickLabelRef}>
                        Tick: 0.0 / {simResult.metrics.makespan}
                      </span>
                    )}
                  </div>
                </div>

                {simResult.metrics.makespan > 0 ? (
                  <div className="overflow-x-auto px-3 pb-2" tabIndex={0} role="region" aria-label="Scrollable Gantt timeline">
                    <div className="relative min-w-[660px]">
                      <GanttTracks result={simResult} colors={PROC_SOLID} colorIndex={pidColorIndex} />
                      {playTick !== null && (
                        <div className="absolute left-[88px] right-0 top-0 bottom-7 pointer-events-none z-20" aria-hidden="true">
                          <div
                            ref={playheadRef}
                            className="timeline-playhead absolute inset-y-0 w-0.5 -translate-x-1/2"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="py-8 text-center text-xs text-muted">
                    No timeline data yet. Add processes and click Run Simulation.
                  </div>
                )}
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
                  <div key={k.label} className="liquid-glass p-4 rounded-2xl">
                    <div className="text-xs font-semibold text-muted mb-1">{k.label}</div>
                    <div className="text-2xl font-extrabold tracking-tight">
                      <AnimatedNumber value={k.val} decimals={k.dec} suffix={k.suf} />
                    </div>
                    <div className="text-[11px] text-muted mt-1">{k.hint}</div>
                  </div>
                ))}
              </div>

              {/* Per-Process Results Table */}
              <div className="liquid-glass p-5 sm:p-6">
                <h2 className="text-[17px] font-bold mb-1">Per-Process Scheduling Metrics</h2>
                <p className="text-xs text-muted mb-4">Exact Module 3 timing formulas</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm tabular-nums">
                    <thead>
                      <tr className="text-left text-xs text-muted border-b border-neutral-ui/14">
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
                        <tr key={`${p.pid}-${idx}`} className="border-b border-neutral-ui/6 hover:bg-neutral-ui/5">
                          <td className="py-2.5 pr-3 font-bold flex items-center gap-2">
                            <span
                              className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ background: PROC_SOLID[pidColorIndex[p.pid] ?? 0] }}
                            />
                            {p.pid}
                          </td>
                          <td className="py-2.5 px-3">{p.arrival}</td>
                          <td className="py-2.5 px-3">{p.burst}</td>
                          <td className="py-2.5 px-3">{p.priority}</td>
                          <td className="py-2.5 px-3">{p.firstStart >= 0 ? p.firstStart : '—'}</td>
                          <td className="py-2.5 px-3">{p.completion}</td>
                          <td className="py-2.5 px-3 font-bold text-info">{p.turnaround}</td>
                          <td className="py-2.5 px-3">{p.waiting}</td>
                          <td className="py-2.5 pl-3">{p.response}</td>
                        </tr>
                      ))}
                      {!simResult.processes.length && (
                        <tr>
                          <td colSpan={9} className="py-6 text-center text-xs text-muted">
                            No simulation results yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {(activeTab === 'hardware' || activeTab === 'processes') && (
            <section className="liquid-glass px-5 py-4" aria-labelledby="windows-agent-title">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <h2 id="windows-agent-title" className="text-sm font-bold">
                    {backendConnected ? 'Windows agent connected' : 'Connect your Windows PC'}
                  </h2>
                  {backendConnected ? (
                    <p className="text-xs text-muted">Showing live data from the Windows agent.</p>
                  ) : (
                    <p className="text-xs text-muted max-w-2xl">
                      Download and extract the C11 project on Windows. Run <code>build.bat</code> with MinGW,
                      then start <code>simulator.exe --allow-hosted</code> and select Connect. Allow local
                      network access if your browser asks.
                    </p>
                  )}
                </div>
                {backendConnected ? (
                  <button type="button" onClick={() => {
                    setAutoConnect(false);
                    disconnectAgent();
                  }}
                    className="h-9 px-3 rounded-full border border-neutral-ui/18 text-xs font-semibold cursor-pointer">
                    Disconnect
                  </button>
                ) : (
                  <button type="button" disabled={isConnecting || !canConnectToAgent} onClick={() => void connectAgent()}
                    className="h-9 px-4 rounded-full bg-[var(--primary-action)] text-white text-xs font-semibold cursor-pointer disabled:opacity-60">
                    {isConnecting ? 'Connecting…' : 'Connect Windows Agent'}
                  </button>
                )}
              </div>
              {!backendConnected && (
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs font-semibold text-info">
                  <a href={WINDOWS_SOURCE_URL} download="windows-c11-project.zip" className="hover:underline">Download Windows C11 ZIP</a>
                  <a href={LOCAL_DASHBOARD_URL} target="_blank" rel="noopener noreferrer" className="hover:underline">Open local dashboard</a>
                </div>
              )}
              {connectionError && <p className="mt-3 text-xs text-danger" role="alert">{connectionError}</p>}
            </section>
          )}

          {/* ================= TAB 2: LIVE HARDWARE MONITOR ================= */}
          {activeTab === 'hardware' && (
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="liquid-glass p-5">
                  <div className="text-xs font-semibold text-muted">{backendConnected ? 'Processor Model (Win32 Registry)' : 'Processor Model (Sample)'}</div>
                  <div className="text-base font-bold mt-2 leading-snug">{hwInfo.cpuModel}</div>
                </div>
                <div className="liquid-glass p-5">
                  <div className="text-xs font-semibold text-muted">Physical Cores</div>
                  <div className="text-3xl font-extrabold mt-1 tabular-nums">{hwInfo.physicalCores}</div>
                  <div className="text-[11px] text-muted mt-1">{backendConnected ? 'GetLogicalProcessorInformation' : 'Sample hardware topology'}</div>
                </div>
                <div className="liquid-glass p-5">
                  <div className="text-xs font-semibold text-muted">Logical Processors</div>
                  <div className="text-3xl font-extrabold mt-1 tabular-nums">{hwInfo.logicalProcessors}</div>
                  <div className="text-[11px] text-muted mt-1">{backendConnected ? 'Hardware execution threads' : 'Sample hardware topology'}</div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Circular CPU Gauge */}
                <div className="liquid-glass p-5 sm:p-6 flex items-center gap-6 flex-wrap">
                  <div className="relative w-36 h-36 shrink-0">
                    <svg className="w-36 h-36 -rotate-90" viewBox="0 0 140 140" role="img" aria-label={`CPU load ${liveCpu.toFixed(1)} percent`}>
                      <defs>
                        <linearGradient id="cpuGaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="#0A84FF" />
                          <stop offset="100%" stopColor="#64D2FF" />
                        </linearGradient>
                      </defs>
                      <circle cx="70" cy="70" r="56" fill="none" stroke="var(--stroke)" strokeWidth="12" />
                      <circle
                        cx="70"
                        cy="70"
                        r="56"
                        fill="none"
                        stroke="url(#cpuGaugeGrad)"
                        strokeWidth="12"
                        strokeLinecap="round"
                        strokeDasharray={gaugeCirc}
                        strokeDashoffset={gaugeCirc * (1 - Math.min(100, Math.max(0, liveCpu)) / 100)}
                        className="transition-all duration-500"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <div className="text-2xl font-extrabold">
                        <AnimatedNumber value={liveCpu} decimals={1} suffix="%" />
                      </div>
                      <div className="text-[11px] text-muted font-semibold">CPU Load</div>
                    </div>
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <h3 className="text-base font-bold">Live System CPU Utilization</h3>
                    <p className="text-xs text-muted mt-1.5 leading-relaxed">
                      {backendConnected
                        ? <>Measured using <code className="text-info">GetSystemTimes</code>.</>
                        : 'Simulated CPU usage.'}
                      across idle, kernel, and user time counters.
                    </p>
                  </div>
                </div>

                {/* Circular RAM Gauge */}
                <div className="liquid-glass p-5 sm:p-6 flex items-center gap-6 flex-wrap">
                  <div className="relative w-36 h-36 shrink-0">
                    <svg className="w-36 h-36 -rotate-90" viewBox="0 0 140 140" role="img" aria-label={`RAM usage ${liveRamPct.toFixed(1)} percent`}>
                      <defs>
                        <linearGradient id="ramGaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="#BF5AF2" />
                          <stop offset="100%" stopColor="#FF9F0A" />
                        </linearGradient>
                      </defs>
                      <circle cx="70" cy="70" r="56" fill="none" stroke="var(--stroke)" strokeWidth="12" />
                      <circle
                        cx="70"
                        cy="70"
                        r="56"
                        fill="none"
                        stroke="url(#ramGaugeGrad)"
                        strokeWidth="12"
                        strokeLinecap="round"
                        strokeDasharray={gaugeCirc}
                        strokeDashoffset={gaugeCirc * (1 - Math.min(100, Math.max(0, liveRamPct)) / 100)}
                        className="transition-all duration-500"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <div className="text-2xl font-extrabold">
                        <AnimatedNumber value={liveRamPct} decimals={1} suffix="%" />
                      </div>
                      <div className="text-[11px] text-muted font-semibold">Memory</div>
                    </div>
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <h3 className="text-base font-bold">Live Physical Memory (RAM)</h3>
                    <div className="text-sm font-semibold text-ink mt-1.5 tabular-nums">
                      {liveRamUsedGB.toFixed(2)} GB / {liveRamTotalGB.toFixed(2)} GB used
                    </div>
                    <p className="text-xs text-muted mt-1">
                      {backendConnected
                        ? <>Measured using <code className="text-accent">GlobalMemoryStatusEx</code>.</>
                        : 'Simulated RAM usage.'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="liquid-glass p-5 sm:p-6">
                  <h3 className="text-base font-bold mb-1">CPU Utilization — Last 60 Seconds</h3>
                  <p className="text-xs text-muted mb-4">{backendConnected ? 'Live Windows readings' : 'Simulated preview readings'}</p>
                  <LiveSparkChart data={cpuSeries} stroke="#0A84FF" gradientId="cpuAreaFill" />
                </div>
                <div className="liquid-glass p-5 sm:p-6">
                  <h3 className="text-base font-bold mb-1">RAM Utilization — Last 60 Seconds</h3>
                  <p className="text-xs text-muted mb-4">{backendConnected ? 'Live Windows readings' : 'Simulated preview readings'}</p>
                  <LiveSparkChart data={ramSeries} stroke="#BF5AF2" gradientId="ramAreaFill" />
                </div>
              </div>
            </div>
          )}

          {/* ================= TAB 3: PROCESS MONITOR ================= */}
          {activeTab === 'processes' && (
            <div className="flex flex-col gap-5">
              <div className="liquid-glass p-5 sm:p-6">
                <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                  <div>
                    <h2 className="text-[17px] font-bold">Approved Application Launcher (Hardcoded Whitelist)</h2>
                    <p className="text-xs text-muted mt-0.5">
                      Spawns only verified executables via <code className="text-info">CreateProcessA</code> + optional{' '}
                      <code className="text-accent">SetProcessAffinityMask</code>
                    </p>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <label htmlFor="pinCoreSelect" className="text-xs font-semibold text-muted">
                      Pin to Core:
                    </label>
                    <select
                      id="pinCoreSelect"
                      value={pinCore}
                      onChange={(e) => setPinCore(Number(e.target.value))}
                      disabled={!backendConnected || !hwInfo.affinityCores?.length || launchingApp !== null}
                      className="h-9 px-3 rounded-xl panel-inset border border-neutral-ui/18 text-xs text-ink outline-none focus:border-[#0A84FF] disabled:opacity-50"
                    >
                      <option value={-1}>OS Default (Auto)</option>
                      {hwInfo.affinityCores?.map((core) => (
                        <option key={core} value={core}>
                          Core {core}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    disabled={!backendConnected || launchingApp !== null}
                    onClick={() => handleLaunchApp('chrome')}
                    className="h-10 px-5 rounded-full text-xs font-semibold text-ink cursor-pointer spring-btn disabled:opacity-55 disabled:cursor-not-allowed"
                    style={{ background: 'linear-gradient(135deg, #0A84FF, #38BDF8)' }}
                  >
                    {launchingApp === 'chrome' ? 'Launching...' : 'Launch Chrome'}
                  </button>
                  <button
                    type="button"
                    disabled={!backendConnected || launchingApp !== null}
                    onClick={() => handleLaunchApp('vscode')}
                    className="h-10 px-5 rounded-full text-xs font-semibold text-ink cursor-pointer spring-btn disabled:opacity-55 disabled:cursor-not-allowed"
                    style={{ background: 'linear-gradient(135deg, #5E5CE6, #BF5AF2)' }}
                  >
                    {launchingApp === 'vscode' ? 'Launching...' : 'Launch VS Code'}
                  </button>
                  <button
                    type="button"
                    disabled={!backendConnected || launchingApp !== null}
                    onClick={() => handleLaunchApp('notepad')}
                    className="h-10 px-5 rounded-full bg-[#30D158]/25 border border-[#30D158]/45 text-xs font-semibold text-ink cursor-pointer spring-btn disabled:opacity-55 disabled:cursor-not-allowed"
                  >
                    {launchingApp === 'notepad' ? 'Launching...' : 'Launch Notepad'}
                  </button>
                  <button
                    type="button"
                    disabled={!backendConnected || launchingApp !== null}
                    onClick={() => handleLaunchApp('calculator')}
                    className="h-10 px-5 rounded-full bg-[#FF9F0A]/25 border border-[#FF9F0A]/45 text-xs font-semibold text-ink cursor-pointer spring-btn disabled:opacity-55 disabled:cursor-not-allowed"
                  >
                    {launchingApp === 'calculator' ? 'Launching...' : 'Launch Calculator'}
                  </button>
                </div>
                {!backendConnected && (
                  <p className="text-xs text-muted mt-3">Connect the Windows agent to launch applications.</p>
                )}
                {launchNotice && (
                  <p role={launchNotice.error ? 'alert' : 'status'} className={`mt-3 text-xs ${launchNotice.error ? 'text-danger' : 'text-success'}`}>
                    {launchNotice.message}
                  </p>
                )}
              </div>

              <div className="liquid-glass p-5 sm:p-6">
                <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                  <div>
                    <h2 className="text-[17px] font-bold">
                      {backendConnected ? 'Running Windows Processes' : 'Sample Process List'}{' '}
                      (<span className="tabular-nums">{filteredOsProcs.length}</span>)
                    </h2>
                    <p className="text-xs text-muted mt-0.5">
                      {backendConnected ? 'Toolhelp32Snapshot + GetProcessMemoryInfo.' : 'Example processes for exploring search and sorting.'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2.5 flex-wrap w-full sm:w-auto">
                    <div className="relative flex-1 sm:flex-initial">
                      <Search className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        value={procSearch}
                        onChange={(e) => setProcSearch(e.target.value)}
                        placeholder="Search process or PID..."
                        aria-label="Search process or PID"
                        className="h-9 pl-9 pr-8 rounded-full panel-inset border border-neutral-ui/18 text-xs text-ink outline-none focus:border-[#0A84FF] w-full sm:w-56"
                      />
                      {procSearch && (
                        <button
                          type="button"
                          onClick={() => setProcSearch('')}
                          aria-label="Clear search"
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={!backendConnected || isRefreshingProcs}
                      onClick={() => fetchOsProcesses(true)}
                      className="h-9 px-3.5 rounded-full bg-neutral-ui/10 hover:bg-neutral-ui/18 border border-neutral-ui/18 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer spring-btn disabled:opacity-60"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingProcs ? 'animate-spin' : ''}`} />
                      <span>{isRefreshingProcs ? 'Refreshing...' : 'Refresh'}</span>
                    </button>
                  </div>
                </div>

                {processLoadError && (
                  <p className="mb-3 text-xs text-danger" role="alert">Could not refresh the Windows process list. Select Refresh to retry.</p>
                )}
                <div className="overflow-x-auto max-h-[420px]">
                  <table className="w-full text-sm tabular-nums">
                    <thead>
                      <tr className="text-left text-xs text-muted border-b border-neutral-ui/14">
                        {([
                          { key: 'name', label: 'Process Name', padding: 'pr-4', defaultDir: 1 },
                          { key: 'pid', label: 'PID', padding: 'px-4', defaultDir: 1 },
                          { key: 'memoryMB', label: 'Working Set Memory (MB)', padding: 'pl-4', defaultDir: -1 },
                        ] as const).map(({ key, label, padding, defaultDir }) => (
                          <th key={key} scope="col" className={`py-2.5 ${padding}`}
                            aria-sort={procSort.key === key ? (procSort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                            <button type="button" className="cursor-pointer text-left hover:text-ink"
                              onClick={() => setProcSort((sort) => ({
                                key,
                                dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : defaultDir,
                              }))}>
                              {label} <span aria-hidden="true">{sortArrow(key)}</span>
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOsProcs.map((p) => (
                        <tr
                          key={`${p.pid}-${p.name}`}
                          className={`border-b border-neutral-ui/6 hover:bg-neutral-ui/5 transition-colors ${
                            p.isNew ? 'bg-[#30D158]/15' : ''
                          }`}
                        >
                          <td className="py-2.5 pr-4 font-semibold">{p.name}</td>
                          <td className="py-2.5 px-4 text-ink">{p.pid}</td>
                          <td className="py-2.5 pl-4 font-medium">{p.memoryMB.toFixed(2)} MB</td>
                        </tr>
                      ))}
                      {!filteredOsProcs.length && (
                        <tr>
                          <td colSpan={3} className="py-8 text-center text-xs text-muted">
                            {liveProcesses === null && backendConnected
                              ? processLoadError ? 'Process list unavailable.' : 'Loading Windows processes…'
                              : procSearch ? <>No processes match “{procSearch}”.</> : 'No processes found.'}
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
            <div className="flex flex-col gap-5">
              <div className="liquid-glass p-5 sm:p-6 flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <h2 className="text-[17px] font-bold">Multi-Algorithm Comparative Analysis</h2>
                  <p className="text-xs text-muted mt-0.5">
                    Runs all 5 scheduling algorithms on the identical workload ({processes.length} processes, {cores} cores, Q=
                    {quantum}, {priorityMode})
                  </p>
                </div>
                <div className="flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    disabled={isComparing || !processes.length}
                    onClick={() => executeCompareAll(false)}
                    className="h-10 px-5 rounded-full text-xs font-semibold text-white cursor-pointer spring-btn disabled:opacity-45 disabled:cursor-not-allowed"
                    style={{
                      background: 'var(--primary-action)',
                      boxShadow: '0 8px 24px rgba(10,132,255,0.4)',
                    }}
                  >
                    {isComparing ? 'Comparing...' : 'Compare All Algorithms'}
                  </button>
                  <button
                    type="button"
                    disabled={!processes.length && !simResult.processes.length}
                    onClick={handleDownloadCsv}
                    className="h-10 px-5 rounded-full bg-[#30D158]/25 hover:bg-[#30D158]/35 border border-[#30D158]/45 text-xs font-semibold text-ink inline-flex items-center gap-2 cursor-pointer spring-btn disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download CSV Report</span>
                  </button>
                </div>
              </div>

              {!processes.length ? (
                <div className="liquid-glass p-8 text-center space-y-3">
                  <p className="text-sm font-semibold text-ink">Process queue is currently empty</p>
                  <p className="text-xs text-muted">
                    Add processes in the Scheduling Simulator tab or load sample data to compare all 5 algorithms.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      handleLoadSample();
                      setActiveTab('analytics');
                    }}
                    className="h-9 px-4 rounded-full bg-neutral-ui/12 hover:bg-neutral-ui/20 border border-neutral-ui/20 text-xs font-semibold inline-flex items-center gap-2 cursor-pointer spring-btn"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-info" />
                    <span>Load Sample Workload</span>
                  </button>
                </div>
              ) : compareError ? (
                <div className="liquid-glass p-6 text-sm" role="alert">{compareError}</div>
              ) : isComparing || lastComparedSignature !== workloadSignature ? (
                <div className="liquid-glass p-6 text-sm" role="status">Comparing scheduling algorithms…</div>
              ) : (
                <>
                  <div className="liquid-glass p-5 sm:p-6">
                    <h3 className="text-base font-bold mb-1">Comparative Metrics Matrix</h3>
                    <p className="text-xs text-muted mb-4">Best algorithm for each metric is highlighted in green</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm tabular-nums">
                        <thead>
                          <tr className="text-left text-xs text-muted border-b border-neutral-ui/14">
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
                              <tr key={r.algorithm} className="border-b border-neutral-ui/6 hover:bg-neutral-ui/5">
                                <td className="py-3 pr-3 font-bold">{r.algorithm}</td>
                                <td className={`py-3 px-3 ${r.algorithm === b.avgWaiting ? 'text-success font-extrabold' : ''}`}>
                                  {m.avgWaiting.toFixed(2)} {r.algorithm === b.avgWaiting && '★'}
                                </td>
                                <td className={`py-3 px-3 ${r.algorithm === b.avgTurnaround ? 'text-success font-extrabold' : ''}`}>
                                  {m.avgTurnaround.toFixed(2)} {r.algorithm === b.avgTurnaround && '★'}
                                </td>
                                <td className={`py-3 px-3 ${r.algorithm === b.avgResponse ? 'text-success font-extrabold' : ''}`}>
                                  {m.avgResponse.toFixed(2)} {r.algorithm === b.avgResponse && '★'}
                                </td>
                                <td className={`py-3 px-3 ${r.algorithm === b.cpuUtilization ? 'text-success font-extrabold' : ''}`}>
                                  {m.cpuUtilization.toFixed(2)}% {r.algorithm === b.cpuUtilization && '★'}
                                </td>
                                <td className="py-3 px-3">{m.throughput.toFixed(4)}</td>
                                <td className={`py-3 px-3 ${r.algorithm === b.contextSwitches ? 'text-success font-extrabold' : ''}`}>
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
                    <div className="liquid-glass p-5 sm:p-6">
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
                              <div className="flex justify-between gap-2 flex-wrap text-xs font-semibold mb-1.5">
                                <span>{r.algorithm}</span>
                                <span className="text-muted tabular-nums">
                                  WT {r.metrics.avgWaiting.toFixed(2)} · TAT {r.metrics.avgTurnaround.toFixed(2)} · RT{' '}
                                  {r.metrics.avgResponse.toFixed(2)}
                                </span>
                              </div>
                              <div className="space-y-1">
                                <div className="h-2 rounded-full bg-neutral-ui/8 overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-[#0A84FF] transition-all duration-500"
                                    style={{ width: `${(r.metrics.avgWaiting / maxVal) * 100}%` }}
                                  />
                                </div>
                                <div className="h-2 rounded-full bg-neutral-ui/8 overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-[#BF5AF2] transition-all duration-500"
                                    style={{ width: `${(r.metrics.avgTurnaround / maxVal) * 100}%` }}
                                  />
                                </div>
                                <div className="h-2 rounded-full bg-neutral-ui/8 overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-[#FF9F0A] transition-all duration-500"
                                    style={{ width: `${(r.metrics.avgResponse / maxVal) * 100}%` }}
                                  />
                                </div>
                              </div>
                            </div>
                          ));
                        })()}
                      </div>
                      <div className="flex flex-wrap gap-4 mt-4 text-[11px] text-muted">
                        <span className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-[#0A84FF]" />
                          Avg Waiting
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-[#BF5AF2]" />
                          Avg Turnaround
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-[#FF9F0A]" />
                          Avg Response
                        </span>
                      </div>
                    </div>

                    <div className="liquid-glass p-5 sm:p-6">
                      <h3 className="text-base font-bold mb-4">CPU Utilization (%) &amp; Context Switches</h3>
                      <div className="space-y-4">
                        {(() => {
                          const maxCs = Math.max(1, ...compareResult.results.map((r) => r.metrics.contextSwitches));
                          return compareResult.results.map((r) => (
                            <div key={r.algorithm}>
                              <div className="flex justify-between gap-2 flex-wrap text-xs font-semibold mb-1.5">
                                <span>{r.algorithm}</span>
                                <span className="text-muted tabular-nums">
                                  CPU {r.metrics.cpuUtilization.toFixed(1)}% · CS {r.metrics.contextSwitches}
                                </span>
                              </div>
                              <div className="space-y-1">
                                <div className="h-2.5 rounded-full bg-neutral-ui/8 overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-[#30D158] transition-all duration-500"
                                    style={{ width: `${Math.min(100, r.metrics.cpuUtilization)}%` }}
                                  />
                                </div>
                                <div className="h-2 rounded-full bg-neutral-ui/8 overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-[#FF453A] transition-all duration-500"
                                    style={{ width: `${(r.metrics.contextSwitches / maxCs) * 100}%` }}
                                  />
                                </div>
                              </div>
                            </div>
                          ));
                        })()}
                      </div>
                      <div className="flex flex-wrap gap-4 mt-4 text-[11px] text-muted">
                        <span className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-[#30D158]" />
                          CPU Utilization %
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-[#FF453A]" />
                          Context Switches
                        </span>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Mandatory Footer Note */}
          <footer className="liquid-glass px-5 py-3.5 text-center text-xs text-muted">
            Scheduling uses the process queue you enter. Connect the Windows agent to monitor your PC and launch apps.
          </footer>
        </main>
      </div>

      {/* Windows C11 Project Source Modal */}
      {codeDrawerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="c11-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCodeDrawerOpen(false);
          }}
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3 sm:p-4"
        >
          <div className="liquid-glass w-full max-w-6xl h-[88vh] flex flex-col overflow-hidden panel-inset">
            <div className="px-4 sm:px-6 py-4 border-b border-neutral-ui/14 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 id="c11-modal-title" className="text-sm sm:text-base font-bold truncate">
                  Windows C11 / MinGW Project Bundle (8 Files)
                </h2>
                <p className="text-[11px] sm:text-xs text-muted truncate">
                  Compile with:{' '}
                  <code className="text-info">
                    gcc -std=c11 -O2 -Wall -Wextra server.c scheduler.c monitor.c -o simulator.exe -lws2_32 -lpsapi -ladvapi32
                  </code>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCodeDrawerOpen(false)}
                aria-label="Close source viewer"
                className="w-9 h-9 rounded-full bg-neutral-ui/10 hover:bg-neutral-ui/20 flex items-center justify-center cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-4 py-2.5 border-b border-neutral-ui/12">
              <a href={WINDOWS_SOURCE_URL} download="windows-c11-project.zip"
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--primary-action)] text-white px-3 py-2 text-xs font-semibold">
                <Download className="w-3.5 h-3.5" />
                Download all 8 files (ZIP)
              </a>
            </div>
            <div className="flex-1 grid grid-rows-[auto_minmax(0,1fr)] md:grid-rows-1 md:grid-cols-[240px_minmax(0,1fr)] min-h-0">
              <div className="border-b md:border-b-0 md:border-r border-neutral-ui/12 p-3 overflow-y-auto max-h-44 md:max-h-none space-y-1.5">
                {C_PROJECT_FILES.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => {
                      if (selectedFile === f.name) return;
                      setSelectedFile(f.name);
                      setFileError(null);
                      setFileReloadNonce(0);
                    }}
                    className={`w-full text-left px-3.5 py-2.5 rounded-xl transition-all cursor-pointer ${
                      selectedFile === f.name
                        ? 'bg-[#0A84FF]/30 border border-[#0A84FF]/50 text-ink'
                        : 'hover:bg-neutral-ui/8 text-muted border border-transparent'
                    }`}
                  >
                    <div className="text-xs font-bold font-mono-tabular">{f.label}</div>
                    <div className="text-[11px] text-muted truncate mt-0.5">{f.desc}</div>
                  </button>
                ))}
              </div>
              <div className="flex flex-col min-h-0">
                <div className="px-4 py-2.5 border-b border-neutral-ui/10 flex items-center justify-between gap-2 bg-neutral-ui/5 flex-wrap">
                  <span className="text-xs font-bold font-mono-tabular text-info">{selectedFile}</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={fileLoading || !fileContents[selectedFile]}
                      onClick={handleCopySource}
                      className="h-8 px-3 rounded-full bg-neutral-ui/10 hover:bg-neutral-ui/20 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                    >
                      {copiedFile === selectedFile ? (
                        <Check className="w-3.5 h-3.5 text-success" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>{copiedFile === selectedFile ? 'Copied' : 'Copy'}</span>
                    </button>
                    <a
                      href={`/windows-c-project/${selectedFile}`}
                      download={selectedFile}
                      className="h-8 px-3 rounded-full bg-[#0A84FF]/30 hover:bg-[#0A84FF]/45 border border-[#0A84FF]/50 text-xs font-semibold inline-flex items-center gap-1.5 text-ink"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download</span>
                    </a>
                  </div>
                </div>
                {fileError ? (
                  <div className="flex-1 p-6 flex flex-col items-center justify-center gap-3 text-center panel-inset">
                    <p className="text-xs text-danger">{fileError}</p>
                    <button
                      type="button"
                      onClick={() => setFileReloadNonce((n) => n + 1)}
                      className="h-8 px-4 rounded-full bg-neutral-ui/12 hover:bg-neutral-ui/20 text-xs font-semibold cursor-pointer"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <pre className="flex-1 p-4 overflow-auto text-xs font-mono-tabular text-ink leading-relaxed panel-inset">
                    <code>{fileLoading && !fileContents[selectedFile] ? 'Loading source file...' : fileContents[selectedFile] || ''}</code>
                  </pre>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Glass Toast Stack */}
      <div
        aria-live="polite"
        className="fixed bottom-4 right-4 left-4 sm:left-auto sm:bottom-5 sm:right-5 z-50 flex flex-col gap-2.5 pointer-events-none sm:max-w-md"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto px-4 py-3 rounded-2xl panel-inset border border-neutral-ui/24 shadow-2xl text-xs font-semibold text-ink flex items-center gap-2.5"
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: t.color, boxShadow: `0 0 10px ${t.color}` }}
            />
            <span className="break-words">{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
