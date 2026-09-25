import type { ActivityKey, ProductionSetup } from '../types';
import type { ResolvedConstruction } from './productionConstructionResolver';
import { deriveMachineSpec } from './calculations';

const AVERAGE_DIES_PER_CHANGE_EVENT = (7 + 26) / 2;

// Same helpers as SimulationEngine, so the two estimates can't drift apart.
function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right > 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function leastCommonMultiple(a: number, b: number): number {
  const divisor = greatestCommonDivisor(a, b);
  return divisor > 0 ? (a / divisor) * b : 0;
}

/** Theoretical number of each activity over a full shift for a Production Setup — the same
 * estimate the Workload Simulator shows next to Completed Activities (see
 * SimulationEngine.expectedEvents), applied per Construction (each has its own runtime, cycles and
 * activity times) and summed across the machines assigned to it:
 *   - spools per machine = shift ÷ (runtime/spool + average stop time per spool from Stop tasks)
 *   - events = spools × (1 / cycle), minus — for Loading's Partial subs only — the spools where
 *     full Loading is due instead
 *   - Dies Change = ceil(planned dies ÷ average dies per change event).
 * Keys are the raw activity keys (sub-activity keys differ per Construction). */
export function estimateProductionEvents(
  setup: ProductionSetup,
  resolved: Map<string, ResolvedConstruction>,
): Record<ActivityKey, number> {
  const machineCountByConstruction = new Map<string, number>();
  setup.assignments.forEach((a) => {
    if (a.constructionDetailId) {
      machineCountByConstruction.set(a.constructionDetailId, (machineCountByConstruction.get(a.constructionDetailId) ?? 0) + 1);
    }
  });

  const totals: Record<ActivityKey, number> = {};
  machineCountByConstruction.forEach((machineCount, constructionId) => {
    const construction = resolved.get(constructionId);
    if (!construction) return;
    const { activities, cycleLengths, runtimePerSpool } = construction;

    const eventsPerSpool = (key: ActivityKey): number => {
      const cycle = cycleLengths[key];
      if (!Number.isFinite(cycle) || cycle <= 0) return 0;
      let rate = 1 / cycle;
      const activity = activities.find((item) => item.key === key);
      // Only Loading's subs (Partial1/2) stand in for their parent at a shared spool boundary; the
      // engine runs every other sub (e.g. Doffing ScanMES) each time it's due, after the parent
      // (see queueTasksForMachine's altersWithParent), so only those overlaps are subtracted.
      if (activity?.parentKey === 'loading') {
        const parentCycle = cycleLengths[activity.parentKey];
        if (Number.isFinite(parentCycle) && parentCycle > 0) {
          const overlapCycle = leastCommonMultiple(cycle, parentCycle);
          if (overlapCycle > 0) rate -= 1 / overlapCycle;
        }
      }
      return Math.max(0, rate);
    };

    const stopMinPerSpool = activities
      .filter((activity) => activity.key !== 'diesChange' && activity.machCondition === 'stop')
      .reduce((sum, activity) => sum + eventsPerSpool(activity.key) * activity.timeMinutes, 0);
    const minutesPerSpool = runtimePerSpool + stopMinPerSpool;
    const spoolsPerMachine = minutesPerSpool > 0 ? setup.shiftTime / minutesPerSpool : 0;
    const totalSpools = spoolsPerMachine * machineCount;

    activities.forEach((activity) => {
      let expected: number;
      if (activity.key === 'diesChange') {
        // Same planned-dies basis the engine schedules Dies Change from.
        const spoolWeight = deriveMachineSpec(construction.spec).spoolWeight;
        const plannedDies =
          activity.numerator > 0
            ? (machineCount * (setup.shiftTime / Math.max(1, runtimePerSpool)) * spoolWeight * activity.numerator) / 1000
            : 0;
        expected = plannedDies > 0 ? Math.ceil(plannedDies / AVERAGE_DIES_PER_CHANGE_EVENT) : 0;
      } else {
        expected = totalSpools * eventsPerSpool(activity.key);
      }
      totals[activity.key] = (totals[activity.key] ?? 0) + expected;
    });
  });

  // Round once at the end (per-Construction rounding would drift with many small groups).
  Object.keys(totals).forEach((key) => {
    totals[key] = Math.max(0, Math.round(totals[key]));
  });
  return totals;
}
