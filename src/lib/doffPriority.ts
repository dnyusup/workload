import type { ActivityKey, MachineZone, OperatorRuntimeState, PendingTask, ServiceSegment, SuspendedVisit } from '../types';
import { distanceMeters } from './calculations';
import { ZONE_LABEL } from './machineZones';

export function isDoffingActivity(activity: ActivityKey): boolean {
  return activity === 'doffing' || activity.startsWith('doffing-');
}

/** Minutes the operator still needs to finish the visit they're on: what's left of the current
 * zone move and dwell, then every remaining zone (walking between them included). */
export function remainingVisitMinutes(operator: OperatorRuntimeState, pixelsPerMeter: number, walkingSpeed: number): number {
  const speed = walkingSpeed > 0 ? walkingSpeed : 1;
  let total = operator.zoneDwellRemainingMin;
  let fromX = operator.x;
  let fromY = operator.y;
  if (operator.serviceSubPhase === 'moving') {
    total += (1 - operator.zoneMoveProgress) * operator.zoneMoveDurationMin;
    fromX = operator.zoneMoveToX;
    fromY = operator.zoneMoveToY;
  }
  for (const segment of operator.serviceSegments) {
    total += distanceMeters(fromX, fromY, segment.x, segment.y, pixelsPerMeter) / speed + segment.dwellMin;
    fromX = segment.x;
    fromY = segment.y;
  }
  return total;
}

function zoneFromLabel(label: string): MachineZone {
  const suffix = label.split(' — ')[1];
  return (Object.keys(ZONE_LABEL) as MachineZone[]).find((zone) => ZONE_LABEL[zone] === suffix) ?? 'takeup';
}

/** The operator's visit from this moment on, as a resumable SuspendedVisit. */
export function snapshotVisit(operator: OperatorRuntimeState): SuspendedVisit {
  const moving = operator.serviceSubPhase === 'moving';
  const label = operator.currentZoneLabel ?? '';
  const current: ServiceSegment = {
    zone: zoneFromLabel(label),
    label,
    dwellMin: operator.zoneDwellRemainingMin,
    x: moving ? operator.zoneMoveToX : operator.x,
    y: moving ? operator.zoneMoveToY : operator.y,
  };
  return {
    tasks: operator.serviceTasks.map((task) => ({ ...task })),
    segments: [current, ...operator.serviceSegments.map((segment) => ({ ...segment }))],
  };
}

/** The task a suspended visit resumes with — for the machine timeline's "Waiting …" label. */
export function nextTaskOf(visit: SuspendedVisit): PendingTask | undefined {
  const label = visit.segments[0]?.label.split(' — ')[0];
  return visit.tasks.find((task) => task.label === label) ?? visit.tasks[0];
}
