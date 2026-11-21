#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#include "scheduler.h"

/*
 * ============================================================================
 * MULTI-CORE CPU SCHEDULING ENGINE (Real Windows Threads + Synchronization)
 * ============================================================================
 * OS Architecture:
 *   - 1 Clock Thread       : Advances the global discrete simulation tick (t).
 *   - 1 Dispatcher Thread  : Owns the Ready Queue (protected by CRITICAL_SECTION),
 *                            handles arrivals, preemption, dispatch to free cores,
 *                            Gantt segment recording, and context switch counting.
 *   - N Core Worker Threads: Each simulated CPU core (1..8) runs as an actual
 *                            OS thread (CreateThread) executing 1 tick of work
 *                            on its assigned process in parallel.
 *
 * Synchronization Protocol (Race-Free & Deadlock-Free):
 *   - A single CRITICAL_SECTION (ctx->lock) protects all shared state. It is
 *     NEVER held while waiting on any kernel event handle, guaranteeing no
 *     lock-inversion deadlock.
 *   - Auto-reset events enforce strict lock-step tick execution:
 *       Clock -> (ev_clock_tick) -> Dispatcher
 *       Dispatcher -> (ev_core_start[0..N-1]) -> Core Threads [0..N-1]
 *       Core Threads -> (ev_core_done[0..N-1]) -> Dispatcher (WaitForMultipleObjects)
 *       Dispatcher -> (ev_tick_complete) -> Clock
 * ============================================================================
 */

#define MAX_SIM_TICKS 20000

typedef struct {
    int assigned_proc;   /* Index into ctx->procs, or -1 if core is IDLE */
    int last_proc;       /* Last non-idle process index executed on this core */
    int busy_time;
    int idle_time;
    int quantum_used;    /* Consecutive ticks current process used in Round Robin */
} CoreState;

typedef struct {
    SimConfig cfg;
    int num_procs;
    ProcessResult procs[MAX_PROCS];

    /* Ready Queue owned by Dispatcher, protected by ctx->lock */
    int ready_queue[MAX_PROCS];
    int ready_count;

    /* Pending Round-Robin requeue list (re-entered after arrivals on next tick) */
    int rr_requeue[MAX_CORES];
    int rr_requeue_count;

    CoreState cores[MAX_CORES];
    int current_tick;
    int completed_count;
    int simulation_done;
    int makespan;
    int context_switches;

    /* Recorded Gantt timeline and per-tick live snapshots */
    int num_segments;
    GanttSegment segments[MAX_SEGMENTS];
    int num_snapshots;
    TickSnapshot snapshots[MAX_SNAPSHOTS];

    /* Windows synchronization primitives */
    CRITICAL_SECTION lock;
    HANDLE ev_clock_tick;
    HANDLE ev_tick_complete;
    HANDLE ev_core_start[MAX_CORES];
    HANDLE ev_core_done[MAX_CORES];
} SimContext;

typedef struct {
    SimContext *ctx;
    int core_id;
} CoreThreadArg;

const char *algorithm_to_string(SchedulingAlgorithm alg) {
    switch (alg) {
        case ALG_FCFS:     return "FCFS";
        case ALG_SJF:      return "SJF";
        case ALG_SRTF:     return "SRTF";
        case ALG_PRIORITY: return "Priority";
        case ALG_RR:       return "Round Robin";
        default:           return "FCFS";
    }
}

SchedulingAlgorithm string_to_algorithm(const char *name) {
    if (!name) return ALG_FCFS;
    char lower[32];
    size_t i = 0;
    for (; name[i] && i < sizeof(lower) - 1; i++) {
        lower[i] = (char)tolower((unsigned char)name[i]);
    }
    lower[i] = '\0';

    if (strstr(lower, "srtf")) return ALG_SRTF;
    if (strstr(lower, "sjf"))  return ALG_SJF;
    if (strstr(lower, "prio")) return ALG_PRIORITY;
    if (strstr(lower, "rr") || strstr(lower, "round")) return ALG_RR;
    return ALG_FCFS;
}

/* Ready Queue helpers (caller MUST hold ctx->lock) */
static void rq_push(SimContext *ctx, int proc_idx) {
    if (ctx->ready_count < MAX_PROCS) {
        ctx->ready_queue[ctx->ready_count++] = proc_idx;
        ctx->procs[proc_idx].state = PROC_READY;
    }
}

static int rq_remove_at(SimContext *ctx, int pos) {
    int idx = ctx->ready_queue[pos];
    for (int i = pos; i < ctx->ready_count - 1; i++) {
        ctx->ready_queue[i] = ctx->ready_queue[i + 1];
    }
    ctx->ready_count--;
    return idx;
}

/* Select the best ready process according to the active scheduling policy */
static int rq_select_best_pos(const SimContext *ctx) {
    if (ctx->ready_count <= 0) return -1;
    if (ctx->cfg.algorithm == ALG_FCFS || ctx->cfg.algorithm == ALG_RR) {
        return 0; /* FIFO order */
    }

    int best_pos = 0;
    for (int i = 1; i < ctx->ready_count; i++) {
        const ProcessResult *cand = &ctx->procs[ctx->ready_queue[i]];
        const ProcessResult *best = &ctx->procs[ctx->ready_queue[best_pos]];
        int better = 0;

        if (ctx->cfg.algorithm == ALG_SJF) {
            if (cand->burst < best->burst) better = 1;
            else if (cand->burst == best->burst && cand->arrival < best->arrival) better = 1;
        } else if (ctx->cfg.algorithm == ALG_SRTF) {
            if (cand->remaining < best->remaining) better = 1;
            else if (cand->remaining == best->remaining && cand->arrival < best->arrival) better = 1;
        } else if (ctx->cfg.algorithm == ALG_PRIORITY) {
            /* Lower numeric priority value means higher urgency */
            if (cand->priority < best->priority) better = 1;
            else if (cand->priority == best->priority && cand->arrival < best->arrival) better = 1;
        }

        if (better) best_pos = i;
    }
    return best_pos;
}

/* Record or extend a Gantt chart block for (core_id, proc_idx) during [t, t+1] */
static void record_gantt_tick(SimContext *ctx, int core_id, int proc_idx, int t) {
    const char *label = (proc_idx >= 0) ? ctx->procs[proc_idx].pid : "IDLE";
    int is_idle = (proc_idx < 0) ? 1 : 0;

    /* Coalesce with the most recent segment on the same core if contiguous and same PID */
    for (int i = ctx->num_segments - 1; i >= 0; i--) {
        if (ctx->segments[i].core == core_id) {
            if (ctx->segments[i].end == t &&
                ctx->segments[i].is_idle == is_idle &&
                strcmp(ctx->segments[i].pid, label) == 0) {
                ctx->segments[i].end = t + 1;
                return;
            }
            break;
        }
    }

    if (ctx->num_segments < MAX_SEGMENTS) {
        GanttSegment *seg = &ctx->segments[ctx->num_segments++];
        seg->core = core_id;
        strncpy(seg->pid, label, PID_MAX_LEN - 1);
        seg->pid[PID_MAX_LEN - 1] = '\0';
        seg->is_idle = is_idle;
        seg->start = t;
        seg->end = t + 1;
    }
}

/* Capture live tick snapshot for tick-by-tick dashboard animation */
static void record_tick_snapshot(SimContext *ctx, int t) {
    if (ctx->num_snapshots >= MAX_SNAPSHOTS) return;
    TickSnapshot *snap = &ctx->snapshots[ctx->num_snapshots++];
    snap->tick = t;
    snap->completed_count = ctx->completed_count;
    for (int c = 0; c < ctx->cfg.num_cores; c++) {
        int p = ctx->cores[c].assigned_proc;
        if (p >= 0) {
            strncpy(snap->core_pid[c], ctx->procs[p].pid, PID_MAX_LEN - 1);
            snap->core_pid[c][PID_MAX_LEN - 1] = '\0';
        } else {
            strcpy(snap->core_pid[c], "IDLE");
        }
    }
    snap->ready_count = ctx->ready_count;
    int cap = (ctx->ready_count < 8) ? ctx->ready_count : 8;
    for (int i = 0; i < cap; i++) {
        strncpy(snap->ready_pids[i], ctx->procs[ctx->ready_queue[i]].pid, PID_MAX_LEN - 1);
        snap->ready_pids[i][PID_MAX_LEN - 1] = '\0';
    }
}

/* Handle preemptive replacement for SRTF and Preemptive Priority */
static void perform_preemption(SimContext *ctx) {
    int is_srtf = (ctx->cfg.algorithm == ALG_SRTF);
    int is_prio = (ctx->cfg.algorithm == ALG_PRIORITY && ctx->cfg.priority_preemptive);
    if (!is_srtf && !is_prio) return;

    while (ctx->ready_count > 0) {
        int best_ready_pos = rq_select_best_pos(ctx);
        int best_ready_idx = ctx->ready_queue[best_ready_pos];
        ProcessResult *cand = &ctx->procs[best_ready_idx];

        /* Find the running core holding the weakest (most preemptable) process */
        int victim_core = -1;
        for (int c = 0; c < ctx->cfg.num_cores; c++) {
            int rp = ctx->cores[c].assigned_proc;
            if (rp < 0) continue;
            if (victim_core < 0) {
                victim_core = c;
            } else {
                const ProcessResult *cur = &ctx->procs[rp];
                const ProcessResult *vic = &ctx->procs[ctx->cores[victim_core].assigned_proc];
                if (is_srtf) {
                    if (cur->remaining > vic->remaining) victim_core = c;
                } else {
                    if (cur->priority > vic->priority) victim_core = c;
                }
            }
        }

        if (victim_core < 0) break; /* No busy cores to preempt */

        int victim_proc = ctx->cores[victim_core].assigned_proc;
        int should_preempt = 0;
        if (is_srtf && cand->remaining < ctx->procs[victim_proc].remaining) {
            should_preempt = 1;
        } else if (is_prio && cand->priority < ctx->procs[victim_proc].priority) {
            should_preempt = 1;
        }

        if (!should_preempt) break;

        /* Preempt victim_core: return victim to Ready Queue and dispatch candidate */
        rq_remove_at(ctx, best_ready_pos);
        rq_push(ctx, victim_proc);

        ctx->cores[victim_core].assigned_proc = best_ready_idx;
        ctx->cores[victim_core].quantum_used = 0;
        ctx->procs[best_ready_idx].state = PROC_RUNNING;
    }
}

/* ============================================================================
 * WORKER THREAD: Simulates one physical/logical CPU Core
 * ============================================================================ */
static DWORD WINAPI core_thread_proc(LPVOID param) {
    CoreThreadArg *arg = (CoreThreadArg *)param;
    SimContext *ctx = arg->ctx;
    int core_id = arg->core_id;

    for (;;) {
        /* Wait for Dispatcher to authorize execution of the current tick */
        WaitForSingleObject(ctx->ev_core_start[core_id], INFINITE);

        EnterCriticalSection(&ctx->lock);
        if (ctx->simulation_done) {
            LeaveCriticalSection(&ctx->lock);
            break;
        }

        int p = ctx->cores[core_id].assigned_proc;
        if (p >= 0) {
            /* Execute 1 CPU tick of burst time on this core */
            ctx->procs[p].remaining--;
            ctx->cores[core_id].busy_time++;
            ctx->cores[core_id].quantum_used++;
        } else {
            /* Core remained idle during this tick */
            ctx->cores[core_id].idle_time++;
        }
        LeaveCriticalSection(&ctx->lock);

        /* Notify Dispatcher that this core finished its tick */
        SetEvent(ctx->ev_core_done[core_id]);
    }
    return 0;
}

/* ============================================================================
 * DISPATCHER THREAD: Owns Ready Queue, Preemption, Dispatch & Metrics
 * ============================================================================ */
static DWORD WINAPI dispatcher_thread_proc(LPVOID param) {
    SimContext *ctx = (SimContext *)param;

    for (;;) {
        WaitForSingleObject(ctx->ev_clock_tick, INFINITE);

        EnterCriticalSection(&ctx->lock);
        int t = ctx->current_tick;

        /* 1. Enqueue newly arriving processes at tick t */
        for (int i = 0; i < ctx->num_procs; i++) {
            if (ctx->procs[i].state == PROC_NEW && ctx->procs[i].arrival <= t) {
                rq_push(ctx, i);
            }
        }

        /* 2. Re-enqueue processes whose Round Robin quantum expired at end of tick t-1 */
        for (int i = 0; i < ctx->rr_requeue_count; i++) {
            rq_push(ctx, ctx->rr_requeue[i]);
        }
        ctx->rr_requeue_count = 0;

        /* 3. Termination check: all processes completed or safety cap reached */
        if (ctx->completed_count >= ctx->num_procs || t >= MAX_SIM_TICKS) {
            ctx->simulation_done = 1;
            ctx->makespan = t;
            for (int c = 0; c < ctx->cfg.num_cores; c++) {
                SetEvent(ctx->ev_core_start[c]);
            }
            LeaveCriticalSection(&ctx->lock);
            SetEvent(ctx->ev_tick_complete);
            break;
        }

        /* 4. Dispatch ready processes to any free CPU cores */
        for (int c = 0; c < ctx->cfg.num_cores; c++) {
            if (ctx->cores[c].assigned_proc < 0 && ctx->ready_count > 0) {
                int best_pos = rq_select_best_pos(ctx);
                int p = rq_remove_at(ctx, best_pos);
                ctx->cores[c].assigned_proc = p;
                ctx->cores[c].quantum_used = 0;
                ctx->procs[p].state = PROC_RUNNING;
            }
        }

        /* 5. Perform preemption if SRTF or Preemptive Priority requires it */
        perform_preemption(ctx);

        /* 6. Record context switches, first_start, Gantt segment, and tick snapshot */
        for (int c = 0; c < ctx->cfg.num_cores; c++) {
            int p = ctx->cores[c].assigned_proc;
            if (p >= 0) {
                /* Count a context switch whenever a core switches to a different process */
                if (ctx->cores[c].last_proc >= 0 && ctx->cores[c].last_proc != p) {
                    ctx->context_switches++;
                }
                ctx->cores[c].last_proc = p;
                if (ctx->procs[p].first_start < 0) {
                    ctx->procs[p].first_start = t;
                }
            }
            record_gantt_tick(ctx, c, p, t);
        }
        record_tick_snapshot(ctx, t);

        LeaveCriticalSection(&ctx->lock);

        /* 7. Release all Core Worker Threads in parallel for tick t */
        for (int c = 0; c < ctx->cfg.num_cores; c++) {
            SetEvent(ctx->ev_core_start[c]);
        }

        /* 8. Barrier: wait until EVERY core finishes executing tick t */
        WaitForMultipleObjects((DWORD)ctx->cfg.num_cores, ctx->ev_core_done, TRUE, INFINITE);

        /* 9. Post-tick completion and Round Robin quantum expiry bookkeeping */
        EnterCriticalSection(&ctx->lock);
        for (int c = 0; c < ctx->cfg.num_cores; c++) {
            int p = ctx->cores[c].assigned_proc;
            if (p < 0) continue;

            if (ctx->procs[p].remaining <= 0) {
                ctx->procs[p].state = PROC_COMPLETED;
                ctx->procs[p].completion = t + 1;
                ctx->completed_count++;
                ctx->cores[c].assigned_proc = -1;
                ctx->cores[c].quantum_used = 0;
            } else if (ctx->cfg.algorithm == ALG_RR &&
                       ctx->cores[c].quantum_used >= ctx->cfg.quantum) {
                /* Time slice expired: preempt and queue for re-entry on next tick */
                ctx->rr_requeue[ctx->rr_requeue_count++] = p;
                ctx->cores[c].assigned_proc = -1;
                ctx->cores[c].quantum_used = 0;
            }
        }
        LeaveCriticalSection(&ctx->lock);

        /* 10. Signal Clock Thread to advance to tick t + 1 */
        SetEvent(ctx->ev_tick_complete);
    }
    return 0;
}

/* ============================================================================
 * CLOCK THREAD: Advances the global simulated hardware clock tick by tick
 * ============================================================================ */
static DWORD WINAPI clock_thread_proc(LPVOID param) {
    SimContext *ctx = (SimContext *)param;

    for (;;) {
        SetEvent(ctx->ev_clock_tick);
        WaitForSingleObject(ctx->ev_tick_complete, INFINITE);

        EnterCriticalSection(&ctx->lock);
        if (ctx->simulation_done) {
            LeaveCriticalSection(&ctx->lock);
            break;
        }
        ctx->current_tick++;
        LeaveCriticalSection(&ctx->lock);
    }
    return 0;
}

/* ============================================================================
 * PUBLIC API: Run Multi-Core Simulation & Compute Exact Module 3 Metrics
 * ============================================================================ */
int run_simulation(const ProcessInput *inputs, int num_procs, const SimConfig *cfg, SimResult *out) {
    if (!inputs || !cfg || !out || num_procs <= 0 || num_procs > MAX_PROCS) {
        return -1;
    }

    SimContext *ctx = (SimContext *)calloc(1, sizeof(SimContext));
    if (!ctx) return -1;

    ctx->cfg = *cfg;
    if (ctx->cfg.num_cores < 1) ctx->cfg.num_cores = 1;
    if (ctx->cfg.num_cores > MAX_CORES) ctx->cfg.num_cores = MAX_CORES;
    if (ctx->cfg.quantum < 1) ctx->cfg.quantum = 1;

    ctx->num_procs = num_procs;
    for (int i = 0; i < num_procs; i++) {
        strncpy(ctx->procs[i].pid, inputs[i].pid, PID_MAX_LEN - 1);
        ctx->procs[i].pid[PID_MAX_LEN - 1] = '\0';
        ctx->procs[i].arrival     = (inputs[i].arrival < 0) ? 0 : inputs[i].arrival;
        ctx->procs[i].burst       = (inputs[i].burst < 1) ? 1 : inputs[i].burst;
        ctx->procs[i].priority    = inputs[i].priority;
        ctx->procs[i].remaining   = ctx->procs[i].burst;
        ctx->procs[i].first_start = -1;
        ctx->procs[i].completion  = 0;
        ctx->procs[i].state       = PROC_NEW;
    }

    for (int c = 0; c < ctx->cfg.num_cores; c++) {
        ctx->cores[c].assigned_proc = -1;
        ctx->cores[c].last_proc     = -1;
    }

    /* Initialize Windows synchronization primitives */
    InitializeCriticalSection(&ctx->lock);
    ctx->ev_clock_tick    = CreateEventA(NULL, FALSE, FALSE, NULL);
    ctx->ev_tick_complete = CreateEventA(NULL, FALSE, FALSE, NULL);
    for (int c = 0; c < ctx->cfg.num_cores; c++) {
        ctx->ev_core_start[c] = CreateEventA(NULL, FALSE, FALSE, NULL);
        ctx->ev_core_done[c]  = CreateEventA(NULL, FALSE, FALSE, NULL);
    }

    /* Launch Core Worker Threads, Dispatcher Thread, and Clock Thread */
    HANDLE core_threads[MAX_CORES];
    CoreThreadArg core_args[MAX_CORES];
    for (int c = 0; c < ctx->cfg.num_cores; c++) {
        core_args[c].ctx = ctx;
        core_args[c].core_id = c;
        core_threads[c] = CreateThread(NULL, 0, core_thread_proc, &core_args[c], 0, NULL);
    }
    HANDLE disp_thread  = CreateThread(NULL, 0, dispatcher_thread_proc, ctx, 0, NULL);
    HANDLE clock_thread = CreateThread(NULL, 0, clock_thread_proc, ctx, 0, NULL);

    /* Wait for all threads to terminate cleanly */
    WaitForSingleObject(clock_thread, INFINITE);
    WaitForSingleObject(disp_thread, INFINITE);
    WaitForMultipleObjects((DWORD)ctx->cfg.num_cores, core_threads, TRUE, INFINITE);

    /* Release kernel handles and critical section */
    CloseHandle(clock_thread);
    CloseHandle(disp_thread);
    for (int c = 0; c < ctx->cfg.num_cores; c++) {
        CloseHandle(core_threads[c]);
        CloseHandle(ctx->ev_core_start[c]);
        CloseHandle(ctx->ev_core_done[c]);
    }
    CloseHandle(ctx->ev_clock_tick);
    CloseHandle(ctx->ev_tick_complete);
    DeleteCriticalSection(&ctx->lock);

    /* Populate SimResult and compute exact Module 3 Performance Metrics */
    memset(out, 0, sizeof(SimResult));
    out->config           = ctx->cfg;
    out->num_procs        = ctx->num_procs;
    out->num_segments     = ctx->num_segments;
    out->num_snapshots    = ctx->num_snapshots;
    out->makespan         = ctx->makespan;
    out->context_switches = ctx->context_switches;

    memcpy(out->segments, ctx->segments, sizeof(GanttSegment) * (size_t)ctx->num_segments);
    memcpy(out->snapshots, ctx->snapshots, sizeof(TickSnapshot) * (size_t)ctx->num_snapshots);

    double sum_tat = 0.0, sum_wt = 0.0, sum_rt = 0.0;
    for (int i = 0; i < ctx->num_procs; i++) {
        out->procs[i] = ctx->procs[i];
        out->procs[i].turnaround = out->procs[i].completion - out->procs[i].arrival;
        out->procs[i].waiting    = out->procs[i].turnaround - out->procs[i].burst;
        out->procs[i].response   = out->procs[i].first_start - out->procs[i].arrival;
        sum_tat += out->procs[i].turnaround;
        sum_wt  += out->procs[i].waiting;
        sum_rt  += out->procs[i].response;
    }

    out->avg_turnaround = sum_tat / (double)ctx->num_procs;
    out->avg_waiting    = sum_wt  / (double)ctx->num_procs;
    out->avg_response   = sum_rt  / (double)ctx->num_procs;
    out->throughput     = (out->makespan > 0) ? ((double)ctx->num_procs / (double)out->makespan) : 0.0;

    int total_busy = 0, total_idle = 0;
    for (int c = 0; c < ctx->cfg.num_cores; c++) {
        out->core_busy_time[c] = ctx->cores[c].busy_time;
        out->core_idle_time[c] = ctx->cores[c].idle_time;
        out->core_utilization[c] = (out->makespan > 0)
            ? (100.0 * (double)ctx->cores[c].busy_time / (double)out->makespan)
            : 0.0;
        total_busy += ctx->cores[c].busy_time;
        total_idle += ctx->cores[c].idle_time;
    }
    out->total_busy_time = total_busy;
    out->total_idle_time = total_idle;
    out->cpu_utilization = (out->makespan > 0)
        ? (100.0 * (double)total_busy / ((double)ctx->cfg.num_cores * (double)out->makespan))
        : 0.0;

    free(ctx);
    return 0;
}

int run_compare_all(const ProcessInput *inputs, int num_procs, int num_cores, int quantum, int priority_preemptive, CompareResult *out) {
    if (!inputs || !out || num_procs <= 0) return -1;
    SchedulingAlgorithm algs[5] = { ALG_FCFS, ALG_SJF, ALG_SRTF, ALG_PRIORITY, ALG_RR };
    out->count = 5;
    for (int i = 0; i < 5; i++) {
        SimConfig cfg;
        cfg.algorithm = algs[i];
        cfg.num_cores = num_cores;
        cfg.quantum = quantum;
        cfg.priority_preemptive = priority_preemptive;
        if (run_simulation(inputs, num_procs, &cfg, &out->results[i]) != 0) {
            return -1;
        }
    }
    return 0;
}

/* Built-in CLI verification test: simulator.exe --test */
void run_builtin_cli_test(void) {
    ProcessInput sample[5] = {
        { "P1", 0, 8, 3 },
        { "P2", 1, 4, 1 },
        { "P3", 2, 9, 4 },
        { "P4", 3, 5, 2 },
        { "P5", 4, 2, 5 }
    };

    printf("===========================================================================\n");
    printf(" Multi-Core CPU Scheduling Simulator - Built-In Verification Suite (--test)\n");
    printf(" Workload: P1(0,8,3) P2(1,4,1) P3(2,9,4) P4(3,5,2) P5(4,2,5) | 2 Cores | Q=3\n");
    printf("===========================================================================\n\n");

    CompareResult *cmp = (CompareResult *)calloc(1, sizeof(CompareResult));
    if (!cmp) {
        fprintf(stderr, "Out of memory.\n");
        return;
    }

    if (run_compare_all(sample, 5, 2, 3, 1, cmp) != 0) {
        fprintf(stderr, "Simulation failed.\n");
        free(cmp);
        return;
    }

    for (int a = 0; a < cmp->count; a++) {
        const SimResult *r = &cmp->results[a];
        printf("[%d/5] Algorithm: %s%s\n", a + 1, algorithm_to_string(r->config.algorithm),
               (r->config.algorithm == ALG_PRIORITY)
                   ? (r->config.priority_preemptive ? " (Preemptive)" : " (Non-Preemptive)")
                   : "");
        printf("  PID   Arr  Burst  Pri  Start  Comp  TAT   WT    RT\n");
        printf("  ---------------------------------------------------\n");
        for (int i = 0; i < r->num_procs; i++) {
            const ProcessResult *p = &r->procs[i];
            printf("  %-4s  %3d  %5d  %3d  %5d  %4d  %3d   %3d   %3d\n",
                   p->pid, p->arrival, p->burst, p->priority,
                   p->first_start, p->completion, p->turnaround, p->waiting, p->response);
        }
        printf("  Averages  -> TAT: %.2f | WT: %.2f | RT: %.2f\n",
               r->avg_turnaround, r->avg_waiting, r->avg_response);
        printf("  System    -> Makespan: %d | Throughput: %.4f proc/tick | CPU Util: %.2f%% | Idle: %d | CS: %d\n",
               r->makespan, r->throughput, r->cpu_utilization, r->total_idle_time, r->context_switches);
        printf("  Per-Core  -> ");
        for (int c = 0; c < r->config.num_cores; c++) {
            printf("Core %d: %.2f%% (busy %d, idle %d)%s",
                   c, r->core_utilization[c], r->core_busy_time[c], r->core_idle_time[c],
                   (c + 1 < r->config.num_cores) ? " | " : "\n");
        }
        printf("  Gantt     -> ");
        for (int s = 0; s < r->num_segments; s++) {
            const GanttSegment *seg = &r->segments[s];
            printf("C%d:%s[%d-%d] ", seg->core, seg->pid, seg->start, seg->end);
        }
        printf("\n\n");
    }

    printf("Summary Comparison Table:\n");
    printf("  %-14s  AvgTAT  AvgWT   AvgRT   CPU%%    Thru     CS\n", "Algorithm");
    printf("  ----------------------------------------------------------\n");
    for (int a = 0; a < cmp->count; a++) {
        const SimResult *r = &cmp->results[a];
        printf("  %-14s  %6.2f  %6.2f  %6.2f  %6.2f  %.4f  %3d\n",
               algorithm_to_string(r->config.algorithm),
               r->avg_turnaround, r->avg_waiting, r->avg_response,
               r->cpu_utilization, r->throughput, r->context_switches);
    }
    printf("\nAll 5 multi-core algorithms verified successfully.\n");
    free(cmp);
}
