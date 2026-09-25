import type { ActivityConfig, MachineSpecDerived, MachineSpecInput } from '../types';

/** Areas whose Linear Speed = Speed directly (no twisting formula) — Twist/min doesn't apply here. */
const LINEAR_SPEED_FROM_SPEED_AREAS = ['WW', 'CH', 'CR', 'BA', 'CA', 'IS', 'IP'];
/** Areas whose Twist/min = Speed (not Speed*2); Linear Speed still uses the LayLength/1000*Twist/min formula. */
const TWIST_EQUALS_SPEED_AREAS = ['SP', 'CB'];

export function deriveMachineSpec(spec: MachineSpecInput): MachineSpecDerived {
  const spoolWeight = (spec.spoolLength * spec.linearDensity * spec.noOfWires) / 1000;

  let twistPerMin: number;
  let linearSpeed: number;
  if (LINEAR_SPEED_FROM_SPEED_AREAS.includes(spec.area)) {
    twistPerMin = 0;
    linearSpeed = spec.speed;
  } else if (TWIST_EQUALS_SPEED_AREAS.includes(spec.area)) {
    twistPerMin = spec.speed;
    linearSpeed = (spec.layLength / 1000) * twistPerMin;
  } else {
    twistPerMin = spec.speed * 2;
    linearSpeed = (spec.layLength / 1000) * twistPerMin;
  }

  const runtimePerSpool = linearSpeed > 0 ? spec.spoolLength / linearSpeed + 0.65 : 0;

  return { twistPerMin, spoolWeight, linearSpeed, runtimePerSpool };
}

export function fractureRepairingDenominator(spoolWeight: number): number {
  if (!spoolWeight) return 0;
  return 1000 / spoolWeight;
}

export function defaultActivities(spoolWeight: number, fracturePerTon: number): ActivityConfig[] {
  return [
    {
      key: 'doffing',
      label: 'Doffing',
      timeMinutes: 1.5,
      numerator: 1,
      numeratorAuto: false,
      denominator: 1,
      denominatorAuto: false,
      machCondition: 'stop',
    },
    {
      key: 'loading',
      label: 'Loading',
      timeMinutes: 6,
      numerator: 1,
      numeratorAuto: false,
      denominator: 4,
      denominatorAuto: false,
      machCondition: 'stop',
    },
    {
      key: 'fractureRepairing',
      label: 'Fracture Repairing',
      timeMinutes: 10,
      numerator: fracturePerTon,
      numeratorAuto: true,
      denominator: fractureRepairingDenominator(spoolWeight),
      denominatorAuto: true,
      machCondition: 'stop',
    },
  ];
}

/** Doffing/Loading/Fracture Repairing must always exist for the sim to work — appends the default
 * version of any of the three that's missing from a given activity list (e.g. a Construction's
 * WL_Activities rows didn't define one, or a saved config predates this rule being enforced). */
export function ensureCoreActivities(
  activities: ActivityConfig[],
  spoolWeight: number,
  fracturePerTon: number,
): ActivityConfig[] {
  const existingKeys = new Set(activities.map((a) => a.key));
  const missingCore = defaultActivities(spoolWeight, fracturePerTon).filter((a) => !existingKeys.has(a.key));
  return [...activities, ...missingCore];
}

export function syncAutoActivityValues(
  activities: ActivityConfig[],
  spec: MachineSpecInput,
): ActivityConfig[] {
  const derived = deriveMachineSpec(spec);
  return activities.map((activity) => ({
    ...activity,
    numerator:
      activity.key === 'diesChange'
        ? spec.diesPerTon
        : activity.key === 'defectRepairing'
          ? spec.defectsPerTon
          : activity.numeratorAuto
            ? spec.fracturePerTon
            : activity.numerator,
    denominator: activity.denominatorAuto
      ? fractureRepairingDenominator(derived.spoolWeight)
      : activity.denominator,
  }));
}

/** Cycle length in "spools completed" between occurrences of this activity. */
export function activityCycleLength(activity: ActivityConfig): number {
  if (activity.numerator <= 0 || activity.denominator <= 0) return Infinity;
  const cycle = activity.denominator / activity.numerator;
  return cycle > 0 ? cycle : Infinity;
}

export function distanceMeters(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  pixelsPerMeter: number,
): number {
  const dxPx = ax - bx;
  const dyPx = ay - by;
  const distPx = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
  return pixelsPerMeter > 0 ? distPx / pixelsPerMeter : distPx;
}

export function availableTimeMinutes(shiftTime: number, lunchTime: number, meetingTime: number, extraBreakMinutes = 0): number {
  return Math.max(0, shiftTime - lunchTime - meetingTime - extraBreakMinutes);
}

/** Total minutes of the setup's extra ("Other") operator breaks. */
export function extraBreakMinutes(extraBreaks: { time: number }[] | undefined): number {
  return (extraBreaks ?? []).reduce((sum, b) => sum + Math.max(0, b.time || 0), 0);
}
