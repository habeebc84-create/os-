import { memo } from 'react';
import type { GanttSegment, SimResult } from '../lib/schedulerEngine';

interface Props {
  result: SimResult;
  colors: string[];
  colorIndex: Record<string, number>;
}

export const GanttTracks = memo(function GanttTracks({ result, colors, colorIndex }: Props) {
  const makespan = result.metrics.makespan;
  const rows: GanttSegment[][] = Array.from({ length: result.cores }, () => []);
  result.gantt.forEach((segment) => rows[segment.core]?.push(segment));
  const step = makespan <= 20 ? 1 : Math.ceil(makespan / 15);
  const marks: number[] = [];
  for (let tick = 0; tick < makespan; tick += step) marks.push(tick);
  marks.push(makespan);

  return (
    <>
      {rows.map((segments, core) => {
        // Dense Round Robin schedules can have thousands of slices. Batch same-color slices.
        const dense = segments.length > 160;
        const paths = new Map<string, string[]>();
        if (dense) {
          for (const segment of segments) {
            const color = segment.idle ? 'var(--timeline-idle)' : colors[colorIndex[segment.pid] ?? 0];
            const commands = paths.get(color) ?? [];
            commands.push(`M${segment.start} 0H${segment.end}V1H${segment.start}Z`);
            paths.set(color, commands);
          }
        }

        return (
          <div key={core} className="grid grid-cols-[76px_1fr] items-center gap-3 mb-2.5">
            <div className="text-xs font-bold text-muted text-right">CORE {core}</div>
            <div className="relative h-11 rounded-xl bg-neutral-ui/5 border border-neutral-ui/10 overflow-hidden">
              {dense ? (
                <svg className="absolute inset-x-0 top-1 h-[calc(100%-8px)] w-full"
                  viewBox={`0 0 ${makespan} 1`} preserveAspectRatio="none"
                  role="img" aria-label={`Core ${core} timeline, ${segments.length} segments`}>
                  {Array.from(paths, ([color, commands]) => (
                    <path key={color} fill={color} d={commands.join(' ')} />
                  ))}
                </svg>
              ) : segments.map((segment) => (
                <div
                  key={segment.start}
                  title={`Core ${core} · ${segment.pid} · [${segment.start} → ${segment.end}] (${segment.end - segment.start} ticks)`}
                  className={`absolute top-1 bottom-1 rounded-md flex items-center justify-center text-xs font-bold overflow-hidden whitespace-nowrap ${segment.idle ? 'gantt-idle-stripe text-muted' : 'timeline-label'}`}
                  style={{
                    left: `${(segment.start / makespan) * 100}%`,
                    width: `${((segment.end - segment.start) / makespan) * 100}%`,
                    backgroundColor: segment.idle ? undefined : colors[colorIndex[segment.pid] ?? 0],
                  }}
                >
                  {(segment.end - segment.start) / makespan > 0.035 && segment.pid}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <div className="ml-[88px] relative h-5 text-[11px] text-muted tabular-nums">
        {marks.map((tick) => (
          <span key={tick} className="absolute -translate-x-1/2" style={{ left: `${(tick / makespan) * 100}%` }}>
            {tick}
          </span>
        ))}
      </div>
    </>
  );
});
