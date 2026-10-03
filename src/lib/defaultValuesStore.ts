import type { TaskPriorityMode } from '../types';
import { Mpp_wl_defaultvaluesService } from '../generated/services/Mpp_wl_defaultvaluesService';
import type { Mpp_wl_defaultvalues } from '../generated/models/Mpp_wl_defaultvaluesModel';
import { fetchAllPages } from './dataversePaging';

/** Starting values for a new Production Setup and for the Work Load Simulator's setup whenever a
 * Construction Detail is picked — maintained by admins in Setting → Default Values. */
export interface DefaultValues {
  taskPriority: TaskPriorityMode;
  shiftTime: number;
  lunchTime: number;
  lunchStartAt: number;
  meetingTime: number;
  meetingStartAt: number;
  rpc: number;
  walkingSpeed: number;
  doffPriority: boolean;
  minRemainForDoffPriority: number;
}

/** Used for any parameter WL_DefaultValues has no (valid) row for yet. */
export const BUILT_IN_DEFAULTS: DefaultValues = {
  taskPriority: 'quickest',
  shiftTime: 480,
  lunchTime: 30,
  lunchStartAt: 240,
  meetingTime: 15,
  meetingStartAt: 420,
  rpc: 12,
  walkingSpeed: 60,
  doffPriority: false,
  minRemainForDoffPriority: 5,
};

/** WL_DefaultValues.mpp_parameters name for each setting (matched case-insensitively). */
const PARAMETER_NAMES: Record<keyof DefaultValues, string> = {
  taskPriority: 'TaskPriority',
  shiftTime: 'ShiftTime',
  lunchTime: 'LunchTime',
  lunchStartAt: 'LunchStartAt',
  meetingTime: 'MeetingTime',
  meetingStartAt: 'MeetingStartAt',
  rpc: 'RPC',
  walkingSpeed: 'WalkingSpeed',
  doffPriority: 'DoffPriority',
  minRemainForDoffPriority: 'MinRemainTaskForDoffPriority',
};

const KEYS = Object.keys(PARAMETER_NAMES) as (keyof DefaultValues)[];

function rowsByKey(rows: Mpp_wl_defaultvalues[]): Map<keyof DefaultValues, Mpp_wl_defaultvalues> {
  const byName = new Map(rows.map((row) => [(row.mpp_parameters ?? '').trim().toLowerCase(), row]));
  const result = new Map<keyof DefaultValues, Mpp_wl_defaultvalues>();
  KEYS.forEach((key) => {
    const row = byName.get(PARAMETER_NAMES[key].toLowerCase());
    if (row) result.set(key, row);
  });
  return result;
}

function parseValue<K extends keyof DefaultValues>(key: K, raw: string | undefined): DefaultValues[K] | undefined {
  const text = (raw ?? '').trim();
  if (key === 'doffPriority') {
    const flag = text.toLowerCase();
    return (flag === 'yes' ? true : flag === 'no' ? false : undefined) as DefaultValues[K] | undefined;
  }
  if (key === 'taskPriority') {
    const mode = text.toLowerCase();
    return (mode === 'nearest' || mode === 'quickest' ? mode : undefined) as DefaultValues[K] | undefined;
  }
  const value = Number(text);
  return (text !== '' && Number.isFinite(value) ? value : undefined) as DefaultValues[K] | undefined;
}

export async function loadDefaultValues(): Promise<DefaultValues> {
  const rows = rowsByKey(await fetchAllPages(Mpp_wl_defaultvaluesService.getAll, {}));
  const values = { ...BUILT_IN_DEFAULTS };
  KEYS.forEach(<K extends keyof DefaultValues>(key: K) => {
    const parsed = parseValue(key, rows.get(key)?.mpp_value);
    if (parsed !== undefined) values[key] = parsed;
  });
  return values;
}

/** Defaults for creating something right now. Falls back to the built-in values if
 * WL_DefaultValues can't be read, so a settings-table hiccup never blocks creating a setup. */
export async function loadDefaultValuesOrBuiltIn(): Promise<DefaultValues> {
  try {
    return await loadDefaultValues();
  } catch {
    return BUILT_IN_DEFAULTS;
  }
}

function formatValue(key: keyof DefaultValues, value: DefaultValues[keyof DefaultValues]): string {
  if (key === 'doffPriority') return value ? 'Yes' : 'No';
  return String(value);
}

/** Upserts one WL_DefaultValues row per parameter. */
export async function saveDefaultValues(values: DefaultValues): Promise<void> {
  const rows = rowsByKey(await fetchAllPages(Mpp_wl_defaultvaluesService.getAll, {}));
  for (const key of KEYS) {
    const value = formatValue(key, values[key]);
    const row = rows.get(key);
    if (row && (row.mpp_value ?? '').trim() === value) continue;
    const result = row
      ? await Mpp_wl_defaultvaluesService.update(row.mpp_wl_defaultvalueid, { mpp_value: value })
      : await Mpp_wl_defaultvaluesService.create({ mpp_parameters: PARAMETER_NAMES[key], mpp_value: value, statecode: 0 });
    if (!result.success) throw new Error(result.error?.message ?? `Failed to save ${PARAMETER_NAMES[key]}.`);
  }
}
