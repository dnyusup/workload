import type { FrequencyMode } from '../types';
import { WL_RejectShortService } from '../generated/services/WL_RejectShortService';
import { loadDefaultValuesOrBuiltIn, type FrequencyDateRangeType } from './defaultValuesStore';
import {
  buildPlantDateFlowPayload,
  cleanFloat,
  computeFrequencyDateRange,
  getField,
  lookupCatalogWithVariants,
  normalizeFrequencyKeyPart,
  normalizeLayLength,
  parseFlowResultRows,
  type DateRangeParts,
} from './frequencyCatalog';

export interface ActiveRejectShortFilterParams {
  plant: string;
  dateRangeType: FrequencyDateRangeType;
  startDate: string;
  endDate: string;
  daxQuery: string;
}

let lastActiveRejectShortFilterParams: ActiveRejectShortFilterParams | null = null;

/** Returns the active Plant / Date filter parameters from the latest MES_RejectShort query. */
export function getActiveRejectShortFilterParams(): ActiveRejectShortFilterParams | null {
  return lastActiveRejectShortFilterParams;
}

/** Generates the Power BI DAX query matching WL_RejectShort for documentation and preview. */
export function generateRejectShortDax({
  plant,
  startParts,
  endParts,
  reasonCode = '1233',
}: {
  plant: string;
  startParts: DateRangeParts['startParts'];
  endParts: DateRangeParts['endParts'];
  reasonCode?: string;
}): string {
  const safePlant = plant.trim() || 'PTBI';
  return `EVALUATE
ADDCOLUMNS(
SUMMARIZECOLUMNS(
    -- 1. DIMENSI GROUP BY
    DimPlantRegion[PlantName],
    DimProduct[Construction],
    DimProduct[LayLength],
    DimProduct[TensileStrength],
    DimProduct[LinerDensity],
    DimReasonCode[Code],
    DimReasonCode[ReasonCodeDescption],

    --  FILTER PLANT, TANGGAL :
    TREATAS({"${safePlant}"}, DimPlantRegion[PlantName]),
    TREATAS({"${reasonCode}"}, DimReasonCode[Code]),
    FILTER(
        ALL(DimDate[Date]), 
        DimDate[Date] >= DATE(${startParts.year}, ${startParts.month}, ${startParts.day}) && DimDate[Date] <= DATE(${endParts.year}, ${endParts.month}, ${endParts.day})
    ),

    --  MEASURES
    "TotalRejectKG", SUM(FactMachineNonConformity[RejectedKG]),
    "TotalRejectSpool", SUM(FactMachineNonConformity[DoffedRejectSpoolCount])
),
"TotalRejectMeter", [TotalRejectKG] / DimProduct[LinerDensity] * 1000,
"AVGrejectmeterperspool", ([TotalRejectKG] / DimProduct[LinerDensity] * 1000) / [TotalRejectSpool]
)`;
}

export interface RejectShortRecord {
  id: string;
  plantName: string;
  construction: string;
  layLength: number | string;
  tensileStrength: string;
  linerDensity: number | null;
  reasonCode: string;
  reasonDescription: string;
  totalRejectKG: number;
  totalRejectSpool: number;
  totalRejectMeter: number;
  avgRejectMeterPerSpool: number;
  raw: Record<string, unknown>;
}

/** Parses raw Power BI ExecuteQueries rows returned by WL_RejectShort into typed records. */
export function parseRejectShortRows(rawItems: Record<string, unknown>[]): RejectShortRecord[] {
  return rawItems.map((row, idx) => {
    const plantName = String(getField(row, 'DimPlantRegion[PlantName]', 'PlantName') ?? '').trim();
    const construction = String(getField(row, 'DimProduct[Construction]', 'Construction') ?? '').trim();
    const layLengthRaw = getField(row, 'DimProduct[LayLength]', '[DimProduct].[LayLength]', 'LayLength');
    const layLength = normalizeLayLength(layLengthRaw);
    const tensileStrength = String(getField(row, 'DimProduct[TensileStrength]', 'TensileStrength') ?? '').trim();
    const linerDensity = cleanFloat(
      getField(row, 'DimProduct[LinerDensity]', 'LinerDensity', 'DimProduct[LinearDensity]', 'LinearDensity'),
      4,
    );
    const reasonCode = String(getField(row, 'DimReasonCode[Code]', 'Code', 'ReasonCode') ?? '').trim();
    const reasonDescription = String(
      getField(
        row,
        'DimReasonCode[ReasonCodeDescption]',
        'ReasonCodeDescption',
        'DimReasonCode[ReasonCodeDescription]',
        'ReasonCodeDescription',
      ) ?? '',
    ).trim();

    const totalRejectKG = cleanFloat(getField(row, 'TotalRejectKG', '[TotalRejectKG]', 'RejectedKG'), 3) ?? 0;
    const totalRejectSpool =
      cleanFloat(getField(row, 'TotalRejectSpool', '[TotalRejectSpool]', 'DoffedRejectSpoolCount'), 2) ?? 0;

    const rawMeter = cleanFloat(getField(row, 'TotalRejectMeter', '[TotalRejectMeter]'), 2);
    const totalRejectMeter =
      rawMeter !== null
        ? rawMeter
        : linerDensity && linerDensity > 0
          ? cleanFloat((totalRejectKG / linerDensity) * 1000, 2) ?? 0
          : 0;

    const rawAvg = cleanFloat(
      getField(row, 'AVGrejectmeterperspool', 'AVGRejectMeterPerSpool', '[AVGrejectmeterperspool]'),
      2,
    );
    const avgRejectMeterPerSpool =
      rawAvg !== null
        ? rawAvg
        : totalRejectSpool > 0
          ? cleanFloat(totalRejectMeter / totalRejectSpool, 2) ?? 0
          : 0;

    return {
      id: `${plantName}-${reasonCode}-${construction}-${layLength}-${tensileStrength}-${idx}`,
      plantName,
      construction,
      layLength,
      tensileStrength,
      linerDensity,
      reasonCode,
      reasonDescription,
      totalRejectKG,
      totalRejectSpool,
      totalRejectMeter,
      avgRejectMeterPerSpool,
      raw: row,
    };
  });
}

export interface LoadRejectShortOptions {
  plant?: string;
  startDate?: string;
  endDate?: string;
  dateRangeType?: FrequencyDateRangeType;
  forceRefresh?: boolean;
}

export interface HistoricalRejectShortItem {
  construction: string;
  layLength: string;
  tensileStrength: string;
  totalRejectKG: number;
  totalRejectSpool: number;
  totalRejectMeter: number;
  avgRejectMeterPerSpool: number | null;
  recordCount: number;
}

export type HistoricalRejectShortMap = Map<string, HistoricalRejectShortItem>;

/**
 * Builds normalized lookup key for MES_RejectShort -> WL_Products Area CR join:
 * Product (WL_Products.mpp_productspecification) = Construction (DimProduct[Construction])
 * LayLength (WL_Products.mpp_laylength) = LayLength (DimProduct[LayLength])
 * TensileGroup (WL_Products.mpp_tensilegroup) = TensileStrength (DimProduct[TensileStrength])
 */
export function buildRejectShortLookupKey(
  product: string | undefined | null,
  layLength: number | string | undefined | null,
  tensileGroup: string | undefined | null,
): string {
  return [
    normalizeFrequencyKeyPart(product),
    normalizeFrequencyKeyPart(layLength),
    normalizeFrequencyKeyPart(tensileGroup),
  ].join('|');
}

/**
 * Aggregates RejectShort records per (Construction, LayLength, TensileStrength) using
 * spool-weighted average: sum(TotalRejectMeter) / sum(TotalRejectSpool).
 */
export function buildHistoricalRejectShortMap(records: RejectShortRecord[]): HistoricalRejectShortMap {
  const groups = new Map<string, RejectShortRecord[]>();

  for (const rec of records) {
    const key = buildRejectShortLookupKey(rec.construction, rec.layLength, rec.tensileStrength);
    if (!key || key === '||') continue;
    const list = groups.get(key);
    if (list) list.push(rec);
    else groups.set(key, [rec]);
  }

  const catalog: HistoricalRejectShortMap = new Map();
  for (const [key, list] of groups.entries()) {
    let totalRejectKG = 0;
    let totalRejectSpool = 0;
    let totalRejectMeter = 0;
    const validAvgs: number[] = [];

    for (const r of list) {
      totalRejectKG += r.totalRejectKG > 0 ? r.totalRejectKG : 0;
      totalRejectSpool += r.totalRejectSpool > 0 ? r.totalRejectSpool : 0;
      totalRejectMeter += r.totalRejectMeter > 0 ? r.totalRejectMeter : 0;
      if (Number.isFinite(r.avgRejectMeterPerSpool) && r.avgRejectMeterPerSpool > 0) {
        validAvgs.push(r.avgRejectMeterPerSpool);
      }
    }

    const weightedAvg =
      totalRejectSpool > 0 && totalRejectMeter > 0
        ? Number((totalRejectMeter / totalRejectSpool).toFixed(2))
        : validAvgs.length > 0
          ? Number((validAvgs.reduce((acc, v) => acc + v, 0) / validAvgs.length).toFixed(2))
          : null;

    const first = list[0];
    catalog.set(key, {
      construction: first.construction,
      layLength: String(first.layLength),
      tensileStrength: first.tensileStrength,
      totalRejectKG: Number(totalRejectKG.toFixed(3)),
      totalRejectSpool: Number(totalRejectSpool.toFixed(2)),
      totalRejectMeter: Number(totalRejectMeter.toFixed(2)),
      avgRejectMeterPerSpool: weightedAvg,
      recordCount: list.length,
    });
  }

  return catalog;
}

export function lookupHistoricalRejectShort(
  catalog: HistoricalRejectShortMap | null | undefined,
  product: string | undefined | null,
  layLength: number | string | undefined | null,
  tensileGroup: string | undefined | null,
): HistoricalRejectShortItem | null {
  return lookupCatalogWithVariants(
    catalog,
    (prod, lay) => buildRejectShortLookupKey(prod, lay, tensileGroup),
    product,
    layLength,
  );
}

export interface EffectiveCrPoLengthResult {
  poLength1: number;
  isHistoricalUsed: boolean;
}

/**
 * Resolves Area CR PO Length 1: uses historical AVG meter/spool from MES_RejectShort
 * when mode === 'historical' and matched with > 0; otherwise falls back to manual/default PO Length 1.
 */
export function resolveEffectiveCrPoLength({
  manualPoLength1,
  lookupParams,
  mode,
  catalog,
}: {
  manualPoLength1: number;
  lookupParams: {
    product: string | undefined | null;
    layLength: number | string | undefined | null;
    tensileGroup: string | undefined | null;
  };
  mode: FrequencyMode;
  catalog: HistoricalRejectShortMap | null | undefined;
}): EffectiveCrPoLengthResult {
  if (mode === 'historical' && catalog) {
    const match = lookupHistoricalRejectShort(
      catalog,
      lookupParams.product,
      lookupParams.layLength,
      lookupParams.tensileGroup,
    );
    if (match?.avgRejectMeterPerSpool != null && Number.isFinite(match.avgRejectMeterPerSpool) && match.avgRejectMeterPerSpool > 0) {
      return {
        poLength1: match.avgRejectMeterPerSpool,
        isHistoricalUsed: true,
      };
    }
  }
  return {
    poLength1: manualPoLength1,
    isHistoricalUsed: false,
  };
}

const rejectShortCache = new Map<string, { records: RejectShortRecord[]; catalog: HistoricalRejectShortMap }>();
const inFlightPromises = new Map<string, Promise<{ records: RejectShortRecord[]; catalog: HistoricalRejectShortMap }>>();

/**
 * Executes Power Automate flow `WL_RejectShort` against the Power BI Semantic Model
 * using either explicit filter options or defaults from Setting -> Default Values.
 */
export async function loadRejectShortData(
  options?: LoadRejectShortOptions,
): Promise<{ records: RejectShortRecord[]; catalog: HistoricalRejectShortMap }> {
  const forceRefresh = options?.forceRefresh ?? false;
  const defaults = await loadDefaultValuesOrBuiltIn();

  const plant = options?.plant?.trim() || defaults.rejectShortPlant?.trim() || defaults.frequencyPlant?.trim() || 'PTBI';
  const dateRangeType: FrequencyDateRangeType = options?.dateRangeType ?? defaults.rejectShortDateRangeType;

  const hasExplicitDates =
    Boolean(options?.startDate && options?.endDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(options!.startDate!) &&
    /^\d{4}-\d{2}-\d{2}$/.test(options!.endDate!);

  const customStart = options?.startDate || defaults.rejectShortStartDate;
  const customEnd = options?.endDate || defaults.rejectShortEndDate;
  const { startDate, endDate, startParts, endParts } = hasExplicitDates
    ? computeFrequencyDateRange('custom', options!.startDate!, options!.endDate!)
    : computeFrequencyDateRange(dateRangeType, customStart, customEnd);

  const cacheKey = `${plant}|${startDate}|${endDate}`;
  const daxQuery = generateRejectShortDax({ plant, startParts, endParts });

  lastActiveRejectShortFilterParams = {
    plant,
    dateRangeType: hasExplicitDates ? 'custom' : dateRangeType,
    startDate,
    endDate,
    daxQuery,
  };

  if (!forceRefresh && rejectShortCache.has(cacheKey)) {
    return rejectShortCache.get(cacheKey)!;
  }

  if (!forceRefresh && inFlightPromises.has(cacheKey)) {
    return inFlightPromises.get(cacheKey)!;
  }

  const promise = (async () => {
    try {
      const payload = buildPlantDateFlowPayload(plant, startDate, endDate, daxQuery);
      console.log('[WL_RejectShort] Sending parameters to flow:', payload);
      const response = await WL_RejectShortService.Run(
        payload as unknown as Parameters<typeof WL_RejectShortService.Run>[0],
      );
      console.log('[WL_RejectShort] Response from flow:', response);

      if (!response.success) {
        throw new Error(response.error?.message || 'Call to Power Automate flow WL_RejectShort failed.');
      }

      const parsed = parseFlowResultRows(response.data?.result, 'WL_RejectShort');
      const records = parseRejectShortRows(parsed);
      const catalog = buildHistoricalRejectShortMap(records);
      const result = { records, catalog };
      rejectShortCache.set(cacheKey, result);
      return result;
    } finally {
      inFlightPromises.delete(cacheKey);
    }
  })();

  inFlightPromises.set(cacheKey, promise);
  return promise;
}

