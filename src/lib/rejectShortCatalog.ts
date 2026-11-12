import { WL_RejectShortService } from '../generated/services/WL_RejectShortService';
import { loadDefaultValuesOrBuiltIn, type FrequencyDateRangeType } from './defaultValuesStore';
import {
  buildPlantDateFlowPayload,
  cleanFloat,
  computeFrequencyDateRange,
  getField,
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

const rejectShortCache = new Map<string, RejectShortRecord[]>();
const inFlightPromises = new Map<string, Promise<{ records: RejectShortRecord[] }>>();

/**
 * Executes Power Automate flow `WL_RejectShort` against the Power BI Semantic Model
 * using either explicit filter options or defaults from Setting -> Default Values.
 */
export async function loadRejectShortData(
  options?: LoadRejectShortOptions,
): Promise<{ records: RejectShortRecord[] }> {
  const forceRefresh = options?.forceRefresh ?? false;
  const defaults = await loadDefaultValuesOrBuiltIn();

  const plant = options?.plant?.trim() || defaults.rejectShortPlant?.trim() || defaults.frequencyPlant?.trim() || 'PTBI';
  const dateRangeType: FrequencyDateRangeType = options?.dateRangeType ?? defaults.rejectShortDateRangeType;

  const customStart = options?.startDate || defaults.rejectShortStartDate;
  const customEnd = options?.endDate || defaults.rejectShortEndDate;
  const { startDate, endDate, startParts, endParts } =
    options?.startDate && options?.endDate
      ? computeFrequencyDateRange('custom', options.startDate, options.endDate)
      : computeFrequencyDateRange(dateRangeType, customStart, customEnd);

  const cacheKey = `${plant}|${startDate}|${endDate}`;
  const daxQuery = generateRejectShortDax({ plant, startParts, endParts });

  lastActiveRejectShortFilterParams = {
    plant,
    dateRangeType,
    startDate,
    endDate,
    daxQuery,
  };

  if (!forceRefresh && rejectShortCache.has(cacheKey)) {
    return { records: rejectShortCache.get(cacheKey)! };
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
      rejectShortCache.set(cacheKey, records);
      return { records };
    } finally {
      inFlightPromises.delete(cacheKey);
    }
  })();

  inFlightPromises.set(cacheKey, promise);
  return promise;
}

