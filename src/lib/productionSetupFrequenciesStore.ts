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

/**
 * Synchronizes assigned constructions in a setup with WL_ProductionSetupFrequency:
 * For every assigned construction whose (Mach, Construction, LayLength, Tensile) tuple
 * does NOT yet exist for this setupId in WL_ProductionSetupFrequency, a new row is generated
 * and inserted into Dataverse.
 */
export async function syncSetupFrequenciesForAssignments({
  setupId,
  assignments,
  products,
  frequencyMode = 'manual',
  frequencyCatalog = null,
  existingItems = [],
}: {
  setupId: string;
  assignments: ProductionMachineAssignment[];
  products: Mpp_wl_productses[];
  frequencyMode?: FrequencyMode;
  frequencyCatalog?: HistoricalFrequencyMap | null;
  existingItems?: SetupFrequencyItem[];
}): Promise<SetupFrequencyItem[]> {
  if (!setupId || assignments.length === 0 || products.length === 0) {
    return existingItems;
  }

  const productById = new Map(products.map((p) => [p.mpp_wl_productsid, p]));
  const existingKeySet = new Set(
    existingItems.map((item) =>
      buildSetupFrequencyKey(item.mach, item.construction, item.layLength, item.tensile),
    ),
  );

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
    const construction = p.mpp_constructioncode?.trim() || p.mpp_productspecification?.trim() || '';
    const layLength = p.mpp_laylength != null ? String(p.mpp_laylength).trim() : '';
    const tensile = p.mpp_tensilegroup?.trim() ?? '';

    const key = buildSetupFrequencyKey(mach, construction, layLength, tensile);
    if (!existingKeySet.has(key) && !neededTuples.has(key)) {
      neededTuples.set(key, { product: p, mach, construction, layLength, tensile });
    }
  }

  if (neededTuples.size === 0) {
    return existingItems;
  }

  const newlyCreated: SetupFrequencyItem[] = [];

  for (const [, tuple] of neededTuples) {
    const { product, mach, construction, layLength, tensile } = tuple;
    const manualFr = parseRate(product.mpp_fractureperton);
    const manualDef = parseRate(product.mpp_defectston);
    const manualDies = parseRate(product.mpp_dieston);

    let frt = manualFr;
    let deft = manualDef;
    let diest = manualDies;
    let source: SetupFrequencyItem['source'] = 'manual';

    if (frequencyMode === 'historical' && frequencyCatalog) {
      const matched = lookupHistoricalFrequency(
        frequencyCatalog,
        mach,
        product.mpp_productspecification || construction,
        product.mpp_laylength,
        tensile,
      );

      if (matched) {
        frt = matched.fracturePerTon ?? manualFr;
        deft = matched.defectPerTon ?? manualDef;
        diest = matched.diesPerTon ?? manualDies;
        source = 'historical';
      } else {
        source = 'fallback manual';
      }
    }

    try {
      const result = await Mpp_wl_productionsetupfrequenciesService.create({
        mpp_productionsetupid: setupId,
        mpp_mach: mach,
        mpp_construction: construction,
        mpp_laylength: layLength,
        mpp_tensile: tensile,
        mpp_frt: frt,
        mpp_deft: deft,
        mpp_diest: diest,
        mpp_frequencysource: source,
        statecode: 0,
      });

      if (result.success && result.data) {
        const item = mapRecordToSetupFrequency(result.data);
        newlyCreated.push(item);
        existingKeySet.add(buildSetupFrequencyKey(mach, construction, layLength, tensile));
      }
    } catch (err) {
      console.warn(`[WL_ProductionSetupFrequency] Failed to insert row for ${construction}:`, err);
    }
  }

  return [...existingItems, ...newlyCreated];
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

