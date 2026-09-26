import type { ActivityKey, MachineOrientation, MachinePairSide, MachineZone, PendingTask, ServiceSegment, MachineAxis } from '../types';
import { MACHINE_H, MACHINE_W } from './layoutConstants';
import { distanceMeters } from './calculations';

const ZONE_Y_FRAC: Record<MachineOrientation, Record<MachineZone, number>> = {
  normal: { payoff: 0.1, cradle: 0.5, takeup: 0.9 },
  flipped: { payoff: 0.9, cradle: 0.5, takeup: 0.1 },
};

export const ZONE_LABEL: Record<MachineZone, string> = {
  payoff: 'Pay Off',
  cradle: 'Cradle',
  takeup: 'Take Up',
};

/** centerX/centerY are the machine's center point (as stored on runtime machine state).
 * Cradle sits toward the machine's outer edge (the side that actually has cradle access).
 * `boxWidthPx`/`boxHeightPx` default to the standard machine footprint but should be passed the
 * machine's own (possibly resized) footprint so zone points line up with its actual drawn box. */
export function zonePosition(
  centerX: number,
  centerY: number,
  orientation: MachineOrientation,
  zone: MachineZone,
  pairSide: MachinePairSide = 'single',
  boxWidthPx: number = MACHINE_W,
  boxHeightPx: number = MACHINE_H,
  axis: MachineAxis = 'vertical',
) {
  // Work in the machine's own (vertical) frame, then rotate for a horizontal machine — the same
  // −90° rotation machineLocalFrame applies when drawing it: local (dx, dy) → (dy, −dx).
  const horizontal = axis === 'horizontal';
  const localW = horizontal ? boxHeightPx : boxWidthPx;
  const localH = horizontal ? boxWidthPx : boxHeightPx;
  const frac = ZONE_Y_FRAC[orientation][zone];
  const outsideOffset = 10;
  let dx: number;
  let dy = -localH / 2 + frac * localH;
  if (zone === 'payoff' || zone === 'takeup') {
    const direction = zone === 'takeup' ? (orientation === 'flipped' ? -1 : 1) : orientation === 'flipped' ? 1 : -1;
    dx = 0;
    dy += direction * outsideOffset;
  } else {
    const direction = pairSide === 'left' ? -1 : 1;
    dx = direction * (localW / 2 + outsideOffset);
  }
  return horizontal ? { x: centerX + dy, y: centerY - dx } : { x: centerX + dx, y: centerY + dy };
}

interface RawSegment {
  zone: MachineZone;
  duration: number;
}

/** Splits one activity's total time into the zones the operator stands in, per plant convention. */
function activityZoneSchedule(activity: ActivityKey, totalTime: number, loadingPayoffOnly = false, defectTakeupOnly = false): RawSegment[] {
  let raw: RawSegment[];
  if (activity === 'doffing' || activity.startsWith('doffing-')) {
    raw = [{ zone: 'takeup', duration: totalTime }];
  } else if (activity === 'loading' || activity.startsWith('loading-')) {
    if (loadingPayoffOnly) return [{ zone: 'payoff', duration: totalTime }];
    const payoff = totalTime * 0.3;
    const takeup = 2;
    const cradle = totalTime - payoff - takeup;
    raw = [
      { zone: 'payoff', duration: payoff },
      { zone: 'cradle', duration: cradle },
      { zone: 'takeup', duration: takeup },
    ];
  } else if (defectTakeupOnly) {
    raw = [{ zone: 'takeup', duration: totalTime }];
  } else {
    const takeup = 3;
    const cradle = totalTime - takeup;
    raw = [
      { zone: 'cradle', duration: cradle },
      { zone: 'takeup', duration: takeup },
    ];
  }

  // Normalize so segments always sum to exactly totalTime, even for small/edge-case durations.
  const sum = raw.reduce((s, r) => s + Math.max(0, r.duration), 0);
  if (sum <= 0) return [{ zone: raw[raw.length - 1].zone, duration: totalTime }];
  const scale = totalTime / sum;
  return raw
    .map((r) => ({ zone: r.zone, duration: Math.max(0, r.duration) * scale }))
    .filter((r) => r.duration > 1e-6);
}

export function buildServiceSegments(
  tasks: PendingTask[],
  centerX: number,
  centerY: number,
  orientation: MachineOrientation,
  pairSide: MachinePairSide = 'single',
  walkingSpeed = 60,
  pixelsPerMeter = 20,
  boxWidthPx: number = MACHINE_W,
  boxHeightPx: number = MACHINE_H,
  axis: MachineAxis = 'vertical',
): ServiceSegment[] {
  const segments: ServiceSegment[] = [];
  for (const task of tasks) {
    const raw = activityZoneSchedule(task.activity, task.timeMinutes, task.loadingPayoffOnly, task.defectTakeupOnly);
    const positioned = raw.map((seg) => ({
      ...seg,
      pos: zonePosition(centerX, centerY, orientation, seg.zone, pairSide, boxWidthPx, boxHeightPx, axis),
    }));
    const includesInternalMovement =
      (task.activity === 'loading' && !task.loadingPayoffOnly) ||
      task.activity.startsWith('loading-') ||
      task.activity === 'fractureRepairing' ||
      task.activity.startsWith('fractureRepairing-') ||
      (task.activity === 'defectRepairing' && !task.defectTakeupOnly);
    const speed = includesInternalMovement && walkingSpeed > 0 ? walkingSpeed : 0;
    const movementMin = speed > 0
      ? positioned.slice(1).reduce(
          (total, segment, index) =>
            total +
            distanceMeters(
              positioned[index].pos.x,
              positioned[index].pos.y,
              segment.pos.x,
              segment.pos.y,
              pixelsPerMeter,
            ) / speed,
          0,
        )
      : 0;
    const dwellBudget = includesInternalMovement ? Math.max(0, task.timeMinutes - movementMin) : task.timeMinutes;
    const rawTotal = raw.reduce((total, segment) => total + segment.duration, 0) || 1;
    for (const segment of positioned) {
      segments.push({
        zone: segment.zone,
        label: `${task.label} — ${ZONE_LABEL[segment.zone]}`,
        dwellMin: (segment.duration / rawTotal) * dwellBudget,
        x: segment.pos.x,
        y: segment.pos.y,
      });
    }
  }
  return segments;
}
