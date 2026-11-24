import { compareAllAlgorithms, runMultiCoreSimulation } from './schedulerEngine';
import type { CompareResponse, SimResult } from './schedulerEngine';
import type { SchedulerJob } from './schedulerWorker';

export function runSchedulerJob(job: Extract<SchedulerJob, { kind: 'simulate' }>): Promise<SimResult>;
export function runSchedulerJob(job: Extract<SchedulerJob, { kind: 'compare' }>): Promise<CompareResponse>;
export async function runSchedulerJob(job: SchedulerJob): Promise<SimResult | CompareResponse> {
  if (typeof Worker === 'undefined') {
    return job.kind === 'simulate'
      ? runMultiCoreSimulation(...job.args)
      : compareAllAlgorithms(...job.args, false);
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./schedulerWorker.ts', import.meta.url), { type: 'module' });
    const timeout = window.setTimeout(fail, 15000);

    function cleanup() {
      window.clearTimeout(timeout);
      worker.terminate();
    }

    function fail() {
      cleanup();
      reject(new Error('The scheduler could not finish. Please try again.'));
    }

    worker.onmessage = (event: MessageEvent<SimResult | CompareResponse>) => {
      cleanup();
      resolve(event.data);
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    try {
      worker.postMessage(job);
    } catch {
      fail();
    }
  });
}
