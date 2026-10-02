import type { ActivityConfig, ActivityKey, FrequencyType } from '../types';
import { FREQUENCY_TYPES } from '../types';
import { activityCycleLength } from './calculations';

/** Events a Doffing sub-activity's FrequencyType can wait for. */
export type TriggerEvent = 'loading' | 'loadingPartial' | 'fractureRepairing' | 'defectRepairing' | 'diesChange';

const TRIGGERS_BY_TYPE: Record<FrequencyType, TriggerEvent[]> = {
  FirstDoffAfterLoading: ['loading', 'loadingPartial'],
  FirstDoffAfterLoadingAll: ['loading'],
  FirstDoffAfterLoadingPartial: ['loadingPartial'],
  FirstDoffAfterFractureRepairing: ['fractureRepairing'],
  FirstDoffAfterDefectRepairing: ['defectRepairing'],
  FirstDoffAfterDiesChange: ['diesChange'],
  FirstDoffAfterInteruptions: ['loading', 'loadingPartial', 'fractureRepairing', 'defectRepairing', 'diesChange'],
  // Not event-driven: the machine's first Doffing of the shift (see frequencyTypeIsDue).
  FirstDoffOnShift: [],
};

const AVERAGE_DIES_PER_CHANGE_EVENT = (7 + 26) / 2;

export function parseFrequencyType(value: string | undefined | null): FrequencyType | undefined {
  const trimmed = value?.trim();
  return FREQUENCY_TYPES.find((type) => type === trimmed);
}

/** Which trigger event a just-completed task counts as, if any (Doffing never triggers). */
export function triggerEventOf(activity: ActivityKey): TriggerEvent | null {
  if (activity === 'loading') return 'loading';
  if (activity.startsWith('loading-')) return 'loadingPartial';
  if (activity === 'fractureRepairing' || activity.startsWith('fractureRepairing-')) return 'fractureRepairing';
  if (activity === 'defectRepairing' || activity.startsWith('defectRepairing-')) return 'defectRepairing';
  if (activity === 'diesChange' || activity.startsWith('diesChange-')) return 'diesChange';
  return null;
}

/** Whether an event-triggered Doffing sub is due on this Doffing, given the events that happened
 * on the machine since the previous Doffing came due and whether this is its first Doffing of the
 * shift. */
export function frequencyTypeIsDue(
  type: FrequencyType,
  eventsSinceLastDoff: ReadonlySet<TriggerEvent>,
  firstDoffOfShift: boolean,
): boolean {
  if (type === 'FirstDoffOnShift') return firstDoffOfShift;
  return TRIGGERS_BY_TYPE[type].some((event) => eventsSinceLastDoff.has(event));
}

function ratePerSpool(cycle: number): number {
  return Number.isFinite(cycle) && cycle > 0 ? 1 / cycle : 0;
}

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

/** Expected events per finished spool on one machine, for forecasting only. */
function triggerRatePerSpool(event: TriggerEvent, activities: ActivityConfig[]): number {
  const cycleOf = (key: ActivityKey) => {
    const activity = activities.find((item) => item.key === key);
    return activity ? activityCycleLength(activity) : Infinity;
  };
  if (event === 'loadingPartial') {
    // A Loading partial only runs at the spool boundaries where full Loading isn't due.
    const parentCycle = cycleOf('loading');
    return activities
      .filter((activity) => activity.parentKey === 'loading')
      .reduce((total, activity) => {
        const cycle = activityCycleLength(activity);
        let rate = ratePerSpool(cycle);
        if (rate > 0 && Number.isFinite(parentCycle) && parentCycle > 0) {
          const divisor = greatestCommonDivisor(cycle, parentCycle);
          if (divisor > 0) rate -= 1 / ((cycle / divisor) * parentCycle);
        }
        return total + Math.max(0, rate);
      }, 0);
  }
  if (event === 'diesChange') return ratePerSpool(cycleOf('diesChange') * AVERAGE_DIES_PER_CHANGE_EVENT);
  return ratePerSpool(cycleOf(event));
}

/** Spools between occurrences, for forecasts and expected-event counts. An event-triggered Doffing
 * sub happens at most once per Doffing, and at most as often as its trigger events — so its rate is
 * the lower of the two; FirstDoffOnShift happens once per machine per shift (`spoolsPerShift`).
 * Every other activity uses its plain Numerator/Denominator cycle. */
export function forecastCycleLength(activity: ActivityConfig, activities: ActivityConfig[], spoolsPerShift: number): number {
  if (!activity.frequencyType) return activityCycleLength(activity);
  const doffing = activities.find((item) => item.key === 'doffing');
  const doffRate = doffing ? ratePerSpool(activityCycleLength(doffing)) : 0;
  if (activity.frequencyType === 'FirstDoffOnShift') {
    return doffRate > 0 && spoolsPerShift > 0 ? Math.max(spoolsPerShift, 1 / doffRate) : Infinity;
  }
  const triggerRate = TRIGGERS_BY_TYPE[activity.frequencyType].reduce(
    (total, event) => total + triggerRatePerSpool(event, activities),
    0,
  );
  const rate = Math.min(doffRate, triggerRate);
  return rate > 0 ? 1 / rate : Infinity;
}
