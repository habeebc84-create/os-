#ifndef MONITOR_H
#define MONITOR_H

#define MAX_OS_PROCESSES 512

typedef struct {
    char cpu_model[256];
    int physical_cores;
    int logical_processors;
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

typedef struct {
    int success;
    unsigned long pid;
    int pinned_core;
    char app_name[64];
    char message[256];
} LaunchResult;

/* Initialize & clean up monitor synchronization state */
void monitor_init(void);
void monitor_cleanup(void);

/* Module 2 Windows API observers */
void monitor_get_hardware(HardwareInfo *info);
void monitor_get_live_metrics(LiveMetrics *metrics);
void monitor_get_processes(OSProcessList *plist);

/* Whitelisted application launcher with optional CPU core affinity pinning */
int monitor_launch_app(const char *app_key, int pin_core, LaunchResult *res);

#endif /* MONITOR_H */
