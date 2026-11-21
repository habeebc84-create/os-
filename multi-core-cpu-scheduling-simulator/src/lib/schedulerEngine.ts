export type AlgorithmType = 'FCFS' | 'SJF' | 'SRTF' | 'Priority' | 'Round Robin';
export type PriorityMode = 'preemptive' | 'non-preemptive';

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
  priorityMode: PriorityMode
): SimResult {
  const numCores = Math.min(8, Math.max(1, Math.floor(numCoresRaw) || 1));
  const quantum = Math.max(1, Math.floor(quantumRaw) || 1);
  const priorityPreemptive = priorityMode === 'preemptive';

  const procs = inputs.map((p) => ({
    pid: p.pid,
    arrival: Math.max(0, Math.floor(p.arrival)),
    burst: Math.max(1, Math.floor(p.burst)),
    priority: Math.floor(p.priority),
    remaining: Math.max(1, Math.floor(p.burst)),
    firstStart: -1,
    completion: 0,
    state: 'NEW' as 'NEW' | 'READY' | 'RUNNING' | 'COMPLETED',
  }));

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

  const recordGantt = (coreId: number, procIdx: number, t: number) => {
    const label = procIdx >= 0 ? procs[procIdx].pid : 'IDLE';
    const isIdle = procIdx < 0;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].core === coreId) {
        if (segments[i].end === t && segments[i].idle === isIdle && segments[i].pid === label) {
          segments[i].end = t + 1;
          return;
        }
        break;
      }
    }
    segments.push({ core: coreId, pid: label, idle: isIdle, start: t, end: t + 1 });
  };

  // Safety bound. The previous hard stop at 10000 ticks silently truncated any
  // workload whose total burst exceeded it: unfinished processes kept
  // completion 0, which produced impossible metrics (negative waiting times,
  // avgWaiting -20000) instead of an error. Size the bound from the actual
  // workload so long-but-valid inputs always finish.
  const totalBurst = procs.reduce((s, p) => s + p.burst, 0);
  const maxArrival = procs.reduce((s, p) => Math.max(s, p.arrival), 0);
  const tickLimit = Math.max(10000, maxArrival + totalBurst + 10);

  for (let t = 0; t <= tickLimit; t++) {
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

    // 3. Done check
    if (completedCount >= procs.length) {
      makespan = t;
      break;
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
      recordGantt(c, p, t);
    }

    ticks.push({
      tick: t,
      completed: completedCount,
      cores: cores.map((c) => (c.assignedProc >= 0 ? procs[c.assignedProc].pid : 'IDLE')),
      readyQueue: readyQueue.map((i) => procs[i].pid),
    });

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
    const turnaround = p.completion - p.arrival;
    const waiting = turnaround - p.burst;
    const response = p.firstStart - p.arrival;
    return {
      pid: p.pid,
      arrival: p.arrival,
      burst: p.burst,
      priority: p.priority,
      firstStart: p.firstStart,
      completion: p.completion,
      turnaround,
      waiting,
      response,
    };
  });

  const n = Math.max(1, processResults.length);
  const avgTurnaround = processResults.reduce((s, p) => s + p.turnaround, 0) / n;
  const avgWaiting = processResults.reduce((s, p) => s + p.waiting, 0) / n;
  const avgResponse = processResults.reduce((s, p) => s + p.response, 0) / n;
  const totalBusyTime = cores.reduce((s, c) => s + c.busyTime, 0);
  const totalIdleTime = cores.reduce((s, c) => s + c.idleTime, 0);
  const throughput = makespan > 0 ? processResults.length / makespan : 0;
  const cpuUtilization = makespan > 0 ? (totalBusyTime / (numCores * makespan)) * 100 : 0;

  return {
    algorithm,
    cores: numCores,
    quantum,
    priorityMode,
    processes: processResults,
    gantt: segments,
    ticks,
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
  priorityMode: PriorityMode
): CompareResponse {
  const algs: AlgorithmType[] = ['FCFS', 'SJF', 'SRTF', 'Priority', 'Round Robin'];
  const results = algs.map((alg) => runMultiCoreSimulation(inputs, alg, cores, quantum, priorityMode));

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

export function buildCsvReport(lastSim: SimResult | null, lastCmp: CompareResponse | null): string {
  const lines: string[] = ['Multi-Core CPU Scheduling Simulator - Performance Report', ''];
  if (lastSim) {
    lines.push(
      `LAST SIMULATION,${lastSim.algorithm},Cores,${lastSim.cores},Quantum,${lastSim.quantum},PriorityMode,${lastSim.priorityMode}`
    );
    lines.push('PID,Arrival,Burst,Priority,FirstStart,Completion,Turnaround,Waiting,Response');
    for (const p of lastSim.processes) {
      lines.push(
        `${p.pid},${p.arrival},${p.burst},${p.priority},${p.firstStart},${p.completion},${p.turnaround},${p.waiting},${p.response}`
      );
    }
    const m = lastSim.metrics;
    lines.push(
      `Summary,AvgTurnaround,${m.avgTurnaround.toFixed(2)},AvgWaiting,${m.avgWaiting.toFixed(2)},AvgResponse,${m.avgResponse.toFixed(2)},Throughput,${m.throughput.toFixed(4)},CPUUtilization%,${m.cpuUtilization.toFixed(2)},Makespan,${m.makespan},IdleTime,${m.totalIdleTime},ContextSwitches,${m.contextSwitches}`
    );
    lines.push('');
  }
  if (lastCmp) {
    lines.push('ALGORITHM COMPARISON');
    lines.push('Algorithm,AvgTurnaround,AvgWaiting,AvgResponse,Throughput,CPUUtilization%,Makespan,IdleTime,ContextSwitches');
    for (const r of lastCmp.results) {
      const m = r.metrics;
      lines.push(
        `${r.algorithm},${m.avgTurnaround.toFixed(2)},${m.avgWaiting.toFixed(2)},${m.avgResponse.toFixed(2)},${m.throughput.toFixed(4)},${m.cpuUtilization.toFixed(2)},${m.makespan},${m.totalIdleTime},${m.contextSwitches}`
      );
    }
  }
  return lines.join('\r\n');
}
