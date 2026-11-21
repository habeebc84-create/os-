#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#include "monitor.h"

/*
 * ============================================================================
 * REAL-TIME WINDOWS HARDWARE & PROCESS MONITOR (Win32 API)
 * ============================================================================
 * Note: This module strictly OBSERVES real Windows hardware & process state.
 *       It never interferes with the Windows kernel scheduler (except optional
 *       SetProcessAffinityMask on apps explicitly launched from our whitelist).
 * ============================================================================
 */

static CRITICAL_SECTION g_cpu_lock;
static ULARGE_INTEGER g_prev_idle;
static ULARGE_INTEGER g_prev_kernel;
static ULARGE_INTEGER g_prev_user;
static int g_has_cpu_sample = 0;
static double g_last_cpu_percent = 0.0;

static ULARGE_INTEGER filetime_to_ularge(FILETIME ft) {
    ULARGE_INTEGER u;
    u.LowPart  = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    return u;
}

static int count_set_bits(ULONG_PTR mask) {
    int count = 0;
    while (mask) {
        count += (int)(mask & 1);
        mask >>= 1;
    }
    return count;
}

static void trim_whitespace(char *s) {
    char *start = s;
    while (*start && isspace((unsigned char)*start)) start++;
    if (start != s) memmove(s, start, strlen(start) + 1);
    size_t len = strlen(s);
    while (len > 0 && isspace((unsigned char)s[len - 1])) {
        s[--len] = '\0';
    }
}

void monitor_init(void) {
    InitializeCriticalSection(&g_cpu_lock);
    FILETIME idle, kernel, user;
    if (GetSystemTimes(&idle, &kernel, &user)) {
        g_prev_idle   = filetime_to_ularge(idle);
        g_prev_kernel = filetime_to_ularge(kernel);
        g_prev_user   = filetime_to_ularge(user);
        g_has_cpu_sample = 1;
    }
}

void monitor_cleanup(void) {
    DeleteCriticalSection(&g_cpu_lock);
}

/* Read CPU brand string from Registry and core topology via Win32 API */
void monitor_get_hardware(HardwareInfo *info) {
    memset(info, 0, sizeof(HardwareInfo));
    strcpy(info->cpu_model, "Unknown Windows Processor");

    /* 1. CPU Model Name from Registry */
    HKEY hKey = NULL;
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE,
                      "HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
                      0, KEY_READ, &hKey) == ERROR_SUCCESS) {
        DWORD type = 0;
        DWORD size = (DWORD)sizeof(info->cpu_model) - 1;
        if (RegQueryValueExA(hKey, "ProcessorNameString", NULL, &type,
                             (LPBYTE)info->cpu_model, &size) == ERROR_SUCCESS) {
            info->cpu_model[sizeof(info->cpu_model) - 1] = '\0';
            trim_whitespace(info->cpu_model);
        }
        RegCloseKey(hKey);
    }

    /* 2. Physical Cores & Logical Processors via GetLogicalProcessorInformation */
    DWORD len = 0;
    GetLogicalProcessorInformation(NULL, &len);
    if (GetLastError() == ERROR_INSUFFICIENT_BUFFER && len > 0) {
        SYSTEM_LOGICAL_PROCESSOR_INFORMATION *buf =
            (SYSTEM_LOGICAL_PROCESSOR_INFORMATION *)malloc(len);
        if (buf) {
            if (GetLogicalProcessorInformation(buf, &len)) {
                DWORD count = len / (DWORD)sizeof(SYSTEM_LOGICAL_PROCESSOR_INFORMATION);
                int phys = 0, logical = 0;
                for (DWORD i = 0; i < count; i++) {
                    if (buf[i].Relationship == RelationProcessorCore) {
                        phys++;
                        logical += count_set_bits(buf[i].ProcessorMask);
                    }
                }
                info->physical_cores = phys;
                info->logical_processors = logical;
            }
            free(buf);
        }
    }

    /* Fallback if topology query failed */
    if (info->logical_processors <= 0) {
        SYSTEM_INFO si;
        GetSystemInfo(&si);
        info->logical_processors = (int)si.dwNumberOfProcessors;
        info->physical_cores = info->logical_processors;
    }
}

/* Compute live total CPU % (GetSystemTimes delta) and RAM % (GlobalMemoryStatusEx) */
void monitor_get_live_metrics(LiveMetrics *metrics) {
    memset(metrics, 0, sizeof(LiveMetrics));
    metrics->timestamp_ms = (unsigned long long)GetTickCount64();

    /* 1. Live CPU % between two GetSystemTimes samples */
    EnterCriticalSection(&g_cpu_lock);
    FILETIME idle, kernel, user;
    if (GetSystemTimes(&idle, &kernel, &user)) {
        ULARGE_INTEGER cur_idle   = filetime_to_ularge(idle);
        ULARGE_INTEGER cur_kernel = filetime_to_ularge(kernel);
        ULARGE_INTEGER cur_user   = filetime_to_ularge(user);

        if (g_has_cpu_sample) {
            ULONGLONG d_idle   = cur_idle.QuadPart   - g_prev_idle.QuadPart;
            ULONGLONG d_kernel = cur_kernel.QuadPart - g_prev_kernel.QuadPart;
            ULONGLONG d_user   = cur_user.QuadPart   - g_prev_user.QuadPart;
            /* Note: Windows kernel time INCLUDES idle time */
            ULONGLONG total = d_kernel + d_user;
            if (total > 0 && total >= d_idle) {
                ULONGLONG busy = total - d_idle;
                double pct = (100.0 * (double)busy) / (double)total;
                if (pct < 0.0) pct = 0.0;
                if (pct > 100.0) pct = 100.0;
                g_last_cpu_percent = pct;
                metrics->cpu_percent = pct;
            } else {
                metrics->cpu_percent = g_last_cpu_percent;
            }
        }
        g_prev_idle      = cur_idle;
        g_prev_kernel    = cur_kernel;
        g_prev_user      = cur_user;
        g_has_cpu_sample = 1;
    }
    LeaveCriticalSection(&g_cpu_lock);

    /* 2. Live Physical Memory via GlobalMemoryStatusEx */
    MEMORYSTATUSEX mem;
    mem.dwLength = sizeof(mem);
    if (GlobalMemoryStatusEx(&mem)) {
        double total_mb = (double)mem.ullTotalPhys / (1024.0 * 1024.0);
        double avail_mb = (double)mem.ullAvailPhys / (1024.0 * 1024.0);
        double used_mb  = total_mb - avail_mb;
        if (used_mb < 0.0) used_mb = 0.0;
        metrics->ram_total_mb = total_mb;
        metrics->ram_used_mb  = used_mb;
        metrics->ram_percent  = (total_mb > 0.0) ? ((used_mb / total_mb) * 100.0) : (double)mem.dwMemoryLoad;
    }
}

static int compare_proc_mem_desc(const void *a, const void *b) {
    const OSProcessInfo *pa = (const OSProcessInfo *)a;
    const OSProcessInfo *pb = (const OSProcessInfo *)b;
    if (pb->memory_mb > pa->memory_mb) return 1;
    if (pb->memory_mb < pa->memory_mb) return -1;
    return (pa->pid > pb->pid) - (pa->pid < pb->pid);
}

/* Enumerate running Windows processes and working-set RAM usage */
void monitor_get_processes(OSProcessList *plist) {
    memset(plist, 0, sizeof(OSProcessList));
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return;

    PROCESSENTRY32 pe;
    pe.dwSize = sizeof(pe);
    if (Process32First(snap, &pe)) {
        do {
            if (plist->count >= MAX_OS_PROCESSES) break;
            OSProcessInfo *item = &plist->list[plist->count++];
            item->pid = (unsigned long)pe.th32ProcessID;
            strncpy(item->name, pe.szExeFile, sizeof(item->name) - 1);
            item->name[sizeof(item->name) - 1] = '\0';
            item->memory_mb = 0.0;

            HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                                       FALSE, pe.th32ProcessID);
            if (!hProc) {
                hProc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                                    FALSE, pe.th32ProcessID);
            }
            if (hProc) {
                PROCESS_MEMORY_COUNTERS pmc;
                memset(&pmc, 0, sizeof(pmc));
                pmc.cb = sizeof(pmc);
                if (GetProcessMemoryInfo(hProc, &pmc, sizeof(pmc))) {
                    item->memory_mb = (double)pmc.WorkingSetSize / (1024.0 * 1024.0);
                }
                CloseHandle(hProc);
            }
        } while (Process32Next(snap, &pe));
    }
    CloseHandle(snap);

    /* Sort by memory descending so heavy workloads appear first */
    if (plist->count > 1) {
        qsort(plist->list, (size_t)plist->count, sizeof(OSProcessInfo), compare_proc_mem_desc);
    }
}

static int file_exists_win(const char *path) {
    DWORD attr = GetFileAttributesA(path);
    return (attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY));
}

/* Launch strictly from a hardcoded whitelist (never execute arbitrary user strings) */
int monitor_launch_app(const char *app_key, int pin_core, LaunchResult *res) {
    memset(res, 0, sizeof(LaunchResult));
    res->pinned_core = -1;

    if (!app_key) {
        strcpy(res->message, "Missing application name.");
        return 400;
    }

    char lower[32];
    size_t i = 0;
    for (; app_key[i] && i < sizeof(lower) - 1; i++) {
        lower[i] = (char)tolower((unsigned char)app_key[i]);
    }
    lower[i] = '\0';

    char exe_path[MAX_PATH] = {0};
    char local_app[MAX_PATH] = {0};
    GetEnvironmentVariableA("LOCALAPPDATA", local_app, MAX_PATH);

    if (strcmp(lower, "notepad") == 0) {
        strcpy(res->app_name, "Notepad");
        strcpy(exe_path, "C:\\Windows\\System32\\notepad.exe");
    } else if (strcmp(lower, "calculator") == 0 || strcmp(lower, "calc") == 0) {
        strcpy(res->app_name, "Calculator");
        strcpy(exe_path, "C:\\Windows\\System32\\calc.exe");
    } else if (strcmp(lower, "chrome") == 0) {
        strcpy(res->app_name, "Google Chrome");
        const char *c1 = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
        const char *c2 = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
        char c3[MAX_PATH];
        snprintf(c3, sizeof(c3), "%s\\Google\\Chrome\\Application\\chrome.exe", local_app);
        if (file_exists_win(c1)) strcpy(exe_path, c1);
        else if (file_exists_win(c2)) strcpy(exe_path, c2);
        else if (local_app[0] && file_exists_win(c3)) strcpy(exe_path, c3);
        else {
            strcpy(res->message, "Google Chrome executable not found in standard Windows directories.");
            return 404;
        }
    } else if (strcmp(lower, "vscode") == 0 || strcmp(lower, "code") == 0) {
        strcpy(res->app_name, "VS Code");
        char v1[MAX_PATH];
        snprintf(v1, sizeof(v1), "%s\\Programs\\Microsoft VS Code\\Code.exe", local_app);
        const char *v2 = "C:\\Program Files\\Microsoft VS Code\\Code.exe";
        if (local_app[0] && file_exists_win(v1)) strcpy(exe_path, v1);
        else if (file_exists_win(v2)) strcpy(exe_path, v2);
        else {
            strcpy(res->message, "VS Code executable not found in standard Windows directories.");
            return 404;
        }
    } else {
        strcpy(res->message, "Application not allowed. Whitelist: chrome, vscode, notepad, calculator.");
        return 403;
    }

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si));
    memset(&pi, 0, sizeof(pi));
    si.cb = sizeof(si);

    if (!CreateProcessA(exe_path, NULL, NULL, NULL, FALSE,
                        CREATE_NEW_PROCESS_GROUP, NULL, NULL, &si, &pi)) {
        snprintf(res->message, sizeof(res->message),
                 "CreateProcess failed for %s (Win32 error %lu).",
                 res->app_name, (unsigned long)GetLastError());
        return 500;
    }

    res->pid = (unsigned long)pi.dwProcessId;
    res->success = 1;

    /* Optional bonus: pin launched process to a specific logical core */
    HardwareInfo hw;
    monitor_get_hardware(&hw);
    if (pin_core >= 0 && pin_core < hw.logical_processors && pin_core < 64) {
        DWORD_PTR mask = ((DWORD_PTR)1ULL << pin_core);
        if (SetProcessAffinityMask(pi.hProcess, mask)) {
            res->pinned_core = pin_core;
            snprintf(res->message, sizeof(res->message),
                     "%s launched (PID %lu) and pinned to Core %d.",
                     res->app_name, res->pid, pin_core);
        } else {
            snprintf(res->message, sizeof(res->message),
                     "%s launched (PID %lu), but affinity pinning was skipped by OS.",
                     res->app_name, res->pid);
        }
    } else {
        snprintf(res->message, sizeof(res->message),
                 "%s launched successfully (PID %lu).",
                 res->app_name, res->pid);
    }

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 200;
}
