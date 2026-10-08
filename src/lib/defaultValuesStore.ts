import type { TaskPriorityMode, WaitingModel } from '../types';
import { Mpp_wl_defaultvaluesService } from '../generated/services/Mpp_wl_defaultvaluesService';
import type { Mpp_wl_defaultvalues } from '../generated/models/Mpp_wl_defaultvaluesModel';
import { fetchAllPages } from './dataversePaging';
import { DEFAULT_OPTIMIZE_STEP_UP_BELOW, DEFAULT_WAITING_MODEL } from './singleOperatorUtilization';
import { formatWaitingModel, parseWaitingModel } from './waitingModel';

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
  waitingModel: WaitingModel;
  /** Off: no waiting model anywhere — forecasts work as None and the model isn't shown. */
  useWaitingModel: boolean;
  /** Optimize adds one machine when Forecast Man Occupation stays below this (%); 0 = off. */
  optimizeStepUpBelow: number;
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
  waitingModel: DEFAULT_WAITING_MODEL,
  useWaitingModel: true,
  optimizeStepUpBelow: DEFAULT_OPTIMIZE_STEP_UP_BELOW,
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
  waitingModel: 'WaitingModel',
  useWaitingModel: 'UseWaitingModel',
  optimizeStepUpBelow: 'OptimizeStepUpBelow',
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
  if (key === 'doffPriority' || key === 'useWaitingModel') {
    const flag = text.toLowerCase();
    return (flag === 'yes' ? true : flag === 'no' ? false : undefined) as DefaultValues[K] | undefined;
  }
  if (key === 'waitingModel') return parseWaitingModel(text) as DefaultValues[K] | undefined;
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
  if (key === 'doffPriority' || key === 'useWaitingModel') return value ? 'Yes' : 'No';
  if (key === 'waitingModel') return formatWaitingModel(value as DefaultValues['waitingModel']);
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

/** WL_DefaultValues rows named `Layout-<Area>` (e.g. Layout-BU) hold the WL_Layouts id the Work
 * Load Simulator uses by default for that Area. */
const DEFAULT_LAYOUT_PREFIX = 'layout-';

function defaultLayoutRows(rows: Mpp_wl_defaultvalues[]): Map<string, Mpp_wl_defaultvalues> {
  const byArea = new Map<string, Mpp_wl_defaultvalues>();
  rows.forEach((row) => {
    const name = (row.mpp_parameters ?? '').trim();
    if (!name.toLowerCase().startsWith(DEFAULT_LAYOUT_PREFIX)) return;
    const area = name.slice(DEFAULT_LAYOUT_PREFIX.length).trim().toUpperCase();
    if (area) byArea.set(area, row);
  });
  return byArea;
}

/** Area (upper case) → default layout id, for every Area that has one. */
export async function loadDefaultLayouts(): Promise<Record<string, string>> {
  const rows = defaultLayoutRows(await fetchAllPages(Mpp_wl_defaultvaluesService.getAll, {}));
  const layouts: Record<string, string> = {};
  rows.forEach((row, area) => {
    const layoutId = (row.mpp_value ?? '').trim();
    if (layoutId) layouts[area] = layoutId;
  });
  return layouts;
}

/** Like loadDefaultLayouts, but none at all when WL_DefaultValues can't be read — picking a
 * Construction then just keeps the current layout. */
export async function loadDefaultLayoutsOrNone(): Promise<Record<string, string>> {
  try {
    return await loadDefaultLayouts();
  } catch {
    return {};
  }
}

/** Upserts one `Layout-<Area>` row per given Area; a blank id clears that Area's default. */
export async function saveDefaultLayouts(layouts: Record<string, string>): Promise<void> {
  const rows = defaultLayoutRows(await fetchAllPages(Mpp_wl_defaultvaluesService.getAll, {}));
  for (const [rawArea, rawLayoutId] of Object.entries(layouts)) {
    const area = rawArea.trim().toUpperCase();
    const layoutId = rawLayoutId.trim();
    const row = rows.get(area);
    if ((row?.mpp_value ?? '').trim() === layoutId || (!row && !layoutId)) continue;
    const result = row
      ? await Mpp_wl_defaultvaluesService.update(row.mpp_wl_defaultvalueid, { mpp_value: layoutId })
      : await Mpp_wl_defaultvaluesService.create({ mpp_parameters: `Layout-${area}`, mpp_value: layoutId, statecode: 0 });
    if (!result.success) throw new Error(result.error?.message ?? `Failed to save Layout-${area}.`);
  }
}
