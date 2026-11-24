export type AlgorithmType = 'FCFS' | 'SJF' | 'SRTF' | 'Priority' | 'Round Robin';
export type PriorityMode = 'preemptive' | 'non-preemptive';

export const SIM_LIMITS = {
  MAX_PROCS: 64,
  MIN_CORES: 1,
  MAX_CORES: 8,
  MIN_QUANTUM: 1,
  MAX_QUANTUM: 50,
  MIN_ARRIVAL: 0,
  MAX_ARRIVAL: 500,
  MIN_BURST: 1,
  MAX_BURST: 200,
  MIN_PRIORITY: 1,
  MAX_PRIORITY: 99,
  PID_MAX_LEN: 15,
  MAX_SIM_TICKS: 20000,
} as const;

export interface ProcessInput {
  pid: string;
  arrival: number;
  burst: number;
  priority: number;
}

export interface ProcessResult extends ProcessInput {
  firstStart: number;
  completion: number;
  turnaround: number;
  waiting: number;
  response: number;
}

export interface GanttSegment {
  core: number;
  pid: string;
  idle: boolean;
  start: number;
  end: number;
}

export interface TickSnapshot {
  tick: number;
  completed: number;
  cores: string[];
  readyQueue: string[];
}

export interface CoreUtilization {
  core: number;
  utilization: number;
  busyTime: number;
  idleTime: number;
}

export interface SimMetrics {
  avgTurnaround: number;
  avgWaiting: number;
  avgResponse: number;
  throughput: number;
  cpuUtilization: number;
  makespan: number;
  totalBusyTime: number;
  totalIdleTime: number;
  contextSwitches: number;
  coreUtilization: CoreUtilization[];
}

export interface SimResult {
  algorithm: AlgorithmType;
  cores: number;
  quantum: number;
  priorityMode: PriorityMode;
  processes: ProcessResult[];
  gantt: GanttSegment[];
  ticks: TickSnapshot[];
  metrics: SimMetrics;
  truncated?: boolean;
}

export interface CompareResponse {
  results: SimResult[];
  best: {
    avgWaiting: AlgorithmType;
    avgTurnaround: AlgorithmType;
    avgResponse: AlgorithmType;
    cpuUtilization: AlgorithmType;
    contextSwitches: AlgorithmType;
  };
}

export const SAMPLE_WORKLOAD: ProcessInput[] = [
  { pid: 'P1', arrival: 0, burst: 8, priority: 3 },
  { pid: 'P2', arrival: 1, burst: 4, priority: 1 },
  { pid: 'P3', arrival: 2, burst: 9, priority: 4 },
  { pid: 'P4', arrival: 3, burst: 5, priority: 2 },
  { pid: 'P5', arrival: 4, burst: 2, priority: 5 },
];

export function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function validateProcessInput(
  candidate: { pid: string; arrival: number; burst: number; priority: number },
  existing: ProcessInput[]
): { ok: true; value: ProcessInput } | { ok: false; error: string } {
  if (existing.length >= SIM_LIMITS.MAX_PROCS) {
    return { ok: false, error: `Maximum of ${SIM_LIMITS.MAX_PROCS} processes reached.` };
  }

  const trimmedPid = candidate.pid.trim();
  if (!trimmedPid) {
    return { ok: false, error: 'Process ID (PID) is required.' };
  }
  if (trimmedPid.length > SIM_LIMITS.PID_MAX_LEN) {
    return { ok: false, error: `PID must be ${SIM_LIMITS.PID_MAX_LEN} characters or fewer.` };
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmedPid)) {
    return { ok: false, error: 'PID may only contain letters, numbers, "_", "-", or ".".' };
  }
  if (trimmedPid.toUpperCase() === 'IDLE') {
    return { ok: false, error: '"IDLE" is reserved for idle core segments.' };
  }
  if (existing.some((p) => p.pid.toLowerCase() === trimmedPid.toLowerCase())) {
    return { ok: false, error: `PID "${trimmedPid}" already exists in the queue.` };
  }

  if (!Number.isFinite(candidate.arrival) || candidate.arrival < SIM_LIMITS.MIN_ARRIVAL || candidate.arrival > SIM_LIMITS.MAX_ARRIVAL) {
    return {
      ok: false,
      error: `Arrival time must be between ${SIM_LIMITS.MIN_ARRIVAL} and ${SIM_LIMITS.MAX_ARRIVAL}.`,
    };
  }
  if (!Number.isFinite(candidate.burst) || candidate.burst < SIM_LIMITS.MIN_BURST || candidate.burst > SIM_LIMITS.MAX_BURST) {
    return {
      ok: false,
      error: `Burst time must be between ${SIM_LIMITS.MIN_BURST} and ${SIM_LIMITS.MAX_BURST}.`,
    };
  }
  if (!Number.isFinite(candidate.priority) || candidate.priority < SIM_LIMITS.MIN_PRIORITY || candidate.priority > SIM_LIMITS.MAX_PRIORITY) {
    return {
      ok: false,
      error: `Priority must be between ${SIM_LIMITS.MIN_PRIORITY} and ${SIM_LIMITS.MAX_PRIORITY}.`,
    };
  }

  return {
    ok: true,
    value: {
      pid: trimmedPid,
      arrival: Math.floor(candidate.arrival),
      burst: Math.floor(candidate.burst),
      priority: Math.floor(candidate.priority),
    },
  };
}

/**
 * Exact 1:1 TypeScript mirror of scheduler.c's multi-core tick-based engine
 * (identical ready queue ordering, preemption logic, RR requeueing, context switch
 * counting, and Module 3 formulas) so browser preview matches simulator.exe --test.
 */
export function runMultiCoreSimulation(
  inputs: ProcessInput[],
  algorithm: AlgorithmType,
  numCoresRaw: number,
  quantumRaw: number,
  priorityMode: PriorityMode,
  includeTimeline = true
): SimResult {
  const numCores = clampInt(numCoresRaw, SIM_LIMITS.MIN_CORES, SIM_LIMITS.MAX_CORES, 2);
  const quantum = clampInt(quantumRaw, SIM_LIMITS.MIN_QUANTUM, SIM_LIMITS.MAX_QUANTUM, 3);
  const priorityPreemptive = priorityMode === 'preemptive';

  const boundedInputs = inputs.slice(0, SIM_LIMITS.MAX_PROCS);
  const procs = boundedInputs.map((p, idx) => {
    const burst = clampInt(p.burst, SIM_LIMITS.MIN_BURST, SIM_LIMITS.MAX_BURST, 1);
    return {
      pid: p.pid.trim().slice(0, SIM_LIMITS.PID_MAX_LEN) || `P${idx + 1}`,
      arrival: clampInt(p.arrival, SIM_LIMITS.MIN_ARRIVAL, SIM_LIMITS.MAX_ARRIVAL, 0),
      burst,
      priority: clampInt(p.priority, SIM_LIMITS.MIN_PRIORITY, SIM_LIMITS.MAX_PRIORITY, 1),
      remaining: burst,
      firstStart: -1,
      completion: 0,
      state: 'NEW' as 'NEW' | 'READY' | 'RUNNING' | 'COMPLETED',
    };
  });

  const cores = Array.from({ length: numCores }, () => ({
    assignedProc: -1,
    lastProc: -1,
    busyTime: 0,
    idleTime: 0,
    quantumUsed: 0,
  }));

  const readyQueue: number[] = [];
  let rrRequeue: number[] = [];
  const segments: GanttSegment[] = [];
  const ticks: TickSnapshot[] = [];

  let completedCount = 0;
  let contextSwitches = 0;
  let makespan = 0;
  let truncated = false;

  const selectBestPos = (): number => {
    if (readyQueue.length === 0) return -1;
    if (algorithm === 'FCFS' || algorithm === 'Round Robin') return 0;
    let bestPos = 0;
    for (let i = 1; i < readyQueue.length; i++) {
      const cand = procs[readyQueue[i]];
      const best = procs[readyQueue[bestPos]];
      let better = false;
      if (algorithm === 'SJF') {
        if (cand.burst < best.burst || (cand.burst === best.burst && cand.arrival < best.arrival)) {
          better = true;
        }
      } else if (algorithm === 'SRTF') {
        if (cand.remaining < best.remaining || (cand.remaining === best.remaining && cand.arrival < best.arrival)) {
          better = true;
        }
      } else if (algorithm === 'Priority') {
        if (cand.priority < best.priority || (cand.priority === best.priority && cand.arrival < best.arrival)) {
          better = true;
        }
      }
      if (better) bestPos = i;
    }
    return bestPos;
  };

  const lastSegments: (GanttSegment | undefined)[] = Array(numCores).fill(undefined);
  const recordGantt = (coreId: number, procIdx: number, t: number) => {
    const label = procIdx >= 0 ? procs[procIdx].pid : 'IDLE';
    const isIdle = procIdx < 0;
    const last = lastSegments[coreId];
    if (last && last.end === t && last.idle === isIdle && last.pid === label) {
      last.end = t + 1;
      return;
    }
    const segment = { core: coreId, pid: label, idle: isIdle, start: t, end: t + 1 };
    lastSegments[coreId] = segment;
    segments.push(segment);
  };

  /** Merge a contiguous idle range [from, to) into the Gantt chart (fast-forward path). */
  const recordGanttRange = (coreId: number, from: number, to: number) => {
    const last = lastSegments[coreId];
    if (last && last.end === from && last.idle && last.pid === 'IDLE') {
      last.end = to;
      return;
    }
    const segment = { core: coreId, pid: 'IDLE', idle: true, start: from, end: to };
    lastSegments[coreId] = segment;
    segments.push(segment);
  };

  for (let t = 0; t <= SIM_LIMITS.MAX_SIM_TICKS; t++) {
    // 1. Arrivals
    for (let i = 0; i < procs.length; i++) {
      if (procs[i].state === 'NEW' && procs[i].arrival <= t) {
        procs[i].state = 'READY';
        readyQueue.push(i);
      }
    }

    // 2. Round Robin requeue
    for (const idx of rrRequeue) {
      procs[idx].state = 'READY';
      readyQueue.push(idx);
    }
    rrRequeue = [];

    // 3. Done check or safety cap
    if (completedCount >= procs.length || t >= SIM_LIMITS.MAX_SIM_TICKS) {
      makespan = t;
      if (completedCount < procs.length) {
        truncated = true;
      }
      break;
    }

    // 3.5 Fast-forward pure-idle gaps: when nothing is running or ready and no
    // RR requeue is pending, no execution can happen until the next arrival.
    // Bulk-advancing time yields identical processes, Gantt segments, and
    // metrics while skipping per-tick bookkeeping.
    if (readyQueue.length === 0 && rrRequeue.length === 0) {
      let allIdle = true;
      for (let c = 0; c < numCores; c++) {
        if (cores[c].assignedProc >= 0) {
          allIdle = false;
          break;
        }
      }
      if (allIdle) {
        let nextArrival = -1;
        for (let i = 0; i < procs.length; i++) {
          if (procs[i].state === 'NEW' && (nextArrival < 0 || procs[i].arrival < nextArrival)) {
            nextArrival = procs[i].arrival;
          }
        }
        if (nextArrival > t) {
          const target = Math.min(nextArrival, SIM_LIMITS.MAX_SIM_TICKS);
          const gap = target - t;
          if (includeTimeline) {
            ticks.push({
              tick: t,
              completed: completedCount,
              cores: cores.map(() => 'IDLE'),
              readyQueue: [],
            });
          }
          for (let c = 0; c < numCores; c++) {
            cores[c].idleTime += gap;
            if (includeTimeline) recordGanttRange(c, t, target);
          }
          t = target - 1;
          continue;
        }
      }
    }

    // 4. Dispatch to free cores
    for (let c = 0; c < numCores; c++) {
      if (cores[c].assignedProc < 0 && readyQueue.length > 0) {
        const pos = selectBestPos();
        const p = readyQueue.splice(pos, 1)[0];
        cores[c].assignedProc = p;
        cores[c].quantumUsed = 0;
        procs[p].state = 'RUNNING';
      }
    }

    // 5. Preemption for SRTF / Preemptive Priority
    const isSrtf = algorithm === 'SRTF';
    const isPrioPreempt = algorithm === 'Priority' && priorityPreemptive;
    if (isSrtf || isPrioPreempt) {
      while (readyQueue.length > 0) {
        const bestPos = selectBestPos();
        const bestIdx = readyQueue[bestPos];
        const cand = procs[bestIdx];
        let victimCore = -1;
        for (let c = 0; c < numCores; c++) {
          const rp = cores[c].assignedProc;
          if (rp < 0) continue;
          if (victimCore < 0) {
            victimCore = c;
          } else {
            const cur = procs[rp];
            const vic = procs[cores[victimCore].assignedProc];
            if (isSrtf ? cur.remaining > vic.remaining : cur.priority > vic.priority) {
              victimCore = c;
            }
          }
        }
        if (victimCore < 0) break;
        const victimProc = cores[victimCore].assignedProc;
        const shouldPreempt = isSrtf
          ? cand.remaining < procs[victimProc].remaining
          : cand.priority < procs[victimProc].priority;
        if (!shouldPreempt) break;

        readyQueue.splice(bestPos, 1);
        procs[victimProc].state = 'READY';
        readyQueue.push(victimProc);
        cores[victimCore].assignedProc = bestIdx;
        cores[victimCore].quantumUsed = 0;
        procs[bestIdx].state = 'RUNNING';
      }
    }

    // 6. Context switches, firstStart, Gantt & Snapshot
    for (let c = 0; c < numCores; c++) {
      const p = cores[c].assignedProc;
      if (p >= 0) {
        if (cores[c].lastProc >= 0 && cores[c].lastProc !== p) {
          contextSwitches++;
        }
        cores[c].lastProc = p;
        if (procs[p].firstStart < 0) procs[p].firstStart = t;
      }
      if (includeTimeline) recordGantt(c, p, t);
    }

    if (includeTimeline) {
      ticks.push({
        tick: t,
        completed: completedCount,
        cores: cores.map((c) => (c.assignedProc >= 0 ? procs[c.assignedProc].pid : 'IDLE')),
        readyQueue: readyQueue.map((i) => procs[i].pid),
      });
    }

    // 7. Execute 1 tick on each core
    for (let c = 0; c < numCores; c++) {
      const p = cores[c].assignedProc;
      if (p >= 0) {
        procs[p].remaining--;
        cores[c].busyTime++;
        cores[c].quantumUsed++;
      } else {
        cores[c].idleTime++;
      }
    }

    // 8. Completions & RR Quantum expiration
    for (let c = 0; c < numCores; c++) {
      const p = cores[c].assignedProc;
      if (p < 0) continue;
      if (procs[p].remaining <= 0) {
        procs[p].state = 'COMPLETED';
        procs[p].completion = t + 1;
        completedCount++;
        cores[c].assignedProc = -1;
        cores[c].quantumUsed = 0;
      } else if (algorithm === 'Round Robin' && cores[c].quantumUsed >= quantum) {
        rrRequeue.push(p);
        cores[c].assignedProc = -1;
        cores[c].quantumUsed = 0;
      }
    }
  }

  const processResults: ProcessResult[] = procs.map((p) => {
    const effectiveCompletion = p.state === 'COMPLETED' ? p.completion : Math.max(makespan, p.arrival);
    const turnaround = Math.max(0, effectiveCompletion - p.arrival);
    const executed = p.burst - Math.max(0, p.remaining);
    const waiting = Math.max(0, turnaround - executed);
    const response = p.firstStart >= 0 ? Math.max(0, p.firstStart - p.arrival) : 0;
    return {
      pid: p.pid,
      arrival: p.arrival,
      burst: p.burst,
      priority: p.priority,
      firstStart: p.firstStart,
      completion: p.state === 'COMPLETED' ? p.completion : makespan,
      turnaround,
      waiting,
      response,
    };
  });

  const n = processResults.length;
  const avgTurnaround = n > 0 ? processResults.reduce((s, p) => s + p.turnaround, 0) / n : 0;
  const avgWaiting = n > 0 ? processResults.reduce((s, p) => s + p.waiting, 0) / n : 0;
  const avgResponse = n > 0 ? processResults.reduce((s, p) => s + p.response, 0) / n : 0;
  const totalBusyTime = cores.reduce((s, c) => s + c.busyTime, 0);
  const totalIdleTime = cores.reduce((s, c) => s + c.idleTime, 0);
  const throughput = makespan > 0 ? n / makespan : 0;
  const cpuUtilization = makespan > 0 ? (totalBusyTime / (numCores * makespan)) * 100 : 0;

  return {
    algorithm,
    cores: numCores,
    quantum,
    priorityMode,
    processes: processResults,
    gantt: segments,
    ticks,
    truncated,
    metrics: {
      avgTurnaround: Number(avgTurnaround.toFixed(2)),
      avgWaiting: Number(avgWaiting.toFixed(2)),
      avgResponse: Number(avgResponse.toFixed(2)),
      throughput: Number(throughput.toFixed(4)),
      cpuUtilization: Number(cpuUtilization.toFixed(2)),
      makespan,
      totalBusyTime,
      totalIdleTime,
      contextSwitches,
      coreUtilization: cores.map((c, idx) => ({
        core: idx,
        busyTime: c.busyTime,
        idleTime: c.idleTime,
        utilization: makespan > 0 ? Number(((c.busyTime / makespan) * 100).toFixed(2)) : 0,
      })),
    },
  };
}

export function compareAllAlgorithms(
  inputs: ProcessInput[],
  cores: number,
  quantum: number,
  priorityMode: PriorityMode,
  includeTimeline = true
): CompareResponse {
  const algs: AlgorithmType[] = ['FCFS', 'SJF', 'SRTF', 'Priority', 'Round Robin'];
  const results = algs.map((alg) => runMultiCoreSimulation(inputs, alg, cores, quantum, priorityMode, includeTimeline));

  let bestWt = 0,
    bestTat = 0,
    bestRt = 0,
    bestCpu = 0,
    bestCs = 0;
  for (let i = 1; i < results.length; i++) {
    if (results[i].metrics.avgWaiting < results[bestWt].metrics.avgWaiting) bestWt = i;
    if (results[i].metrics.avgTurnaround < results[bestTat].metrics.avgTurnaround) bestTat = i;
    if (results[i].metrics.avgResponse < results[bestRt].metrics.avgResponse) bestRt = i;
    if (results[i].metrics.cpuUtilization > results[bestCpu].metrics.cpuUtilization) bestCpu = i;
    if (results[i].metrics.contextSwitches < results[bestCs].metrics.contextSwitches) bestCs = i;
  }

  return {
    results,
    best: {
      avgWaiting: results[bestWt].algorithm,
      avgTurnaround: results[bestTat].algorithm,
      avgResponse: results[bestRt].algorithm,
      cpuUtilization: results[bestCpu].algorithm,
      contextSwitches: results[bestCs].algorithm,
    },
  };
}

/**
 * RFC 4180 CSV cell escaping with spreadsheet formula-injection protection.
 */
function escapeCsvCell(value: string | number): string {
  let str = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsvReport(lastSim: SimResult | null, lastCmp: CompareResponse | null): string {
  const lines: string[] = ['Multi-Core CPU Scheduling Simulator - Performance Report', ''];
  if (lastSim && lastSim.processes.length > 0) {
    lines.push(
      [
        'LAST SIMULATION',
        lastSim.algorithm,
        'Cores',
        lastSim.cores,
        'Quantum',
        lastSim.quantum,
        'PriorityMode',
        lastSim.priorityMode,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
    lines.push('PID,Arrival,Burst,Priority,FirstStart,Completion,Turnaround,Waiting,Response');
    for (const p of lastSim.processes) {
      lines.push(
        [
          p.pid,
          p.arrival,
          p.burst,
          p.priority,
          p.firstStart,
          p.completion,
          p.turnaround,
          p.waiting,
          p.response,
        ]
          .map(escapeCsvCell)
          .join(',')
      );
    }
    const m = lastSim.metrics;
    lines.push(
      [
        'Summary',
        'AvgTurnaround',
        m.avgTurnaround.toFixed(2),
        'AvgWaiting',
        m.avgWaiting.toFixed(2),
        'AvgResponse',
        m.avgResponse.toFixed(2),
        'Throughput',
        m.throughput.toFixed(4),
        'CPUUtilization%',
        m.cpuUtilization.toFixed(2),
        'Makespan',
        m.makespan,
        'IdleTime',
        m.totalIdleTime,
        'ContextSwitches',
        m.contextSwitches,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
    lines.push('');
  }
  if (lastCmp && lastCmp.results.length > 0) {
    lines.push('ALGORITHM COMPARISON');
    lines.push('Algorithm,AvgTurnaround,AvgWaiting,AvgResponse,Throughput,CPUUtilization%,Makespan,IdleTime,ContextSwitches');
    for (const r of lastCmp.results) {
      const m = r.metrics;
      lines.push(
        [
          r.algorithm,
          m.avgTurnaround.toFixed(2),
          m.avgWaiting.toFixed(2),
          m.avgResponse.toFixed(2),
          m.throughput.toFixed(4),
          m.cpuUtilization.toFixed(2),
          m.makespan,
          m.totalIdleTime,
          m.contextSwitches,
        ]
          .map(escapeCsvCell)
          .join(',')
      );
    }
  }
  return lines.join('\r\n');
}
