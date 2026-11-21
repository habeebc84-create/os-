#ifndef SCHEDULER_H
#define SCHEDULER_H

#define MAX_PROCS      64
#define MAX_CORES      8
#define MAX_SEGMENTS   1024
#define MAX_SNAPSHOTS  512
#define PID_MAX_LEN    16

/* Supported CPU Scheduling Algorithms */
typedef enum {
    ALG_FCFS = 0,     /* First-Come, First-Served (Non-preemptive) */
    ALG_SJF,          /* Shortest Job First (Non-preemptive) */
    ALG_SRTF,         /* Shortest Remaining Time First (Preemptive) */
    ALG_PRIORITY,     /* Priority Scheduling (Preemptive or Non-preemptive) */
    ALG_RR            /* Round Robin (Preemptive, fixed time quantum) */
} SchedulingAlgorithm;

/* Process lifecycle states in the OS ready/running model */
typedef enum {
    PROC_NEW = 0,
    PROC_READY,
    PROC_RUNNING,
    PROC_COMPLETED
} ProcessState;

/* Input process specification */
typedef struct {
    char pid[PID_MAX_LEN];
    int arrival;
    int burst;
    int priority; /* Lower numeric value = higher scheduling priority */
} ProcessInput;

/* Runtime & result metrics for a single process */
typedef struct {
    char pid[PID_MAX_LEN];
    int arrival;
    int burst;
    int priority;
    int remaining;
    int first_start;   /* Tick when process first acquired a CPU core (-1 if never) */
    int completion;    /* Tick when process finished execution */
    int turnaround;    /* Completion - Arrival */
    int waiting;       /* Turnaround - Burst */
    int response;      /* First Start - Arrival */
    ProcessState state;
} ProcessResult;

/* Simulation configuration parameters */
typedef struct {
    SchedulingAlgorithm algorithm;
    int num_cores;           /* 1..8 */
    int quantum;             /* >= 1 (used for Round Robin) */
    int priority_preemptive; /* 1 = preemptive priority, 0 = non-preemptive */
} SimConfig;

/* A contiguous execution or idle block on one CPU core for the Gantt chart */
typedef struct {
    int core;
    char pid[PID_MAX_LEN]; /* "IDLE" when core is idle */
    int is_idle;
    int start;
    int end;
} GanttSegment;

/* Per-tick snapshot for live tick-by-tick replay in the dashboard */
typedef struct {
    int tick;
    char core_pid[MAX_CORES][PID_MAX_LEN];
    int ready_count;
    char ready_pids[8][PID_MAX_LEN];
    int completed_count;
} TickSnapshot;

/* Complete output of a multi-core simulation run */
typedef struct {
    SimConfig config;
    int num_procs;
    ProcessResult procs[MAX_PROCS];

    int num_segments;
    GanttSegment segments[MAX_SEGMENTS];

    int num_snapshots;
    TickSnapshot snapshots[MAX_SNAPSHOTS];

    /* Aggregate performance metrics (Module 3 exact formulas) */
    double avg_turnaround;
    double avg_waiting;
    double avg_response;
    double throughput;
    double cpu_utilization;
    double core_utilization[MAX_CORES];
    int core_busy_time[MAX_CORES];
    int core_idle_time[MAX_CORES];
    int total_busy_time;
    int total_idle_time;
    int makespan;
    int context_switches;
} SimResult;

/* Aggregate comparison bundle across all 5 scheduling algorithms */
typedef struct {
    int count;
    SimResult results[5];
} CompareResult;

/* Utility helpers */
const char *algorithm_to_string(SchedulingAlgorithm alg);
SchedulingAlgorithm string_to_algorithm(const char *name);

/* Core multi-threaded simulation entry points */
int run_simulation(const ProcessInput *inputs, int num_procs, const SimConfig *cfg, SimResult *out);
int run_compare_all(const ProcessInput *inputs, int num_procs, int num_cores, int quantum, int priority_preemptive, CompareResult *out);

/* Built-in terminal test harness (--test) */
void run_builtin_cli_test(void);

#endif /* SCHEDULER_H */
