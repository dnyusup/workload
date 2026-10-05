import type { ActivityKey, ProductionSetup } from '../types';
import { deriveMachineSpec } from './calculations';
import { activityFamily } from './productionActivityRouting';
import type { ResolvedConstruction } from './productionConstructionResolver';
import { calculatePlannedUtilization, type PlannedUtilization } from './productionUtilization';
import { isFinishProductSpoolType } from './productType';

/** One operator's forecast man occupation for the full shift, in the run's own terms. */
export interface ProductionOperatorForecast {
  availableMinutes: number;
  walkingMinutes: number;
  /** Handling including the RPC allowance. */
  serviceMinutes: number;
  /** Handling per activity key, without RPC. */
  serviceByActivity: Record<ActivityKey, number>;
  rpcMinutes: number;
  idleMinutes: number;
}

/**
 * The Production Setup's forecast for one full shift, in the same terms as the run's dashboard
 * cards so each can show its forecast next to the actual. Worked out per machine with its own
 * Construction (runtime per spool, spool weight, activities, SpoolType) at that machine's forecast
 * OEE — after its Stop activities and waiting for its operator(s) — then summed, so any mix of
 * Constructions adds up correctly:
 *   running = shift × OEE · spools = running ÷ runtime · Stop downtime = events × time ·
 *   waiting = shift × (1 − OEE ÷ availability).
 */
export interface ProductionForecastSummary {
  plannedMachineMinutes: number;
  runningMinutes: number;
  spools: number;
  grossTonKg: number;
  fpGrossTonKg: number;
  /** Stop-activity downtime per activity key (activity time, no RPC). */
  downtimeByActivity: Record<ActivityKey, number>;
  waitingMinutes: number;
  /** Forecast occurrences per activity key (FirstDoffOnShift once per machine). */
  eventsByActivity: Record<ActivityKey, number>;
  fractureEvents: number;
  defectEvents: number;
  /** Dies changed (not change events), like the run's diesChanged. */
  diesChanged: number;
  operators: Map<string, ProductionOperatorForecast>;
}

export function summarizeProductionForecast(
  setup: ProductionSetup,
  resolved: Map<string, ResolvedConstruction>,
  planned: PlannedUtilization = calculatePlannedUtilization(setup, resolved),
): ProductionForecastSummary {
  const shift = Math.max(0, setup.shiftTime);
  const assignmentByMachine = new Map(setup.assignments.map((a) => [a.machineId, a]));
  const summary: ProductionForecastSummary = {
    plannedMachineMinutes: 0,
    runningMinutes: 0,
    spools: 0,
    grossTonKg: 0,
    fpGrossTonKg: 0,
    downtimeByActivity: {},
    waitingMinutes: 0,
    eventsByActivity: {},
    fractureEvents: 0,
    defectEvents: 0,
    diesChanged: 0,
    operators: new Map(),
  };
  const add = (record: Record<ActivityKey, number>, key: ActivityKey, value: number) => {
    record[key] = (record[key] ?? 0) + value;
  };

  planned.machines.forEach((machine) => {
    const constructionId = assignmentByMachine.get(machine.machineId)?.constructionDetailId;
    const construction = constructionId ? resolved.get(constructionId) : undefined;
    if (!construction) return;
    const activityByKey = new Map(construction.activities.map((activity) => [activity.key, activity]));
    const runtime = construction.runtimePerSpool > 0 ? construction.runtimePerSpool : 0;
    const running = shift * machine.oee;
    const spools = runtime > 0 ? running / runtime : 0;
    const tonKg = spools * Math.max(0, deriveMachineSpec(construction.spec).spoolWeight);
    summary.plannedMachineMinutes += shift;
    summary.runningMinutes += running;
    summary.spools += spools;
    summary.grossTonKg += tonKg;
    if (isFinishProductSpoolType(construction.spoolType)) summary.fpGrossTonKg += tonKg;
    const runningShare = machine.availability > 0 ? machine.oee / machine.availability : 1;
    summary.waitingMinutes += shift * Math.max(0, 1 - runningShare);

    machine.contributions.forEach((contribution) => {
      const activity = activityByKey.get(contribution.activityKey);
      const firstDoff = activity?.frequencyType === 'FirstDoffOnShift';
      const events = firstDoff ? contribution.expectedOccurrences : contribution.expectedOccurrences * machine.oee;
      add(summary.eventsByActivity, contribution.activityKey, events);
      const family = activityFamily(contribution.activityKey);
      if (family === 'fractureRepairing') summary.fractureEvents += events;
      if (family === 'defectRepairing') summary.defectEvents += events;
      const quantity = contribution.expectedQuantity !== undefined ? contribution.expectedQuantity * machine.oee : undefined;
      if (family === 'diesChange') summary.diesChanged += quantity ?? events;
      if (activity && (activity.machCondition ?? 'stop') !== 'run') {
        // The machine is stopped for the activity's own time; the RPC allowance isn't downtime.
        add(summary.downtimeByActivity, contribution.activityKey, (quantity ?? events) * Math.max(0, activity.timeMinutes));
      }
    });
  });

  const rpcFactor = 1 + Math.max(0, setup.rpc ?? 0) / 100;
  const availabilityByMachine = new Map(planned.machines.map((machine) => [machine.machineId, machine.availability]));
  planned.operators.forEach((operator) => {
    const serviceByActivity: Record<ActivityKey, number> = {};
    let rpcMinutes = 0;
    operator.contributions.forEach((contribution) => {
      // Ideal minutes at the machine's availability and the operator's running share, like its total handling.
      const withRpc = contribution.plannedMinutes * (availabilityByMachine.get(contribution.machineId) ?? 1) * operator.runningShare;
      const base = withRpc / rpcFactor;
      add(serviceByActivity, contribution.activityKey, base);
      rpcMinutes += withRpc - base;
    });
    summary.operators.set(operator.operatorId, {
      availableMinutes: operator.availableMinutes,
      walkingMinutes: operator.forecastWalkingMinutes,
      serviceMinutes: operator.forecastServiceMinutes,
      serviceByActivity,
      rpcMinutes,
      idleMinutes: Math.max(0, operator.availableMinutes - operator.forecastServiceMinutes - operator.forecastWalkingMinutes),
    });
  });
  return summary;
}
