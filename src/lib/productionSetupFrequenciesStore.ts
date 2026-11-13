import { Mpp_wl_productionsetupfrequenciesService } from '../generated/services/Mpp_wl_productionsetupfrequenciesService';
import type { Mpp_wl_productionsetupfrequencies } from '../generated/models/Mpp_wl_productionsetupfrequenciesModel';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import type { FrequencyMode, ProductionMachineAssignment } from '../types';
import {
  buildFrequencyLookupKey,
  lookupHistoricalFrequency,
  type HistoricalFrequencyMap,
} from './frequencyCatalog';
import { fetchAllPages } from './dataversePaging';

export interface SetupFrequencyItem {
  id: string;
  setupId: string;
  mach: string;
  construction: string;
  layLength: string;
  tensile: string;
  frt: number;
  deft: number;
  diest: number;
  source: 'manual' | 'historical' | 'fallback manual' | 'adjustment';
  isEdited?: boolean;
}

/** Parses numeric string or number safely into a finite number. */
function parseRate(val: unknown): number {
  if (val == null) return 0;
  const num = typeof val === 'number' ? val : parseFloat(String(val).trim());
  return Number.isFinite(num) ? Math.max(0, num) : 0;
}

/** Converts a Dataverse record into our SetupFrequencyItem interface. */
export function mapRecordToSetupFrequency(rec: Mpp_wl_productionsetupfrequencies): SetupFrequencyItem {
  const rawSource = (rec.mpp_frequencysource ?? 'manual').trim().toLowerCase();
  let source: SetupFrequencyItem['source'] = 'manual';
  if (rawSource === 'adjustment' || rawSource === 'adjusted') {
    source = 'adjustment';
  } else if (rawSource === 'historical') {
    source = 'historical';
  } else if (rawSource.includes('fallback')) {
    source = 'fallback manual';
  }

  return {
    id: rec.mpp_wl_productionsetupfrequencyid,
    setupId: rec.mpp_productionsetupid,
    mach: rec.mpp_mach ?? '',
    construction: rec.mpp_construction ?? '',
    layLength: rec.mpp_laylength ?? '',
    tensile: rec.mpp_tensile ?? '',
    frt: rec.mpp_frt ?? 0,
    deft: rec.mpp_deft ?? 0,
    diest: rec.mpp_diest ?? 0,
    source,
  };
}

/** Fetches all rows from WL_ProductionSetupFrequency for a given setup ID. */
export async function fetchSetupFrequencies(setupId: string): Promise<SetupFrequencyItem[]> {
  if (!setupId) return [];
  try {
    const records = await fetchAllPages(async (options) => {
      return Mpp_wl_productionsetupfrequenciesService.getAll({
        ...options,
        filter: `mpp_productionsetupid eq '${setupId}'`,
      });
    });
    return records.map(mapRecordToSetupFrequency);
  } catch (err) {
    console.warn(`[WL_ProductionSetupFrequency] Failed to fetch frequencies for setup ${setupId}:`, err);
    return [];
  }
}

/**
 * Extracts the pure construction name (e.g. "3X0.27") without Mach prefix, Lay Length, Tensile, or Spool Type.
 */
export function extractPureConstruction(product: {
  mpp_productspecification?: string | null;
  mpp_constructioncode?: string | null;
}): string {
  const spec = (product.mpp_productspecification ?? '').trim();
  if (spec) return spec;

  const code = (product.mpp_constructioncode ?? '').trim();
  if (!code) return '';

  // If in format Mach-Construction-LayLength-Tensile-SpoolType (e.g. BOS-3X0.27-14-HT-BS40)
  const parts = code.split('-');
  if (parts.length >= 3) {
    return parts[1].trim();
  }
  return code;
}

/**
 * Builds a composite lookup key for matching products with setup frequency entries:
 * Mach|Construction|LayLength|Tensile
 */
export function buildSetupFrequencyKey(
  mach: string | undefined | null,
  construction: string | undefined | null,
  layLength: number | string | undefined | null,
  tensile: string | undefined | null,
): string {
  return buildFrequencyLookupKey(mach, construction, layLength, tensile);
}

export interface FrequencyChangeItem {
  mach: string;
  construction: string;
  layLength: string;
  tensile: string;
  isNew: boolean;
  oldFrt: number;
  newFrt: number;
  oldDeft: number;
  newDeft: number;
  oldDiest: number;
  newDiest: number;
  oldSource: string;
  newSource: string;
}

export interface SyncSetupFrequenciesResult {
  items: SetupFrequencyItem[];
  changes: FrequencyChangeItem[];
}

/**
 * Synchronizes assigned constructions in a setup with WL_ProductionSetupFrequency:
 * 1. Creates missing rows for any newly assigned construction tuple.
 * 2. If updateExisting is true, updates existing rows (unless source === 'adjustment')
 *    when frequencyMode changes (Manual <-> Historical) or when historical date range reloads.
 * 3. Returns both the updated list of items and a detailed list of what changed.
 */
export async function syncSetupFrequenciesForAssignments({
  setupId,
  assignments,
  products,
  frequencyMode = 'manual',
  frequencyCatalog = null,
  existingItems = [],
  updateExisting = true,
}: {
  setupId: string;
  assignments: ProductionMachineAssignment[];
  products: Mpp_wl_productses[];
  frequencyMode?: FrequencyMode;
  frequencyCatalog?: HistoricalFrequencyMap | null;
  existingItems?: SetupFrequencyItem[];
  updateExisting?: boolean;
}): Promise<SyncSetupFrequenciesResult> {
  if (!setupId || assignments.length === 0 || products.length === 0) {
    return { items: existingItems, changes: [] };
  }

  const productById = new Map(products.map((p) => [p.mpp_wl_productsid, p]));
  const existingItemMap = new Map<string, SetupFrequencyItem>();
  for (const item of existingItems) {
    existingItemMap.set(
      buildSetupFrequencyKey(item.mach, item.construction, item.layLength, item.tensile),
      item,
    );
  }

  // Group unique product tuples needed across all assignments
  const neededTuples = new Map<
    string,
    {
      product: Mpp_wl_productses;
      mach: string;
      construction: string;
      layLength: string;
      tensile: string;
    }
  >();

  for (const a of assignments) {
    if (!a.constructionDetailId) continue;
    const p = productById.get(a.constructionDetailId);
    if (!p) continue;

    const mach = p.mpp_machinecode?.trim() ?? '';
    const construction = extractPureConstruction(p);
    const layLength = p.mpp_laylength != null ? String(p.mpp_laylength).trim() : '';
    const tensile = p.mpp_tensilegroup?.trim() ?? '';

    const key = buildSetupFrequencyKey(mach, construction, layLength, tensile);
    if (!neededTuples.has(key)) {
      neededTuples.set(key, { product: p, mach, construction, layLength, tensile });
    }
  }

  if (neededTuples.size === 0) {
    return { items: existingItems, changes: [] };
  }

  const changes: FrequencyChangeItem[] = [];
  const currentItems = [...existingItems];

  for (const [key, tuple] of neededTuples) {
    const { product, mach, construction, layLength, tensile } = tuple;
    const manualFr = parseRate(product.mpp_fractureperton);
    const manualDef = parseRate(product.mpp_defectston);
    const manualDies = parseRate(product.mpp_dieston);

    let targetFr = manualFr;
    let targetDef = manualDef;
    let targetDies = manualDies;
    let targetSource: SetupFrequencyItem['source'] = 'manual';

    if (frequencyMode === 'historical' && frequencyCatalog) {
      const matched = lookupHistoricalFrequency(
        frequencyCatalog,
        mach,
        construction,
        product.mpp_laylength,
        tensile,
      );

      if (matched) {
        targetFr = matched.fracturePerTon ?? manualFr;
        targetDef = matched.defectPerTon ?? manualDef;
        targetDies = matched.diesPerTon ?? manualDies;
        targetSource = 'historical';
      } else {
        targetSource = 'fallback manual';
      }
    }

    // Check if row already exists (by pure key or by legacy key with full construction code)
    const existing =
      existingItemMap.get(key) ??
      (product.mpp_constructioncode
        ? existingItemMap.get(buildSetupFrequencyKey(mach, product.mpp_constructioncode, layLength, tensile))
        : undefined);

    if (!existing) {
      try {
        const result = await Mpp_wl_productionsetupfrequenciesService.create({
          mpp_productionsetupid: setupId,
          mpp_mach: mach,
          mpp_construction: construction,
          mpp_laylength: layLength,
          mpp_tensile: tensile,
          mpp_frt: targetFr,
          mpp_deft: targetDef,
          mpp_diest: targetDies,
          mpp_frequencysource: targetSource,
          statecode: 0,
        });

        if (result.success && result.data) {
          const item = mapRecordToSetupFrequency(result.data);
          currentItems.push(item);
          existingItemMap.set(key, item);
          changes.push({
            mach,
            construction,
            layLength,
            tensile,
            isNew: true,
            oldFrt: 0,
            newFrt: targetFr,
            oldDeft: 0,
            newDeft: targetDef,
            oldDiest: 0,
            newDiest: targetDies,
            oldSource: '—',
            newSource: targetSource,
          });
        }
      } catch (err) {
        console.warn(`[WL_ProductionSetupFrequency] Failed to insert row for ${construction}:`, err);
      }
    } else if (updateExisting) {
      // Do not overwrite custom manual adjustments
      if (existing.source === 'adjustment') {
        continue;
      }

      const isRateChanged =
        Math.abs(existing.frt - targetFr) > 0.0001 ||
        Math.abs(existing.deft - targetDef) > 0.0001 ||
        Math.abs(existing.diest - targetDies) > 0.0001;
      const isSourceChanged = existing.source !== targetSource;
      const isConstructionNameCleaned = existing.construction !== construction;

      if (isRateChanged || isSourceChanged || isConstructionNameCleaned) {
        try {
          const ok = await Mpp_wl_productionsetupfrequenciesService.update(existing.id, {
            mpp_mach: mach,
            mpp_construction: construction,
            mpp_laylength: layLength,
            mpp_tensile: tensile,
            mpp_frt: targetFr,
            mpp_deft: targetDef,
            mpp_diest: targetDies,
            mpp_frequencysource: targetSource,
          });

          if (ok.success) {
            changes.push({
              mach,
              construction,
              layLength,
              tensile,
              isNew: false,
              oldFrt: existing.frt,
              newFrt: targetFr,
              oldDeft: existing.deft,
              newDeft: targetDef,
              oldDiest: existing.diest,
              newDiest: targetDies,
              oldSource: existing.source,
              newSource: targetSource,
            });
            existing.frt = targetFr;
            existing.deft = targetDef;
            existing.diest = targetDies;
            existing.source = targetSource;
            existing.construction = construction;
          }
        } catch (err) {
          console.warn(`[WL_ProductionSetupFrequency] Failed to update row ${existing.id}:`, err);
        }
      }
    }
  }

  return { items: currentItems, changes };
}

/** Updates a single frequency adjustment in Dataverse. */
export async function updateSetupFrequencyItem(
  id: string,
  fields: {
    frt?: number;
    deft?: number;
    diest?: number;
    source?: string;
  },
): Promise<boolean> {
  try {
    const result = await Mpp_wl_productionsetupfrequenciesService.update(id, {
      mpp_frt: fields.frt,
      mpp_deft: fields.deft,
      mpp_diest: fields.diest,
      mpp_frequencysource: fields.source ?? 'adjustment',
    });
    return result.success;
  } catch (err) {
    console.error(`[WL_ProductionSetupFrequency] Failed to update row ${id}:`, err);
    return false;
  }
}

/** Deletes a single frequency row from WL_ProductionSetupFrequency in Dataverse. */
export async function deleteSetupFrequencyItem(id: string): Promise<boolean> {
  try {
    const result = await Mpp_wl_productionsetupfrequenciesService.delete(id);
    return result.success;
  } catch (err) {
    console.error(`[WL_ProductionSetupFrequency] Failed to delete row ${id}:`, err);
    return false;
  }
}

