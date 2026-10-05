import type { ActivityKey, ProductionSetup } from '../types';
import type { ResolvedConstruction } from './productionConstructionResolver';
import { calculatePlannedUtilization } from './productionUtilization';

/** Forecast number of each activity over a full shift for a Production Setup — the same estimate
 * the Work Load Simulator shows next to Completed Activities: each machine's forecast events (its
 * own Construction's cycles, Loading partials as the simulation does them) at that machine's
 * forecast OEE, i.e. after its Stop activities and waiting for its operator(s). FirstDoffOnShift
 * subs happen once per machine regardless. Keys are the raw activity keys (sub-activity keys
 * differ per Construction). */
export function estimateProductionEvents(
  setup: ProductionSetup,
  resolved: Map<string, ResolvedConstruction>,
): Record<ActivityKey, number> {
  const firstDoffKeys = new Set<ActivityKey>();
  resolved.forEach((construction) => {
    construction.activities.forEach((activity) => {
      if (activity.frequencyType === 'FirstDoffOnShift') firstDoffKeys.add(activity.key);
    });
  });

  const totals: Record<ActivityKey, number> = {};
  calculatePlannedUtilization(setup, resolved).machines.forEach((machine) => {
    machine.contributions.forEach((contribution) => {
      const events = firstDoffKeys.has(contribution.activityKey)
        ? contribution.expectedOccurrences
        : contribution.expectedOccurrences * machine.oee;
      totals[contribution.activityKey] = (totals[contribution.activityKey] ?? 0) + events;
    });
  });

  // Round once at the end (per-machine rounding would drift with many machines).
  Object.keys(totals).forEach((key) => {
    totals[key] = Math.max(0, Math.round(totals[key]));
  });
  return totals;
}
