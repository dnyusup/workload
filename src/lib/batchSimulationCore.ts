import type { AppConfig, SimulationState } from '../types';
import { SimulationEngine } from './simulationEngine';
import { previewAssignedMachineIds, recommendedMachineCountForForecast } from './singleOperatorUtilization';
import { randomSeed } from './rng';

export type BatchSimulationResult =
  | { ok: true; config: AppConfig; state: SimulationState }
  | { ok: false; error: string };

/** One Batch Simulation item's compute part: Optimize Man Occupation on the given setup, then one
 * full shift of the Work Load Simulator. Pure (no Dataverse), so it can run in a Web Worker. */
export function optimizeAndSimulate(input: AppConfig): BatchSimulationResult {
  const machineCount = recommendedMachineCountForForecast(input);
  if (machineCount <= 0) {
    return { ok: false, error: 'Optimize found no machine count — the operator has no work (check the activities and their Num/Dem).' };
  }
  if (machineCount > input.layout.length) {
    return {
      ok: false,
      error: `Optimize needs ${machineCount} machines but the default layout has only ${input.layout.length}.`,
    };
  }
  const config: AppConfig = {
    ...input,
    operator: { ...input.operator, machHandled: machineCount },
    assignedMachineIds: previewAssignedMachineIds(input, machineCount),
    seed: randomSeed(),
  };
  const engine = new SimulationEngine(config);
  const shift = Math.max(0, config.operator.shiftTime);
  for (let minute = 0; minute < shift; minute += 1) engine.tick(1);
  return { ok: true, config, state: engine.getState() };
}
