#ifndef MONITOR_H
#define MONITOR_H

#define MAX_OS_PROCESSES 512
#define MAX_AFFINITY_CORES 64

typedef struct {
    char cpu_model[256];
    int physical_cores;
    int logical_processors;
    int affinity_core_count;
    int affinity_cores[MAX_AFFINITY_CORES];
} HardwareInfo;

typedef struct {
    double cpu_percent;
    double ram_used_mb;
    double ram_total_mb;
    double ram_percent;
    unsigned long long timestamp_ms;
} LiveMetrics;

typedef struct {
    unsigned long pid;
    char name[260];
    double memory_mb;
} OSProcessInfo;

typedef struct {
    int count;
    OSProcessInfo list[MAX_OS_PROCESSES];
} OSProcessList;

#define MAX_TRACKED_LAUNCHES 32

/* Per-logical-core busy % over the interval since the previous sample. */
typedef struct {
    int valid;
    int count;
    double usage[MAX_AFFINITY_CORES];
} CoreUsage;

typedef struct {
    int success;
    unsigned long pid;
    int pinned_core;            /* core actually pinned, or -1 */
    int requested_core;         /* core the user asked for, or -1 (OS default) */
    char app_name[64];
    char message[256];
    /* Measured launch results */
    double open_ms;             /* CreateProcess -> ready (or timeout / exit) */
    char ready_state[24];       /* ready | timeout | no-input-idle | exited */
    unsigned long long launched_at_ms; /* Unix epoch milliseconds */
    int affinity_count;         /* cores Windows reports the new process may use */
    int affinity_cores[MAX_AFFINITY_CORES];
    CoreUsage cores_before;     /* per-core load just before the launch */
    CoreUsage cores_during;     /* per-core load while the app was opening */
} LaunchResult;

typedef struct {
    int found;
    unsigned long pid;
    char app_name[64];
    int running;
    unsigned long exit_code;
    int requested_core;
    double open_ms;
    char ready_state[24];
    double uptime_ms;
    double cpu_percent;         /* share of total machine CPU since last stats read */
    double cpu_time_ms;         /* kernel + user time */
    double memory_mb;           /* working set */
    double peak_memory_mb;
    unsigned long threads;
    int affinity_count;
    int affinity_cores[MAX_AFFINITY_CORES];
    CoreUsage cores;            /* per-core load since last sample */
} LaunchStats;

/* Initialize & clean up monitor synchronization state */
void monitor_init(void);
void monitor_cleanup(void);

/* Module 2 Windows API observers */
void monitor_get_hardware(HardwareInfo *info);
void monitor_get_live_metrics(LiveMetrics *metrics);
void monitor_get_processes(OSProcessList *plist);

/* Whitelisted application launcher with optional CPU core affinity pinning */
int monitor_launch_app(const char *app_key, int pin_core, LaunchResult *res);

/* Per-core load (NtQuerySystemInformation) and stats for apps this agent launched */
void monitor_get_core_usage(CoreUsage *out);
int monitor_get_launch_stats(unsigned long pid, LaunchStats *st);

#endif /* MONITOR_H */
