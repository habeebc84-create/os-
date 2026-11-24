import { compareAllAlgorithms, runMultiCoreSimulation } from './schedulerEngine';

type SimulationArgs = Parameters<typeof runMultiCoreSimulation>;
type ComparisonArgs = Parameters<typeof compareAllAlgorithms>;
type WorkloadArgs = [ComparisonArgs[0], ComparisonArgs[1], ComparisonArgs[2], ComparisonArgs[3]];

export type SchedulerJob =
  | { kind: 'simulate'; args: [SimulationArgs[0], SimulationArgs[1], SimulationArgs[2], SimulationArgs[3], SimulationArgs[4]] }
  | { kind: 'compare'; args: WorkloadArgs };

self.addEventListener('message', (event: MessageEvent<SchedulerJob>) => {
  const job = event.data;
  const result = job.kind === 'simulate'
    ? runMultiCoreSimulation(...job.args)
    : compareAllAlgorithms(...job.args, false);
  self.postMessage(result);
});
