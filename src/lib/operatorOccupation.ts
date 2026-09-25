import type { ProductionSimulationState } from '../types';

const NON_SERVICE_KINDS = new Set(['walking', 'lunch', 'meeting', 'idle']);

/** Same detail level as the single-operator Simulator's Man Occupation card (Man Occupation %,
 * Walking, Total service, per-activity service breakdown, Idle) — derived straight from the
 * timeline segments of whichever operator(s) are passed in, so the same function covers both the
 * "all operators combined" default view and a single filtered operator. */
export function summarizeOperatorTimelines(
  ops: ProductionSimulationState['operators'],
  timelineDuration: number,
  activityLabel: (key: string) => string,
) {
  const segments = ops.flatMap((op) => op.timeline);
  const minutesWhere = (pred: (kind: string) => boolean) =>
    segments
      .filter((s) => pred(s.kind))
      .reduce((total, s) => total + Math.max(0, Math.min(s.endMin, timelineDuration) - s.startMin), 0);

  const walking = minutesWhere((k) => k === 'walking');
  const breakMin = minutesWhere((k) => k === 'lunch' || k === 'meeting');
  const idle = minutesWhere((k) => k === 'idle');

  const serviceLabelTotals = new Map<string, number>();
  segments
    .filter((s) => !NON_SERVICE_KINDS.has(s.kind))
    .forEach((s) => {
      const label = activityLabel(s.kind);
      const minutes = Math.max(0, Math.min(s.endMin, timelineDuration) - s.startMin);
      serviceLabelTotals.set(label, (serviceLabelTotals.get(label) ?? 0) + minutes);
    });
  const serviceBreakdown = Array.from(serviceLabelTotals.entries()).map(([label, minutes]) => ({ label, minutes }));
  const totalService = serviceBreakdown.reduce((total, s) => total + s.minutes, 0);

  const elapsed = timelineDuration * ops.length - breakMin;
  const busy = walking + totalService;
  const utilization = elapsed > 0 ? (busy / elapsed) * 100 : 0;

  return { walking, totalService, serviceBreakdown, idle, elapsed, utilization };
}
