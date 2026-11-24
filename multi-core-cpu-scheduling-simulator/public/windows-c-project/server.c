#ifndef __USE_MINGW_ANSI_STDIO
#define __USE_MINGW_ANSI_STDIO 1
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600
#endif
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <stdarg.h>
#include <ctype.h>
#include <errno.h>

#include "scheduler.h"
#include "monitor.h"

#define SERVER_PORT     8080
#define MAX_REQ_SIZE    (256 * 1024)

static const char hosted_origin[] = "https://multi-core-cpu-scheduling-simulator.vercel.app";
static int allow_hosted = 0;

/*
 * ============================================================================
 * PURE C11 WINSOCK2 MULTI-THREADED HTTP SERVER
 * ============================================================================
 * - Spawns one Windows worker thread (CreateThread) per incoming HTTP client.
 * - Uses manual dynamic StringBuilder for JSON & CSV serialization (zero libs).
 * - Protects cached simulation & comparison results with a CRITICAL_SECTION
 *   so GET /api/report.csv is completely thread-safe.
 * ============================================================================
 */

static CRITICAL_SECTION g_report_lock;
static int g_has_last_sim = 0;
static SimResult g_last_sim;
static int g_has_last_cmp = 0;
static CompareResult g_last_cmp;
static _Thread_local const char *tl_allowed_origin;

/* ======================== Dynamic StringBuilder ======================== */
typedef struct {
    char *data;
    size_t len;
    size_t cap;
} StrBuf;

static void sb_init(StrBuf *sb, size_t initial_cap) {
    sb->cap = (initial_cap < 256) ? 256 : initial_cap;
    sb->len = 0;
    sb->data = (char *)malloc(sb->cap);
    if (sb->data) sb->data[0] = '\0';
}

static void sb_free(StrBuf *sb) {
    free(sb->data);
    sb->data = NULL;
    sb->len = 0;
    sb->cap = 0;
}

static int sb_reserve(StrBuf *sb, size_t extra) {
    if (!sb->data) return 0;
    if (extra > SIZE_MAX - sb->len - 1) return 0;
    if (sb->len + extra + 1 <= sb->cap) return 1;
    size_t new_cap = sb->cap * 2;
    while (new_cap < sb->len + extra + 1) {
        if (new_cap > SIZE_MAX / 2) {
            new_cap = sb->len + extra + 1;
            break;
        }
        new_cap *= 2;
    }
    char *p = (char *)realloc(sb->data, new_cap);
    if (!p) return 0;
    sb->data = p;
    sb->cap = new_cap;
    return 1;
}

static void sb_append(StrBuf *sb, const char *s) {
    if (!s || !sb->data) return;
    size_t n = strlen(s);
    if (!sb_reserve(sb, n)) return;
    memcpy(sb->data + sb->len, s, n + 1);
    sb->len += n;
}

static void sb_appendf(StrBuf *sb, const char *fmt, ...) {
    if (!sb->data) return;
    va_list args, copy;
    va_start(args, fmt);
    va_copy(copy, args);
    int needed = vsnprintf(NULL, 0, fmt, args);
    va_end(args);
    if (needed < 0) {
        va_end(copy);
        return;
    }
    if (!sb_reserve(sb, (size_t)needed)) {
        va_end(copy);
        return;
    }
    vsnprintf(sb->data + sb->len, (size_t)needed + 1, fmt, copy);
    sb->len += (size_t)needed;
    va_end(copy);
}

/* Append properly JSON-escaped quoted string */
static void sb_append_json_str(StrBuf *sb, const char *s) {
    sb_append(sb, "\"");
    if (s) {
        for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
            switch (*p) {
                case '"':  sb_append(sb, "\\\""); break;
                case '\\': sb_append(sb, "\\\\"); break;
                case '\b': sb_append(sb, "\\b");  break;
                case '\f': sb_append(sb, "\\f");  break;
                case '\n': sb_append(sb, "\\n");  break;
                case '\r': sb_append(sb, "\\r");  break;
                case '\t': sb_append(sb, "\\t");  break;
                default:
                    if (*p < 0x20) sb_appendf(sb, "\\u%04x", *p);
                    else sb_appendf(sb, "%c", (char)*p);
            }
        }
    }
    sb_append(sb, "\"");
}

/* Append RFC 4180 CSV-escaped cell with spreadsheet formula-injection guard */
static void sb_append_csv_str(StrBuf *sb, const char *s) {
    if (!s) return;
    int needs_quote = 0;
    int formula_prefix = (*s == '=' || *s == '+' || *s == '-' || *s == '@' || *s == '\t' || *s == '\r');
    for (const char *p = s; *p; p++) {
        if (*p == ',' || *p == '"' || *p == '\n' || *p == '\r') {
            needs_quote = 1;
            break;
        }
    }
    if (needs_quote) sb_append(sb, "\"");
    if (formula_prefix) sb_append(sb, "'");
    for (const char *p = s; *p; p++) {
        if (*p == '"') sb_append(sb, "\"\"");
        else sb_appendf(sb, "%c", *p);
    }
    if (needs_quote) sb_append(sb, "\"");
}

/* ======================== Hand-Written JSON Parser ======================== */
static const char *skip_ws(const char *p) {
    while (p && *p && isspace((unsigned char)*p)) p++;
    return p;
}

/* Find `"key"` within [start, end) and return pointer right after `:` */
static const char *json_find_key(const char *start, const char *end, const char *key) {
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    size_t plen = strlen(pattern);

    const char *p = start;
    while (p && p < end) {
        if (*p == '"') {
            if ((size_t)(end - p) >= plen && strncmp(p, pattern, plen) == 0) {
                const char *after = skip_ws(p + plen);
                if (after < end && *after == ':') {
                    return skip_ws(after + 1);
                }
            }
            /* Skip rest of string literal */
            p++;
            while (p < end && *p) {
                if (*p == '\\' && (p + 1) < end) { p += 2; continue; }
                if (*p == '"') { p++; break; }
                p++;
            }
        } else {
            p++;
        }
    }
    return NULL;
}

static int json_get_int(const char *start, const char *end, const char *key, int default_val) {
    const char *v = json_find_key(start, end, key);
    if (!v || v >= end) return default_val;
    if (*v == '"') v++;
    char *next = NULL;
    long val = strtol(v, &next, 10);
    return (next && next != v) ? (int)val : default_val;
}

static int json_get_string(const char *start, const char *end, const char *key, char *out, size_t out_sz) {
    const char *v = json_find_key(start, end, key);
    if (!v || v >= end) return 0;
    if (*v == '"') {
        v++;
        size_t i = 0;
        while (v < end && *v && *v != '"' && i + 1 < out_sz) {
            if (*v == '\\' && (v + 1) < end) v++;
            out[i++] = *v++;
        }
        out[i] = '\0';
        return 1;
    } else {
        /* Allow unquoted numeric PID like "pid": 1 */
        size_t i = 0;
        while (v < end && *v && !isspace((unsigned char)*v) && *v != ',' && *v != '}' && i + 1 < out_sz) {
            out[i++] = *v++;
        }
        out[i] = '\0';
        return (i > 0);
    }
}

/* Parse "processes": [ { "pid": "P1", "arrival": 0, "burst": 8, "priority": 3 }, ... ] */
static int json_parse_processes(const char *body, ProcessInput *out, int max_procs) {
    const char *end = body + strlen(body);
    const char *arr = json_find_key(body, end, "processes");
    if (!arr || *arr != '[') return 0;

    int count = 0;
    const char *p = arr + 1;
    while (p < end && *p && *p != ']' && count < max_procs) {
        p = skip_ws(p);
        if (*p == '{') {
            const char *obj_start = p + 1;
            const char *obj_end = obj_start;
            int depth = 1;
            int in_str = 0;
            while (obj_end < end && *obj_end && depth > 0) {
                if (in_str) {
                    if (*obj_end == '\\' && (obj_end + 1) < end) {
                        obj_end += 2;
                        continue;
                    }
                    if (*obj_end == '"') in_str = 0;
                } else {
                    if (*obj_end == '"') in_str = 1;
                    else if (*obj_end == '{') depth++;
                    else if (*obj_end == '}') depth--;
                }
                obj_end++;
            }
            if (depth != 0) break;

            ProcessInput *pi = &out[count];
            memset(pi, 0, sizeof(ProcessInput));
            if (!json_get_string(obj_start, obj_end, "pid", pi->pid, sizeof(pi->pid))) {
                snprintf(pi->pid, sizeof(pi->pid), "P%d", count + 1);
            }
            pi->arrival  = json_get_int(obj_start, obj_end, "arrival", 0);
            pi->burst    = json_get_int(obj_start, obj_end, "burst", 1);
            pi->priority = json_get_int(obj_start, obj_end, "priority", 1);
            if (pi->arrival < 0) pi->arrival = 0;
            if (pi->burst < 1)   pi->burst = 1;
            count++;
            p = obj_end;
        } else {
            p++;
        }
    }
    return count;
}

/* ======================== JSON Serializers ======================== */
static void serialize_sim_result(StrBuf *sb, const SimResult *r, int include_ticks) {
    sb_append(sb, "{");
    sb_append(sb, "\"algorithm\":");
    sb_append_json_str(sb, algorithm_to_string(r->config.algorithm));
    sb_appendf(sb, ",\"cores\":%d,\"quantum\":%d,\"priorityMode\":",
               r->config.num_cores, r->config.quantum);
    sb_append_json_str(sb, r->config.priority_preemptive ? "preemptive" : "non-preemptive");

    /* Processes */
    sb_append(sb, ",\"processes\":[");
    for (int i = 0; i < r->num_procs; i++) {
        const ProcessResult *p = &r->procs[i];
        if (i > 0) sb_append(sb, ",");
        sb_append(sb, "{\"pid\":");
        sb_append_json_str(sb, p->pid);
        sb_appendf(sb, ",\"arrival\":%d,\"burst\":%d,\"priority\":%d,"
                       "\"firstStart\":%d,\"completion\":%d,"
                       "\"turnaround\":%d,\"waiting\":%d,\"response\":%d}",
                   p->arrival, p->burst, p->priority,
                   p->first_start, p->completion,
                   p->turnaround, p->waiting, p->response);
    }
    sb_append(sb, "]");

    /* Gantt segments */
    sb_append(sb, ",\"gantt\":[");
    for (int i = 0; i < r->num_segments; i++) {
        const GanttSegment *s = &r->segments[i];
        if (i > 0) sb_append(sb, ",");
        sb_appendf(sb, "{\"core\":%d,\"pid\":", s->core);
        sb_append_json_str(sb, s->pid);
        sb_appendf(sb, ",\"idle\":%s,\"start\":%d,\"end\":%d}",
                   s->is_idle ? "true" : "false", s->start, s->end);
    }
    sb_append(sb, "]");

    /* Live tick-by-tick snapshots */
    if (include_ticks) {
        sb_append(sb, ",\"ticks\":[");
        for (int i = 0; i < r->num_snapshots; i++) {
            const TickSnapshot *ts = &r->snapshots[i];
            if (i > 0) sb_append(sb, ",");
            sb_appendf(sb, "{\"tick\":%d,\"completed\":%d,\"cores\":[", ts->tick, ts->completed_count);
            for (int c = 0; c < r->config.num_cores; c++) {
                if (c > 0) sb_append(sb, ",");
                sb_append_json_str(sb, ts->core_pid[c]);
            }
            sb_append(sb, "],\"readyQueue\":[");
            int rcap = (ts->ready_count < 8) ? ts->ready_count : 8;
            for (int k = 0; k < rcap; k++) {
                if (k > 0) sb_append(sb, ",");
                sb_append_json_str(sb, ts->ready_pids[k]);
            }
            sb_append(sb, "]}");
        }
        sb_append(sb, "]");
    }

    /* Aggregate performance metrics */
    sb_appendf(sb,
        ",\"metrics\":{"
        "\"avgTurnaround\":%.2f,"
        "\"avgWaiting\":%.2f,"
        "\"avgResponse\":%.2f,"
        "\"throughput\":%.4f,"
        "\"cpuUtilization\":%.2f,"
        "\"makespan\":%d,"
        "\"totalBusyTime\":%d,"
        "\"totalIdleTime\":%d,"
        "\"contextSwitches\":%d,"
        "\"coreUtilization\":[",
        r->avg_turnaround, r->avg_waiting, r->avg_response,
        r->throughput, r->cpu_utilization,
        r->makespan, r->total_busy_time, r->total_idle_time, r->context_switches);
    for (int c = 0; c < r->config.num_cores; c++) {
        if (c > 0) sb_append(sb, ",");
        sb_appendf(sb, "{\"core\":%d,\"utilization\":%.2f,\"busyTime\":%d,\"idleTime\":%d}",
                   c, r->core_utilization[c], r->core_busy_time[c], r->core_idle_time[c]);
    }
    sb_append(sb, "]}}");
}

/* ======================== HTTP Transport Helpers ======================== */
static const char *status_text(int code) {
    switch (code) {
        case 200: return "OK";
        case 204: return "No Content";
        case 400: return "Bad Request";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 413: return "Payload Too Large";
        case 415: return "Unsupported Media Type";
        default:  return "Internal Server Error";
    }
}

static const char *resolve_allowed_origin(const char *origin) {
    if (!origin) return NULL;
    if (allow_hosted && strcmp(origin, hosted_origin) == 0) return hosted_origin;
    static const char *const allowed[] = {
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173"
    };
    for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); i++) {
        if (_stricmp(origin, allowed[i]) == 0) {
            return allowed[i];
        }
    }
    return NULL;
}

static void send_all(SOCKET sock, const char *buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        int n = send(sock, buf + sent, (int)(len - sent), 0);
        if (n <= 0) break;
        sent += (size_t)n;
    }
}

static void send_response_cors(SOCKET sock, int code, const char *content_type,
                               const char *allowed_origin, const char *extra_headers,
                               const char *body, size_t body_len) {
    char cors_hdr[256] = {0};
    if (allowed_origin) {
        snprintf(cors_hdr, sizeof(cors_hdr),
                 "Access-Control-Allow-Origin: %s\r\n"
                 "Vary: Origin\r\n",
                 allowed_origin);
    }
    char header[1280];
    int hlen = snprintf(header, sizeof(header),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %lu\r\n"
        "%s"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type\r\n"
        "X-Content-Type-Options: nosniff\r\n"
        "Referrer-Policy: no-referrer\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n"
        "%s\r\n",
        code, status_text(code), content_type, (unsigned long)body_len,
        cors_hdr,
        extra_headers ? extra_headers : "");
    if (hlen > 0) {
        size_t safe_len = ((size_t)hlen < sizeof(header)) ? (size_t)hlen : sizeof(header) - 1;
        send_all(sock, header, safe_len);
    }
    if (body && body_len > 0) {
        send_all(sock, body, body_len);
    }
}

static void send_response(SOCKET sock, int code, const char *content_type,
                          const char *extra_headers, const char *body, size_t body_len) {
    send_response_cors(sock, code, content_type, tl_allowed_origin, extra_headers, body, body_len);
}

static void send_json_error(SOCKET sock, int code, const char *msg) {
    StrBuf sb;
    sb_init(&sb, 256);
    sb_append(&sb, "{\"error\":");
    sb_append_json_str(&sb, msg);
    sb_append(&sb, "}");
    send_response(sock, code, "application/json; charset=utf-8", NULL, sb.data, sb.len);
    sb_free(&sb);
}

/* ======================== Route Handlers ======================== */
static void handle_dashboard(SOCKET sock) {
    FILE *f = fopen("dashboard.html", "rb");
    if (!f) {
        send_json_error(sock, 404, "dashboard.html not found in server working directory.");
        return;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) {
        fclose(f);
        send_json_error(sock, 500, "Failed to read dashboard.html.");
        return;
    }
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        send_json_error(sock, 500, "Out of memory.");
        return;
    }
    size_t read_n = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    send_response(sock, 200, "text/html; charset=utf-8", NULL, buf, read_n);
    free(buf);
}

static void handle_simulate(SOCKET sock, const char *body) {
    ProcessInput procs[MAX_PROCS];
    int n = json_parse_processes(body, procs, MAX_PROCS);
    if (n <= 0) {
        send_json_error(sock, 400, "Request must include a non-empty 'processes' array.");
        return;
    }

    const char *end = body + strlen(body);
    char alg_str[32] = "FCFS";
    char prio_mode[32] = "preemptive";
    json_get_string(body, end, "algorithm", alg_str, sizeof(alg_str));
    json_get_string(body, end, "priorityMode", prio_mode, sizeof(prio_mode));

    SimConfig cfg;
    cfg.algorithm = string_to_algorithm(alg_str);
    cfg.num_cores = json_get_int(body, end, "cores", 2);
    cfg.quantum   = json_get_int(body, end, "quantum", 3);
    cfg.priority_preemptive = (strstr(prio_mode, "non") != NULL) ? 0 : 1;

    SimResult *res = (SimResult *)calloc(1, sizeof(SimResult));
    if (!res) {
        send_json_error(sock, 500, "Out of memory.");
        return;
    }

    if (run_simulation(procs, n, &cfg, res) != 0) {
        free(res);
        send_json_error(sock, 400, "Invalid simulation parameters.");
        return;
    }

    /* Cache last simulation for GET /api/report.csv */
    EnterCriticalSection(&g_report_lock);
    g_last_sim = *res;
    g_has_last_sim = 1;
    LeaveCriticalSection(&g_report_lock);

    StrBuf sb;
    sb_init(&sb, 8192);
    serialize_sim_result(&sb, res, 1);
    send_response(sock, 200, "application/json; charset=utf-8", NULL, sb.data, sb.len);
    sb_free(&sb);
    free(res);
}

static void handle_compare(SOCKET sock, const char *body) {
    ProcessInput procs[MAX_PROCS];
    int n = json_parse_processes(body, procs, MAX_PROCS);
    if (n <= 0) {
        send_json_error(sock, 400, "Request must include a non-empty 'processes' array.");
        return;
    }

    const char *end = body + strlen(body);
    int cores   = json_get_int(body, end, "cores", 2);
    int quantum = json_get_int(body, end, "quantum", 3);
    char prio_mode[32] = "preemptive";
    json_get_string(body, end, "priorityMode", prio_mode, sizeof(prio_mode));
    int prio_preempt = (strstr(prio_mode, "non") != NULL) ? 0 : 1;

    CompareResult *cmp = (CompareResult *)calloc(1, sizeof(CompareResult));
    if (!cmp) {
        send_json_error(sock, 500, "Out of memory.");
        return;
    }

    if (run_compare_all(procs, n, cores, quantum, prio_preempt, cmp) != 0) {
        free(cmp);
        send_json_error(sock, 400, "Comparison failed.");
        return;
    }

    EnterCriticalSection(&g_report_lock);
    g_last_cmp = *cmp;
    g_has_last_cmp = 1;
    LeaveCriticalSection(&g_report_lock);

    /* Identify best algorithm per metric */
    int best_wt = 0, best_tat = 0, best_rt = 0, best_cpu = 0, best_cs = 0;
    for (int i = 1; i < cmp->count; i++) {
        if (cmp->results[i].avg_waiting    < cmp->results[best_wt].avg_waiting)       best_wt  = i;
        if (cmp->results[i].avg_turnaround < cmp->results[best_tat].avg_turnaround)   best_tat = i;
        if (cmp->results[i].avg_response   < cmp->results[best_rt].avg_response)      best_rt  = i;
        if (cmp->results[i].cpu_utilization > cmp->results[best_cpu].cpu_utilization) best_cpu = i;
        if (cmp->results[i].context_switches < cmp->results[best_cs].context_switches) best_cs = i;
    }

    StrBuf sb;
    sb_init(&sb, 16384);
    sb_append(&sb, "{\"results\":[");
    for (int i = 0; i < cmp->count; i++) {
        if (i > 0) sb_append(&sb, ",");
        serialize_sim_result(&sb, &cmp->results[i], 0);
    }
    sb_append(&sb, "],\"best\":{");
    sb_append(&sb, "\"avgWaiting\":");     sb_append_json_str(&sb, algorithm_to_string(cmp->results[best_wt].config.algorithm));
    sb_append(&sb, ",\"avgTurnaround\":"); sb_append_json_str(&sb, algorithm_to_string(cmp->results[best_tat].config.algorithm));
    sb_append(&sb, ",\"avgResponse\":");   sb_append_json_str(&sb, algorithm_to_string(cmp->results[best_rt].config.algorithm));
    sb_append(&sb, ",\"cpuUtilization\":");sb_append_json_str(&sb, algorithm_to_string(cmp->results[best_cpu].config.algorithm));
    sb_append(&sb, ",\"contextSwitches\":");sb_append_json_str(&sb, algorithm_to_string(cmp->results[best_cs].config.algorithm));
    sb_append(&sb, "}}");

    send_response(sock, 200, "application/json; charset=utf-8", NULL, sb.data, sb.len);
    sb_free(&sb);
    free(cmp);
}

static void handle_hardware(SOCKET sock) {
    HardwareInfo hw;
    monitor_get_hardware(&hw);

    StrBuf sb;
    sb_init(&sb, 512);
    sb_append(&sb, "{\"cpuModel\":");
    sb_append_json_str(&sb, hw.cpu_model);
    sb_appendf(&sb, ",\"physicalCores\":%d,\"logicalProcessors\":%d,\"affinityCores\":[",
               hw.physical_cores, hw.logical_processors);
    for (int i = 0; i < hw.affinity_core_count; i++) {
        if (i > 0) sb_append(&sb, ",");
        sb_appendf(&sb, "%d", hw.affinity_cores[i]);
    }
    sb_append(&sb, "]}");
    send_response(sock, 200, "application/json; charset=utf-8", NULL, sb.data, sb.len);
    sb_free(&sb);
}

static void handle_live(SOCKET sock) {
    LiveMetrics m;
    monitor_get_live_metrics(&m);

    StrBuf sb;
    sb_init(&sb, 256);
    sb_appendf(&sb,
        "{\"cpuPercent\":%.1f,\"ramUsedMB\":%.1f,\"ramTotalMB\":%.1f,\"ramPercent\":%.1f,\"timestamp\":%llu}",
        m.cpu_percent, m.ram_used_mb, m.ram_total_mb, m.ram_percent, m.timestamp_ms);
    send_response(sock, 200, "application/json; charset=utf-8", NULL, sb.data, sb.len);
    sb_free(&sb);
}

static void handle_processes(SOCKET sock) {
    OSProcessList *plist = (OSProcessList *)calloc(1, sizeof(OSProcessList));
    if (!plist) {
        send_json_error(sock, 500, "Out of memory.");
        return;
    }
    monitor_get_processes(plist);

    StrBuf sb;
    sb_init(&sb, 32768);
    sb_appendf(&sb, "{\"count\":%d,\"processes\":[", plist->count);
    for (int i = 0; i < plist->count; i++) {
        if (i > 0) sb_append(&sb, ",");
        sb_appendf(&sb, "{\"pid\":%lu,\"name\":", plist->list[i].pid);
        sb_append_json_str(&sb, plist->list[i].name);
        sb_appendf(&sb, ",\"memoryMB\":%.2f}", plist->list[i].memory_mb);
    }
    sb_append(&sb, "]}");

    send_response(sock, 200, "application/json; charset=utf-8", NULL, sb.data, sb.len);
    sb_free(&sb);
    free(plist);
}

static void handle_launch(SOCKET sock, const char *body) {
    const char *end = body + strlen(body);
    char app[64] = {0};
    if (!json_get_string(body, end, "app", app, sizeof(app))) {
        send_json_error(sock, 400, "Missing 'app' field in JSON body.");
        return;
    }
    int pin_core = -1;
    const char *core_value = json_find_key(body, end, "core");
    if (core_value) {
        char *next;
        errno = 0;
        long parsed_core = strtol(core_value, &next, 10);
        if (next == core_value || errno == ERANGE || parsed_core < -1 || parsed_core >= MAX_AFFINITY_CORES ||
            (*skip_ws(next) != ',' && *skip_ws(next) != '}')) {
            send_json_error(sock, 400, "Core must be -1 (OS Default) or a supported logical CPU index.");
            return;
        }
        pin_core = (int)parsed_core;
    }

    LaunchResult lr;
    int http_code = monitor_launch_app(app, pin_core, &lr);

    StrBuf sb;
    sb_init(&sb, 512);
    sb_appendf(&sb, "{\"launched\":%s,\"pid\":%lu,\"pinnedCore\":%d,\"app\":",
               lr.success ? "true" : "false", lr.pid, lr.pinned_core);
    sb_append_json_str(&sb, lr.app_name[0] ? lr.app_name : app);
    sb_append(&sb, ",\"message\":");
    sb_append_json_str(&sb, lr.message);
    sb_append(&sb, "}");
    send_response(sock, http_code, "application/json; charset=utf-8", NULL, sb.data, sb.len);
    sb_free(&sb);
}

static void handle_report_csv(SOCKET sock) {
    SimResult *sim_copy = (SimResult *)calloc(1, sizeof(SimResult));
    CompareResult *cmp_copy = (CompareResult *)calloc(1, sizeof(CompareResult));
    if (!sim_copy || !cmp_copy) {
        free(sim_copy);
        free(cmp_copy);
        send_json_error(sock, 500, "Out of memory.");
        return;
    }

    StrBuf sb;
    sb_init(&sb, 8192);

    EnterCriticalSection(&g_report_lock);
    int has_sim = g_has_last_sim;
    int has_cmp = g_has_last_cmp;
    if (has_sim) *sim_copy = g_last_sim;
    if (has_cmp) *cmp_copy = g_last_cmp;
    LeaveCriticalSection(&g_report_lock);

    if (!has_sim && !has_cmp) {
        /* Auto-generate report from default sample workload if none run yet */
        ProcessInput sample[5] = {
            {"P1", 0, 8, 3}, {"P2", 1, 4, 1}, {"P3", 2, 9, 4},
            {"P4", 3, 5, 2}, {"P5", 4, 2, 5}
        };
        run_compare_all(sample, 5, 2, 3, 1, cmp_copy);
        *sim_copy = cmp_copy->results[0];
        has_sim = 1;
        has_cmp = 1;
    }

    sb_append(&sb, "Multi-Core CPU Scheduling Simulator - Performance Report\r\n\r\n");

    if (has_sim) {
        sb_appendf(&sb, "LAST SIMULATION,%s,Cores,%d,Quantum,%d,PriorityMode,%s\r\n",
                   algorithm_to_string(sim_copy->config.algorithm),
                   sim_copy->config.num_cores, sim_copy->config.quantum,
                   sim_copy->config.priority_preemptive ? "Preemptive" : "Non-Preemptive");
        sb_append(&sb, "PID,Arrival,Burst,Priority,FirstStart,Completion,Turnaround,Waiting,Response\r\n");
        for (int i = 0; i < sim_copy->num_procs; i++) {
            const ProcessResult *p = &sim_copy->procs[i];
            sb_append_csv_str(&sb, p->pid);
            sb_appendf(&sb, ",%d,%d,%d,%d,%d,%d,%d,%d\r\n",
                       p->arrival, p->burst, p->priority,
                       p->first_start, p->completion, p->turnaround, p->waiting, p->response);
        }
        sb_appendf(&sb, "Summary,AvgTurnaround,%.2f,AvgWaiting,%.2f,AvgResponse,%.2f,Throughput,%.4f,CPUUtilization%%,%.2f,Makespan,%d,IdleTime,%d,ContextSwitches,%d\r\n\r\n",
                   sim_copy->avg_turnaround, sim_copy->avg_waiting, sim_copy->avg_response,
                   sim_copy->throughput, sim_copy->cpu_utilization,
                   sim_copy->makespan, sim_copy->total_idle_time, sim_copy->context_switches);
    }

    if (has_cmp) {
        sb_append(&sb, "ALGORITHM COMPARISON\r\n");
        sb_append(&sb, "Algorithm,AvgTurnaround,AvgWaiting,AvgResponse,Throughput,CPUUtilization%,Makespan,IdleTime,ContextSwitches\r\n");
        for (int i = 0; i < cmp_copy->count; i++) {
            const SimResult *r = &cmp_copy->results[i];
            sb_appendf(&sb, "%s,%.2f,%.2f,%.2f,%.4f,%.2f,%d,%d,%d\r\n",
                       algorithm_to_string(r->config.algorithm),
                       r->avg_turnaround, r->avg_waiting, r->avg_response,
                       r->throughput, r->cpu_utilization,
                       r->makespan, r->total_idle_time, r->context_switches);
        }
    }

    send_response(sock, 200, "text/csv; charset=utf-8",
                  "Content-Disposition: attachment; filename=\"cpu_scheduler_report.csv\"\r\n",
                  sb.data, sb.len);
    sb_free(&sb);
    free(sim_copy);
    free(cmp_copy);
}

/* ======================== Per-Client HTTP Thread ======================== */
typedef struct {
    const char *host;
    const char *origin;
    const char *content_type;
    const char *private_network;
    size_t content_length;
} RequestHeaders;

static const char *trim_header_value(char *value) {
    while (*value == ' ' || *value == '\t') value++;
    char *end = value + strlen(value);
    while (end > value && (end[-1] == ' ' || end[-1] == '\t')) *--end = '\0';
    return value;
}

static int parse_request_headers(char *request, char *header_end, RequestHeaders *headers) {
    char *line_end = strstr(request, "\r\n");
    *line_end = '\0';
    int has_content_length = 0;

    while (line_end < header_end) {
        char *line = line_end + 2;
        line_end = strstr(line, "\r\n");
        *line_end = '\0';
        char *separator = strchr(line, ':');
        if (!separator || separator == line) return 400;
        *separator = '\0';
        const char *value = trim_header_value(separator + 1);

        const char **field = NULL;
        if (_stricmp(line, "Host") == 0) field = &headers->host;
        else if (_stricmp(line, "Origin") == 0) field = &headers->origin;
        else if (_stricmp(line, "Content-Type") == 0) field = &headers->content_type;
        else if (_stricmp(line, "Access-Control-Request-Private-Network") == 0) field = &headers->private_network;

        if (field) {
            if (*field || !*value) return 400;
            *field = value;
        } else if (_stricmp(line, "Transfer-Encoding") == 0) {
            return 400;
        } else if (_stricmp(line, "Content-Length") == 0) {
            if (has_content_length || !isdigit((unsigned char)*value)) return 400;
            char *next;
            unsigned long length = strtoul(value, &next, 10);
            if (*next) return 400;
            if (length > MAX_REQ_SIZE) return 413;
            headers->content_length = (size_t)length;
            has_content_length = 1;
        }
    }
    return 0;
}

static int is_loopback_host(const char *host) {
    return host && (_stricmp(host, "localhost:8080") == 0 || strcmp(host, "127.0.0.1:8080") == 0);
}

static int is_json_content_type(const char *content_type) {
    static const char json[] = "application/json";
    if (!content_type || _strnicmp(content_type, json, sizeof(json) - 1) != 0) return 0;
    const char *suffix = skip_ws(content_type + sizeof(json) - 1);
    return *suffix == '\0' || *suffix == ';';
}

static DWORD WINAPI client_thread_proc(LPVOID param) {
    SOCKET sock = (SOCKET)(uintptr_t)param;

    /* Set a 5-second receive timeout so slow/broken clients cannot stall threads */
    DWORD timeout_ms = 5000;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));

    char *request = (char *)malloc(MAX_REQ_SIZE + 1);
    if (!request) {
        closesocket(sock);
        return 0;
    }

    size_t total = 0;
    size_t request_size = 0;
    char *body = NULL;
    RequestHeaders headers = {0};
    while (total < MAX_REQ_SIZE) {
        int n = recv(sock, request + total, (int)(MAX_REQ_SIZE - total), 0);
        if (n <= 0) break;
        total += (size_t)n;
        request[total] = '\0';

        if (!body) {
            char *header_end = strstr(request, "\r\n\r\n");
            if (!header_end) continue;
            int error = parse_request_headers(request, header_end, &headers);
            if (error) {
                send_json_error(sock, error, error == 413 ? "Request payload exceeds 256 KB limit." : "Malformed HTTP headers.");
                goto cleanup;
            }
            if (!is_loopback_host(headers.host)) {
                send_json_error(sock, 403, "Use the agent's loopback address.");
                goto cleanup;
            }
            tl_allowed_origin = resolve_allowed_origin(headers.origin);
            if (headers.origin && !tl_allowed_origin) {
                send_json_error(sock, 403, "Origin not permitted.");
                goto cleanup;
            }
            body = header_end + 4;
            request_size = (size_t)(body - request) + headers.content_length;
            if (request_size > MAX_REQ_SIZE) {
                send_json_error(sock, 413, "Request payload exceeds 256 KB limit.");
                goto cleanup;
            }
        }
        if (total >= request_size) break;
    }

    if (!body || total < request_size) goto cleanup;
    request[request_size] = '\0';

    char method[16] = {0};
    char path[256]  = {0};
    if (sscanf(request, "%15s %255s", method, path) != 2 || path[0] != '/') {
        send_json_error(sock, 400, "Malformed HTTP request line.");
        goto cleanup;
    }

    char *qmark = strchr(path, '?');
    if (qmark) *qmark = '\0';

    if (strcmp(method, "OPTIONS") == 0) {
        /* Compatibility with browsers that send a private-network preflight. */
        const char *private_network = tl_allowed_origin == hosted_origin && headers.private_network &&
                                      _stricmp(headers.private_network, "true") == 0
            ? "Access-Control-Allow-Private-Network: true\r\nVary: Access-Control-Request-Private-Network\r\n" : NULL;
        send_response(sock, 204, "text/plain", private_network, NULL, 0);
    } else if (strcmp(method, "POST") == 0 && !is_json_content_type(headers.content_type)) {
        send_json_error(sock, 415, "Send application/json with POST requests.");
    } else if (strcmp(method, "GET") == 0 && (strcmp(path, "/") == 0 || strcmp(path, "/dashboard.html") == 0)) {
        handle_dashboard(sock);
    } else if (strcmp(method, "POST") == 0 && strcmp(path, "/api/simulate") == 0) {
        handle_simulate(sock, body);
    } else if (strcmp(method, "POST") == 0 && strcmp(path, "/api/compare") == 0) {
        handle_compare(sock, body);
    } else if (strcmp(method, "GET") == 0 && strcmp(path, "/api/hardware") == 0) {
        handle_hardware(sock);
    } else if (strcmp(method, "GET") == 0 && strcmp(path, "/api/live") == 0) {
        handle_live(sock);
    } else if (strcmp(method, "GET") == 0 && strcmp(path, "/api/processes") == 0) {
        handle_processes(sock);
    } else if (strcmp(method, "POST") == 0 && strcmp(path, "/api/launch") == 0) {
        handle_launch(sock, body);
    } else if (strcmp(method, "GET") == 0 && strcmp(path, "/api/report.csv") == 0) {
        handle_report_csv(sock);
    } else {
        send_json_error(sock, 404, "Endpoint not found.");
    }

cleanup:
    free(request);
    closesocket(sock);
    return 0;
}

/* ======================== Entry Point ======================== */
int main(int argc, char **argv) {
    /* Built-in CLI verification mode: simulator.exe --test */
    if (argc >= 2 && strcmp(argv[1], "--test") == 0) {
        run_builtin_cli_test();
        return 0;
    }

    if (argc == 2 && strcmp(argv[1], "--allow-hosted") == 0) {
        allow_hosted = 1;
    } else if (argc != 1) {
        fprintf(stderr, "Usage: simulator.exe [--test | --allow-hosted]\n");
        return 1;
    }

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        fprintf(stderr, "WSAStartup failed.\n");
        return 1;
    }

    InitializeCriticalSection(&g_report_lock);
    monitor_init();

    SOCKET listen_sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listen_sock == INVALID_SOCKET) {
        fprintf(stderr, "Failed to create TCP socket.\n");
        WSACleanup();
        return 1;
    }

    BOOL reuse = TRUE;
    setsockopt(listen_sock, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse, sizeof(reuse));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port        = htons(SERVER_PORT);

    if (bind(listen_sock, (struct sockaddr *)&addr, sizeof(addr)) == SOCKET_ERROR) {
        fprintf(stderr, "bind() failed on port %d (is another instance running?).\n", SERVER_PORT);
        closesocket(listen_sock);
        WSACleanup();
        return 1;
    }

    if (listen(listen_sock, SOMAXCONN) == SOCKET_ERROR) {
        fprintf(stderr, "listen() failed.\n");
        closesocket(listen_sock);
        WSACleanup();
        return 1;
    }

    HardwareInfo hw;
    monitor_get_hardware(&hw);
    printf("==================================================================\n");
    printf(" Multi-Core CPU Scheduling Simulator & Hardware Monitor (C11)\n");
    printf("==================================================================\n");
    printf(" CPU Model         : %s\n", hw.cpu_model);
    printf(" Physical Cores    : %d\n", hw.physical_cores);
    printf(" Logical Processors: %d\n", hw.logical_processors);
    printf(" Dashboard URL     : http://127.0.0.1:%d/\n", SERVER_PORT);
    printf(" Hosted access     : %s\n", allow_hosted ? hosted_origin : "Disabled (start with --allow-hosted to enable)");
    printf(" Built-in Test     : simulator.exe --test\n");
    printf(" Press Ctrl+C to stop the server.\n");
    printf("==================================================================\n");
    fflush(stdout);

    for (;;) {
        SOCKET client_sock = accept(listen_sock, NULL, NULL);
        if (client_sock == INVALID_SOCKET) continue;

        HANDLE hThread = CreateThread(NULL, 0, client_thread_proc,
                                      (LPVOID)(uintptr_t)client_sock, 0, NULL);
        if (hThread) {
            CloseHandle(hThread); /* Detached thread cleans itself up on exit */
        } else {
            closesocket(client_sock);
        }
    }

    closesocket(listen_sock);
    monitor_cleanup();
    DeleteCriticalSection(&g_report_lock);
    WSACleanup();
    return 0;
}
