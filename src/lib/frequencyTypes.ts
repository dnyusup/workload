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

/** Share of spools on which every one of these cycles comes due at once. Due counts are
 * floor(spools ÷ cycle) on one shared spool counter, so whole-number cycles all fall due together
 * every lcm spools; other cycles are treated as independent. */
function sharedRatePerSpool(cycles: number[]): number {
  if (cycles.some((cycle) => !Number.isFinite(cycle) || cycle <= 0)) return 0;
  const whole = cycles.every((cycle) => Math.abs(cycle - Math.round(cycle)) < 1e-9);
  if (!whole) return cycles.reduce((rate, cycle) => rate / cycle, 1);
  const lcm = cycles.map(Math.round).reduce((a, b) => (a * b) / greatestCommonDivisor(a, b));
  return 1 / lcm;
}

/** How often a Loading partial is really done per spool, as the simulation does it: never on a
 * spool where full Loading is due too, and when Partial1 and Partial2 come due together they're
 * replaced by one Partial3 (only defined when that row exists). Null for anything else. */
function loadingPartialRatePerSpool(activity: ActivityConfig, activities: ActivityConfig[]): number | null {
  if (activity.parentKey !== 'loading' || !activity.loadingPartialSlot) return null;
  const loading = activities.find((item) => item.key === 'loading');
  // Weight-based Loading isn't due on a spool count, so it never coincides with a partial.
  const loadingCycle = loading && !loading.loadingInterrupt ? activityCycleLength(loading) : Infinity;
  const notWithLoading = (cycles: number[]) =>
    sharedRatePerSpool(cycles) - (Number.isFinite(loadingCycle) && loadingCycle > 0 ? sharedRatePerSpool([...cycles, loadingCycle]) : 0);
  const slot = (n: 1 | 2 | 3) => activities.find((item) => item.parentKey === 'loading' && item.loadingPartialSlot === n);
  const partial1 = slot(1);
  const partial2 = slot(2);
  const combines = !!partial1 && !!partial2 && !!slot(3);
  if (activity.loadingPartialSlot === 3) {
    return combines ? Math.max(0, notWithLoading([activityCycleLength(partial1!), activityCycleLength(partial2!)])) : 0;
  }
  const own = activityCycleLength(activity);
  const other = activity.loadingPartialSlot === 1 ? partial2 : partial1;
  let rate = notWithLoading([own]);
  if (combines && other) rate -= notWithLoading([own, activityCycleLength(other)]);
  return Math.max(0, rate);
}

/** Expected events per finished spool on one machine, for forecasting only. */
function triggerRatePerSpool(event: TriggerEvent, activities: ActivityConfig[]): number {
  const cycleOf = (key: ActivityKey) => {
    const activity = activities.find((item) => item.key === key);
    return activity ? activityCycleLength(activity) : Infinity;
  };
  if (event === 'loadingPartial') {
    // Every partial actually done (Partial1, Partial2 or a combined Partial3) counts once.
    return activities
      .filter((activity) => activity.parentKey === 'loading')
      .reduce((total, activity) => total + (loadingPartialRatePerSpool(activity, activities) ?? 0), 0);
  }
  if (event === 'diesChange') return ratePerSpool(cycleOf('diesChange') * AVERAGE_DIES_PER_CHANGE_EVENT);
  return ratePerSpool(cycleOf(event));
}

/** Spools between occurrences, for forecasts and expected-event counts. An event-triggered Doffing
 * sub happens at most once per Doffing, and at most as often as its trigger events — so its rate is
 * the lower of the two; FirstDoffOnShift happens once per machine per shift (`spoolsPerShift`).
 * A Loading partial skips the spools where full Loading is due and is combined into Partial3 when
 * both partials coincide (see loadingPartialRatePerSpool). Every other activity uses its plain
 * Numerator/Denominator cycle. */
export function forecastCycleLength(activity: ActivityConfig, activities: ActivityConfig[], spoolsPerShift: number): number {
  const partialRate = loadingPartialRatePerSpool(activity, activities);
  if (partialRate !== null) return partialRate > 0 ? 1 / partialRate : Infinity;
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
