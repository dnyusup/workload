/** Wall-clock helpers for the shift start time (24-hour "HH:MM"). Simulation time is always
 * "minutes since shift start"; these only turn it into a clock reading for display. */

export const DEFAULT_SHIFT_START = '07:00';
const MINUTES_PER_DAY = 24 * 60;

/** "HH:MM" → minutes after midnight; falls back to the default for anything malformed. */
export function parseClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match) {
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) return h * 60 + m;
  }
  return parseClock(DEFAULT_SHIFT_START);
}

/** Minutes after midnight (any value, wraps past midnight) → "HH:MM", with "+1" once a shift
 * runs into the next day. */
export function formatClock(minutesOfDay: number): string {
  const rounded = Math.floor(minutesOfDay + 1e-6);
  const dayOffset = Math.floor(rounded / MINUTES_PER_DAY);
  const inDay = ((rounded % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const text = `${String(Math.floor(inDay / 60)).padStart(2, '0')}:${String(inDay % 60).padStart(2, '0')}`;
  return dayOffset > 0 ? `${text} (+${dayOffset})` : text;
}

export function isValidClock(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
