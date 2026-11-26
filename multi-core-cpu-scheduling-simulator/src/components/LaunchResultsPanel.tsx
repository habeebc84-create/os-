import { useEffect, useRef, useState } from 'react';
import { requestAgent } from '../lib/windowsAgent';
import type { CoreUsageResponse, LaunchReadyState, LaunchResult, LaunchStats } from '../lib/windowsAgent';

/** One confirmed launch, as reported by the Windows agent. */
export interface LaunchRecord extends LaunchResult {
  requestedAt: number;
}

const STATE_TEXT: Record<LaunchReadyState, string> = {
  ready: 'Ready for input',
  timeout: 'Still opening after 10 s',
  'no-input-idle': 'Started (no window to wait for)',
  exited: 'Handed off and exited',
};

function coreLabel(core: number | undefined): string {
  return core === undefined || core < 0 ? 'OS Default' : `Core ${core}`;
}

function coresText(cores: number[] | undefined): string {
  if (!cores || !cores.length) return 'Not reported';
  if (cores.length > 6) return `${cores.length} cores (${cores[0]}–${cores[cores.length - 1]})`;
  return cores.map((c) => `Core ${c}`).join(', ');
}

/** True when the agent says the process may run only on the core that was requested. */
function pinStatus(rec: { requestedCore?: number; pinnedCore?: number; affinityCores?: number[]; readyState?: LaunchReadyState }) {
  const requested = rec.requestedCore ?? -1;
  if (requested < 0) return { text: 'Not pinned (OS Default)', tone: 'text-muted' };
  if (rec.readyState === 'exited') return { text: 'Not verifiable: process exited', tone: 'text-warning' };
  const actual = rec.affinityCores;
  if (actual?.length === 1 && actual[0] === requested) return { text: `Pinned to Core ${requested}: verified`, tone: 'text-success' };
  if (rec.pinnedCore === requested && !actual) return { text: `Pinned to Core ${requested}`, tone: 'text-success' };
  return { text: `Pin to Core ${requested} failed`, tone: 'text-danger' };
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return 'Not reported';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function CoreBars({ usage, pinned, label }: { usage: number[]; pinned: number; label: string }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2" aria-label={label}>
      {usage.map((pct, core) => {
        const isPinned = core === pinned;
        const value = Math.max(0, Math.min(100, pct));
        return (
          <li
            key={core}
            className={`rounded-xl panel-inset border px-3 py-2 ${isPinned ? 'border-warning/70' : 'border-neutral-ui/14'}`}
          >
            <div className="flex items-center justify-between text-xs">
              <span className={isPinned ? 'font-bold text-warning' : 'font-semibold text-ink'}>
                Core {core}
                {isPinned && <span className="sr-only"> (pinned core)</span>}
                {isPinned && <span aria-hidden="true"> ★</span>}
              </span>
              <span className="tabular-nums text-ink">{value.toFixed(1)}%</span>
            </div>
            <div
              className="mt-1.5 h-2 rounded-full bg-neutral-ui/15 overflow-hidden"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Number(value.toFixed(1))}
              aria-label={`Core ${core} load`}
            >
              <div
                className={`h-full rounded-full ${isPinned ? 'bg-warning' : 'bg-accent'}`}
                style={{ width: `${value}%`, transition: 'width 300ms ease-out' }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function LaunchResultsPanel({
  connected,
  launches,
  onClear,
}: {
  connected: boolean;
  launches: LaunchRecord[];
  onClear: () => void;
}) {
  const latest = launches[0];
  const [stats, setStats] = useState<LaunchStats | null>(null);
  const [liveCores, setLiveCores] = useState<number[] | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const latestPid = latest?.pid;
  const latestHasNewAgent = latest?.openMs !== undefined;
  const statsRef = useRef<LaunchStats | null>(null);

  // Reset live stats whenever a new launch becomes the latest one.
  useEffect(() => {
    statsRef.current = null;
    setStats(null);
    setStatsError(null);
  }, [latestPid]);

  // Poll real numbers from the agent once a second while connected and visible.
  useEffect(() => {
    if (!connected) {
      setLiveCores(null);
      return;
    }
    let cancelled = false;
    let busy = false;
    const controller = new AbortController();
    const tick = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        if (latestPid && latestHasNewAgent && statsRef.current?.running !== false) {
          const data = await requestAgent<LaunchStats>(
            `/api/launch/stats?pid=${latestPid}`, { signal: controller.signal }, 2000,
          );
          if (cancelled) return;
          statsRef.current = data;
          setStats(data);
          setStatsError(null);
          if (data.cores) setLiveCores(data.cores);
        } else {
          const data = await requestAgent<CoreUsageResponse>('/api/cores', { signal: controller.signal }, 2000);
          if (cancelled) return;
          if (data.cores) setLiveCores(data.cores);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error && err.name !== 'AbortError' && err.name !== 'TypeError'
          ? err.message : null;
        // Older agents have no /api/cores or stats endpoint: say so instead of inventing numbers.
        if (message) setStatsError(message);
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [connected, latestPid, latestHasNewAgent]);

  const downloadCsv = () => {
    const header = ['Time', 'App', 'PID', 'Requested core', 'Actual cores', 'Pinning', 'Opening time (ms)', 'Status'];
    const rows = launches.map((r) => [
      new Date(r.launchedAt ?? r.requestedAt).toLocaleString(),
      r.app ?? '',
      r.pid,
      coreLabel(r.requestedCore),
      (r.affinityCores ?? []).join(' '),
      pinStatus(r).text,
      r.openMs !== undefined ? r.openMs.toFixed(1) : '',
      r.readyState ? STATE_TEXT[r.readyState] : 'Launched',
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'launch_results.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const pinnedCore = latest?.requestedCore ?? -1;
  const actualCores = stats?.running ? stats.affinityCores : latest?.affinityCores;
  const pin = latest ? pinStatus({ ...latest, affinityCores: actualCores ?? latest.affinityCores }) : null;

  return (
    <section className="liquid-glass p-5 sm:p-6" aria-labelledby="launchResultsHeading">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
        <div>
          <h2 id="launchResultsHeading" className="text-[17px] font-bold">Launch Results</h2>
          <p className="text-xs text-muted mt-0.5">
            Measured on your PC by the Windows agent: opening time (<code className="text-info">QueryPerformanceCounter</code> +{' '}
            <code className="text-info">WaitForInputIdle</code>), cores (<code className="text-accent">GetProcessAffinityMask</code>) and per-core load.
          </p>
        </div>
        {launches.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={downloadCsv}
              className="h-9 px-4 rounded-full panel-inset border border-neutral-ui/18 text-xs font-semibold text-ink cursor-pointer spring-btn">
              Download CSV
            </button>
            <button type="button" onClick={onClear}
              className="h-9 px-4 rounded-full panel-inset border border-neutral-ui/18 text-xs font-semibold text-ink cursor-pointer spring-btn">
              Clear history
            </button>
          </div>
        )}
      </div>

      {!latest && (
        <p className="rounded-xl panel-inset border border-neutral-ui/14 px-4 py-6 text-center text-xs text-muted" data-testid="launch-empty">
          {connected
            ? 'No launches yet. Pick a core above and launch an app to see its opening time, cores and load here.'
            : 'Results appear here after you connect the Windows agent and launch an app. Nothing is shown until real numbers arrive.'}
        </p>
      )}

      {latest && (
        <div className="flex flex-col gap-4" data-testid="launch-latest">
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Application', value: `${latest.app ?? 'App'} (PID ${latest.pid})` },
              {
                label: 'Opening time',
                value: formatMs(latest.openMs),
                tone: 'text-accent',
              },
              { label: 'Requested core', value: coreLabel(latest.requestedCore) },
              { label: 'Cores it can run on', value: coresText(actualCores ?? undefined) },
            ].map((item) => (
              <div key={item.label} className="rounded-xl panel-inset border border-neutral-ui/14 px-3 py-2.5 min-w-0">
                <dt className="text-[11px] font-semibold text-muted">{item.label}</dt>
                <dd className={`mt-0.5 text-sm font-bold tabular-nums break-words ${item.tone ?? 'text-ink'}`}>{item.value}</dd>
              </div>
            ))}
          </dl>

          <p className="text-xs" role="status">
            <span className={`font-semibold ${pin?.tone ?? ''}`}>{pin?.text}</span>
            {latest.readyState && <span className="text-muted"> · {STATE_TEXT[latest.readyState]}</span>}
            {latest.readyState === 'exited' && (
              <span className="text-muted"> · Windows opened it in an existing or Store-app process, so live stats are not available.</span>
            )}
          </p>

          {!latestHasNewAgent && (
            <p className="text-xs text-warning" role="status">
              This Windows agent is an older build, so it only reports the PID. Rebuild it with build.bat (or use the new simulator-windows.zip) to get opening time and core results.
            </p>
          )}

          {stats && (
            <dl className="grid grid-cols-2 md:grid-cols-5 gap-3" data-testid="launch-live-stats">
              {[
                { label: 'Status', value: stats.running ? `Running · ${formatUptime(stats.uptimeMs)}` : `Exited (code ${stats.exitCode})` },
                { label: 'Process CPU', value: stats.running ? `${stats.cpuPercent.toFixed(1)}%` : '—' },
                { label: 'CPU time used', value: formatMs(stats.cpuTimeMs) },
                { label: 'Memory', value: stats.running ? `${stats.memoryMB.toFixed(1)} MB (peak ${stats.peakMemoryMB.toFixed(1)})` : '—' },
                { label: 'Threads', value: stats.running ? String(stats.threads) : '—' },
              ].map((item) => (
                <div key={item.label} className="rounded-xl panel-inset border border-neutral-ui/14 px-3 py-2.5 min-w-0">
                  <dt className="text-[11px] font-semibold text-muted">{item.label}</dt>
                  <dd className="mt-0.5 text-sm font-bold tabular-nums text-ink break-words">{item.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {latest.coresDuring && (
            <div>
              <h3 className="text-sm font-bold mb-2">Core load while it was opening</h3>
              <CoreBars usage={latest.coresDuring} pinned={pinnedCore} label="Per-core load during launch" />
            </div>
          )}
        </div>
      )}

      {connected && liveCores && (
        <div className="mt-4">
          <h3 className="text-sm font-bold mb-2">
            Live core load <span className="text-xs font-normal text-muted">(updates every second{pinnedCore >= 0 ? `, ★ = Core ${pinnedCore}` : ''})</span>
          </h3>
          <CoreBars usage={liveCores} pinned={pinnedCore} label="Live per-core load" />
        </div>
      )}

      {statsError && (
        <p className="mt-3 text-xs text-warning" role="status">Live results unavailable: {statsError}</p>
      )}

      {launches.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-bold mb-2">This session's launches ({launches.length})</h3>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Launch history table">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-left text-xs text-muted border-b border-neutral-ui/14">
                  <th scope="col" className="py-2 pr-4">Time</th>
                  <th scope="col" className="py-2 px-4">App</th>
                  <th scope="col" className="py-2 px-4">PID</th>
                  <th scope="col" className="py-2 px-4">Core</th>
                  <th scope="col" className="py-2 px-4">Opening time</th>
                  <th scope="col" className="py-2 pl-4">Result</th>
                </tr>
              </thead>
              <tbody>
                {launches.map((r) => {
                  const p = pinStatus(r);
                  return (
                    <tr key={`${r.pid}-${r.requestedAt}`} className="border-b border-neutral-ui/6">
                      <td className="py-2 pr-4 text-muted whitespace-nowrap">{new Date(r.launchedAt ?? r.requestedAt).toLocaleTimeString()}</td>
                      <td className="py-2 px-4 font-semibold whitespace-nowrap">{r.app ?? 'App'}</td>
                      <td className="py-2 px-4">{r.pid}</td>
                      <td className="py-2 px-4 whitespace-nowrap">{coreLabel(r.requestedCore)}</td>
                      <td className="py-2 px-4 whitespace-nowrap">{formatMs(r.openMs)}</td>
                      <td className={`py-2 pl-4 text-xs whitespace-nowrap ${p.tone}`}>
                        {r.readyState ? `${STATE_TEXT[r.readyState]} · ` : ''}{p.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
