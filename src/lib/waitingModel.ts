import type { WaitingModel } from '../types';

/** How a WaitingModel is stored in Dataverse text columns (WL_DefaultValues, mpp_optimizemodel). */
const STORED: Record<WaitingModel, string> = {
  none: 'None',
  wright: 'Wright',
  finiteSource: 'FiniteSource',
};

export const WAITING_MODEL_LABELS: Record<WaitingModel, string> = {
  none: 'None',
  wright: 'Wright',
  finiteSource: 'Finite source',
};

export function formatWaitingModel(model: WaitingModel): string {
  return STORED[model];
}

/** Case-, space-, dash- and underscore-insensitive; undefined for anything unrecognised. */
export function parseWaitingModel(value: string | undefined | null): WaitingModel | undefined {
  const text = (value ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  return (Object.keys(STORED) as WaitingModel[]).find((model) => STORED[model].toLowerCase() === text);
}
