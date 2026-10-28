import { WL_FrequencyService } from '../generated/services/WL_FrequencyService';
import { loadDefaultValuesOrBuiltIn, type FrequencyDateRangeType } from './defaultValuesStore';

export type FrequencyMode = 'manual' | 'historical';

export interface DateRangeParts {
  startDate: string;
  endDate: string;
  startParts: { year: number; month: number; day: number };
  endParts: { year: number; month: number; day: number };
}

export interface ActiveFrequencyFilterParams {
  plant: string;
  dateRangeType: FrequencyDateRangeType;
  startDate: string;
  endDate: string;
  daxQuery: string;
}

let lastActiveFilterParams: ActiveFrequencyFilterParams | null = null;

export function getActiveFrequencyFilterParams(): ActiveFrequencyFilterParams | null {
  return lastActiveFilterParams;
}

export function computeFrequencyDateRange(
  type: FrequencyDateRangeType = 'last7Days',
  customStart = '2026-10-20',
  customEnd = '2026-10-27',
): DateRangeParts {
  if (type === 'custom' && customStart && customEnd) {
    const [sY, sM, sD] = customStart.split('-').map(Number);
    const [eY, eM, eD] = customEnd.split('-').map(Number);
    if (sY && sM && sD && eY && eM && eD) {
      return {
        startDate: customStart,
        endDate: customEnd,
        startParts: { year: sY, month: sM, day: sD },
        endParts: { year: eY, month: eM, day: eD },
      };
    }
  }

  const now = new Date();
  const days = type === 'last14Days' ? 14 : type === 'last30Days' ? 30 : 7;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - days);

  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  return {
    startDate: fmt(start),
    endDate: fmt(end),
    startParts: { year: start.getFullYear(), month: start.getMonth() + 1, day: start.getDate() },
    endParts: { year: end.getFullYear(), month: end.getMonth() + 1, day: end.getDate() },
  };
}

export function generateDaxQuery({
  plant = 'PTBI',
  startDate,
  endDate,
  startParts,
  endParts,
}: {
  plant: string;
  startDate?: string;
  endDate?: string;
  startParts?: { year: number; month: number; day: number };
  endParts?: { year: number; month: number; day: number };
}): string {
  const sParts =
    startParts ??
    (startDate
      ? {
          year: Number(startDate.split('-')[0]),
          month: Number(startDate.split('-')[1]),
          day: Number(startDate.split('-')[2]),
        }
      : { year: 2026, month: 10, day: 20 });

  const eParts =
    endParts ??
    (endDate
      ? {
          year: Number(endDate.split('-')[0]),
          month: Number(endDate.split('-')[1]),
          day: Number(endDate.split('-')[2]),
        }
      : { year: 2026, month: 10, day: 27 });

  return `EVALUATE
ADDCOLUMNS(
    SUMMARIZECOLUMNS(
        DimZone[ZoneName],
        DimWIPOrder[SAPMachineTypeGroup],
        McGroup[Group],
        DimProduct[Construction],
        DimProduct[LayLength],
        DimProduct[TensileStrength],

        -- Filter Plant
        TREATAS({"${plant}"}, DimPlantRegion[PlantName]),

        -- 2. FILTER DATE BETWEEN (ANTARA TANGGAL AWAL & TANGGAL AKHIR)
        FILTER(
            ALL(DimDate[Date]), 
            DimDate[Date] >= DATE(${sParts.year}, ${sParts.month}, ${sParts.day}) && DimDate[Date] <= DATE(${eParts.year}, ${eParts.month}, ${eParts.day})
        ),

        -- Nilai Agregasi (Jika berupa Measure, cukup tulis di dalam tanda kurung siku [ ])
        "Fr/T", [Fracture/Ton (#)],
        "Def/T", [Def/Ton (#)],
        "Dies/T", [Die/Ton (#)],
        "TonProduced", [TonProduced]
    ),
    -- PENGGABUNGAN 4 KOLOM DENGAN PEMISAH "-" :
    "Group_Product_Info", 
        McGroup[Group] & "-" & 
        DimProduct[Construction] & "-" & 
        DimProduct[LayLength] & "-" & 
        DimProduct[TensileStrength],
    "Area", Left(DimZone[ZoneName], 2)
)`;
}


export interface FrequencyRecord {
  id: string;
  area: string;
  zoneName: string;
  sapMachineTypeGroup: string;
  group: string;
  construction: string;
  layLength: number | string;
  tensileStrength: string;
  tonProduced: number | null;
  fracturePerTon: number | null;
  defectPerTon: number | null;
  diesPerTon: number | null;
  groupProductInfo: string;
  raw: Record<string, any>;
}

export interface HistoricalFrequencyItem {
  mach: string;
  product: string;
  layLength: string;
  tensileStrength: string;
  fracturePerTon: number | null;
  defectPerTon: number | null;
  diesPerTon: number | null;
  tonProduced: number | null;
  recordCount: number;
}

export type HistoricalFrequencyMap = Map<string, HistoricalFrequencyItem>;

// In-memory cache singleton
let cachedCatalog: HistoricalFrequencyMap | null = null;
let cachedRecords: FrequencyRecord[] | null = null;
let fetchPromise: Promise<{ catalog: HistoricalFrequencyMap; records: FrequencyRecord[] }> | null = null;

function getField(row: Record<string, any>, ...candidates: string[]): any {
  for (const c of candidates) {
    if (row[c] !== undefined && row[c] !== null) return row[c];
    if (row[`[${c}]`] !== undefined && row[`[${c}]`] !== null) return row[`[${c}]`];
  }
  const cleanCandidates = candidates.map((c) => c.replace(/[[\]]/g, '').toLowerCase());
  for (const [key, val] of Object.entries(row)) {
    if (val === undefined || val === null) continue;
    const cleanKey = key.replace(/[[\]]/g, '').toLowerCase();
    for (const c of cleanCandidates) {
      if (cleanKey === c || cleanKey.endsWith(`.${c}`) || cleanKey.endsWith(`[${c}]`)) {
        return val;
      }
    }
  }
  return undefined;
}

function parseNumber(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : parseFloat(String(value).replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

/** Menghilangkan artefak binary floating point precision (seperti 14.000000000000002 -> 14) */
export function cleanFloat(value: any, precision = 4): number | null {
  const num = parseNumber(value);
  if (num === null) return null;
  return Number(num.toFixed(precision));
}

export function normalizeFrequencyKeyPart(val: any): string {
  if (val === null || val === undefined) return '';
  const str = String(val).trim().toLowerCase();
  const num = parseFloat(str.replace(/,/g, ''));
  if (Number.isFinite(num)) {
    // Normalisasi angka float agar 14 dan 14.000000000000002 menjadi "14"
    return String(Number(num.toFixed(4)));
  }
  return str;
}

/**
 * Membangun lookup key gabungan untuk relasi:
 * Mach (WL_Products) = McGroup (WL_Frequency)
 * Product (WL_Products) = Construction (WL_Frequency)
 * LayLength (WL_Products) = LayLength (WL_Frequency)
 * TensileGroup (WL_Products) = TensileStrength (WL_Frequency)
 */
export function buildFrequencyLookupKey(
  mach: string | undefined | null,
  product: string | undefined | null,
  layLength: number | string | undefined | null,
  tensileGroup: string | undefined | null,
): string {
  return [
    normalizeFrequencyKeyPart(mach),
    normalizeFrequencyKeyPart(product),
    normalizeFrequencyKeyPart(layLength),
    normalizeFrequencyKeyPart(tensileGroup),
  ].join('|');
}

export function parseFrequencyRows(rawItems: any[]): FrequencyRecord[] {
  return rawItems.map((raw, index) => {
    const zoneName = String(getField(raw, 'DimZone[ZoneName]', '[DimZone].[ZoneName]', 'ZoneName', 'DimZone') ?? '').trim();
    const sapMachineTypeGroup = String(
      getField(
        raw,
        'DimWIPOrder[SAPMachineTypeGroup]',
        '[DimWIPOrder].[SAPMachineTypeGroup]',
        'SAPMachineTypeGroup',
        'DimWIPOrder.SAPMachineTypeGroup',
        'MachineTypeGroup',
      ) ?? '',
    ).trim();
    const group = String(getField(raw, 'McGroup[Group]', '[McGroup].[Group]', 'Group', 'McGroup') ?? '').trim();
    const construction = String(getField(raw, 'DimProduct[Construction]', '[DimProduct].[Construction]', 'Construction', 'DimProduct') ?? '').trim();
    const layLengthRaw = getField(raw, 'DimProduct[LayLength]', '[DimProduct].[LayLength]', 'LayLength');
    const layLengthClean = cleanFloat(layLengthRaw, 2);
    const layLength = layLengthClean !== null ? layLengthClean : String(layLengthRaw ?? '').trim();
    const tensileStrength = String(getField(raw, 'DimProduct[TensileStrength]', '[DimProduct].[TensileStrength]', 'TensileStrength') ?? '').trim();

    let area = String(getField(raw, 'Area', '[Area]') ?? '').trim();
    if (!area && zoneName) {
      area = zoneName.slice(0, 2).toUpperCase();
    }

    let groupProductInfo = String(getField(raw, 'Group_Product_Info', '[Group_Product_Info]', 'GroupProductInfo') ?? '').trim();
    if (!groupProductInfo && (group || construction)) {
      groupProductInfo = `${group}-${construction}-${layLength}-${tensileStrength}`;
    } else {
      groupProductInfo = groupProductInfo.replace(/(\d+)\.0{5,}\d+/g, '$1');
    }

    const tonProduced = parseNumber(getField(raw, 'TonProduced', '[TonProduced]', 'Ton Produced', 'Ton_Produced'));
    const fracturePerTon = parseNumber(getField(raw, 'Fr/T', '[Fr/T]', 'Fracture/Ton (#)', 'Fracture/Ton', 'Fr_T'));
    const defectPerTon = parseNumber(getField(raw, 'Def/T', '[Def/T]', 'Def/Ton (#)', 'Defect/Ton', 'Def_T'));
    const diesPerTon = parseNumber(getField(raw, 'Dies/T', '[Dies/T]', 'Die/Ton (#)', 'Die/Ton', 'Dies_T'));

    return {
      id: `freq-${index}-${groupProductInfo || Math.random()}`,
      area,
      zoneName,
      sapMachineTypeGroup,
      group,
      construction,
      layLength,
      tensileStrength,
      tonProduced,
      fracturePerTon,
      defectPerTon,
      diesPerTon,
      groupProductInfo,
      raw,
    };
  });
}

/**
 * Mengelompokkan raw records ke dalam lookup map dengan agregasi weighted average by TonProduced
 */
export function buildHistoricalFrequencyMap(records: FrequencyRecord[]): HistoricalFrequencyMap {
  const groups = new Map<string, FrequencyRecord[]>();

  for (const rec of records) {
    const key = buildFrequencyLookupKey(rec.group, rec.construction, rec.layLength, rec.tensileStrength);
    if (!key || key === '|||') continue;
    const list = groups.get(key);
    if (list) list.push(rec);
    else groups.set(key, [rec]);
  }

  const catalog: HistoricalFrequencyMap = new Map();

  for (const [key, list] of groups.entries()) {
    let totalTon = 0;
    let sumFrWeighted = 0;
    let tonFr = 0;
    let sumDefWeighted = 0;
    let tonDef = 0;
    let sumDiesWeighted = 0;
    let tonDies = 0;

    const validFr: number[] = [];
    const validDef: number[] = [];
    const validDies: number[] = [];

    for (const r of list) {
      const ton = r.tonProduced != null && r.tonProduced > 0 ? r.tonProduced : 0;
      totalTon += ton;

      if (r.fracturePerTon != null && Number.isFinite(r.fracturePerTon)) {
        validFr.push(r.fracturePerTon);
        if (ton > 0) {
          sumFrWeighted += r.fracturePerTon * ton;
          tonFr += ton;
        }
      }

      if (r.defectPerTon != null && Number.isFinite(r.defectPerTon)) {
        validDef.push(r.defectPerTon);
        if (ton > 0) {
          sumDefWeighted += r.defectPerTon * ton;
          tonDef += ton;
        }
      }

      if (r.diesPerTon != null && Number.isFinite(r.diesPerTon)) {
        validDies.push(r.diesPerTon);
        if (ton > 0) {
          sumDiesWeighted += r.diesPerTon * ton;
          tonDies += ton;
        }
      }
    }

    const calcRate = (weightedSum: number, weightedTon: number, fallbackList: number[]): number | null => {
      if (weightedTon > 0) return Number((weightedSum / weightedTon).toFixed(4));
      if (fallbackList.length > 0) {
        const avg = fallbackList.reduce((acc, v) => acc + v, 0) / fallbackList.length;
        return Number(avg.toFixed(4));
      }
      return null;
    };

    const first = list[0];
    catalog.set(key, {
      mach: first.group,
      product: first.construction,
      layLength: String(first.layLength),
      tensileStrength: first.tensileStrength,
      fracturePerTon: calcRate(sumFrWeighted, tonFr, validFr),
      defectPerTon: calcRate(sumDefWeighted, tonDef, validDef),
      diesPerTon: calcRate(sumDiesWeighted, tonDies, validDies),
      tonProduced: totalTon > 0 ? Number(totalTon.toFixed(2)) : null,
      recordCount: list.length,
    });
  }

  return catalog;
}

/**
 * Mengambil data frekuensi dari Power Automate flow WL_Frequency dan menyimpannya di memory cache
 */
export async function loadFrequencyCatalog(forceRefresh = false): Promise<{ catalog: HistoricalFrequencyMap; records: FrequencyRecord[] }> {
  if (!forceRefresh && cachedCatalog && cachedRecords) {
    return { catalog: cachedCatalog, records: cachedRecords };
  }

  if (fetchPromise && !forceRefresh) {
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const defaults = await loadDefaultValuesOrBuiltIn();
      const rangeInfo = computeFrequencyDateRange(
        defaults.frequencyDateRangeType,
        defaults.frequencyStartDate,
        defaults.frequencyEndDate,
      );
      const daxQuery = generateDaxQuery({
        plant: defaults.frequencyPlant,
        startParts: rangeInfo.startParts,
        endParts: rangeInfo.endParts,
      });

      lastActiveFilterParams = {
        plant: defaults.frequencyPlant,
        dateRangeType: defaults.frequencyDateRangeType,
        startDate: rangeInfo.startDate,
        endDate: rangeInfo.endDate,
        daxQuery,
      };

      const payload = {
        // Parameter names as defined in PowerApps (V2) trigger
        PlantName: defaults.frequencyPlant,
        StartDate: rangeInfo.startDate,
        EndDate: rangeInfo.endDate,
        // camelCase aliases
        plantName: defaults.frequencyPlant,
        startDate: rangeInfo.startDate,
        endDate: rangeInfo.endDate,
        plant: defaults.frequencyPlant,
        // Power Automate internal type keys for Text and Date inputs
        text: defaults.frequencyPlant,
        date: rangeInfo.startDate,
        date_1: rangeInfo.endDate,
        text_1: rangeInfo.startDate,
        text_2: rangeInfo.endDate,
        // Full query string
        daxQuery,
        DaxQuery: daxQuery,
      };

      console.log('[WL_Frequency] Mengirim parameter ke flow:', payload);
      const response = await WL_FrequencyService.Run(payload as any);
      console.log('[WL_Frequency] Respon dari flow:', response);

      if (!response.success) {
        throw new Error(response.error?.message || 'Pemanggilan Power Automate flow WL_Frequency gagal.');
      }

      const rawResult = response.data?.result;

      if (!rawResult || rawResult === '[]') {
        console.warn('[WL_Frequency] Flow mengembalikan data kosong (rawResult):', rawResult);
        const emptyCatalog: HistoricalFrequencyMap = new Map();
        cachedCatalog = emptyCatalog;
        cachedRecords = [];
        return { catalog: emptyCatalog, records: [] };
      }

      let parsed: any[] = [];
      if (typeof rawResult === 'string') {
        try {
          parsed = JSON.parse(rawResult);
        } catch {
          throw new Error('Gagal mem-parse output result dari flow sebagai JSON: ' + rawResult.slice(0, 150));
        }
      } else if (Array.isArray(rawResult)) {
        parsed = rawResult;
      }

      if (!Array.isArray(parsed)) {
        throw new Error('Hasil query bukan berupa array baris data.');
      }

      const records = parseFrequencyRows(parsed);
      const catalog = buildHistoricalFrequencyMap(records);

      cachedRecords = records;
      cachedCatalog = catalog;

      return { catalog, records };
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

/**
 * Mencari historical frequency berdasarkan spesifikasi produk
 */
export function lookupHistoricalFrequency(
  catalog: HistoricalFrequencyMap | null | undefined,
  mach: string | undefined | null,
  product: string | undefined | null,
  layLength: number | string | undefined | null,
  tensileGroup: string | undefined | null,
): HistoricalFrequencyItem | null {
  if (!catalog) return null;
  const key = buildFrequencyLookupKey(mach, product, layLength, tensileGroup);
  return catalog.get(key) ?? null;
}

export interface EffectiveFrequencyResult {
  fracturePerTon: number;
  diesPerTon: number;
  defectsPerTon: number;
  isHistoricalUsed: boolean;
  isFallbackToManual: boolean;
  matchedItem: HistoricalFrequencyItem | null;
}

/**
 * Memutuskan nilai frequency yang digunakan:
 * Jika mode = 'historical' dan data ada di WL_Frequency, gunakan data WL_Frequency.
 * Jika tidak ada di WL_Frequency, fallback ke nilai manual dari WL_Products.
 */
export function resolveEffectiveFrequencies({
  manual,
  lookupParams,
  mode,
  catalog,
}: {
  manual: {
    fracturePerTon: number;
    diesPerTon: number;
    defectsPerTon: number;
  };
  lookupParams: {
    mach: string | undefined | null;
    product: string | undefined | null;
    layLength: number | string | undefined | null;
    tensileGroup: string | undefined | null;
  };
  mode: FrequencyMode;
  catalog: HistoricalFrequencyMap | null | undefined;
}): EffectiveFrequencyResult {
  if (mode !== 'historical' || !catalog) {
    return {
      fracturePerTon: manual.fracturePerTon,
      diesPerTon: manual.diesPerTon,
      defectsPerTon: manual.defectsPerTon,
      isHistoricalUsed: false,
      isFallbackToManual: false,
      matchedItem: null,
    };
  }

  const matched = lookupHistoricalFrequency(
    catalog,
    lookupParams.mach,
    lookupParams.product,
    lookupParams.layLength,
    lookupParams.tensileGroup,
  );

  if (!matched) {
    return {
      fracturePerTon: manual.fracturePerTon,
      diesPerTon: manual.diesPerTon,
      defectsPerTon: manual.defectsPerTon,
      isHistoricalUsed: false,
      isFallbackToManual: true,
      matchedItem: null,
    };
  }

  return {
    fracturePerTon: matched.fracturePerTon !== null ? matched.fracturePerTon : manual.fracturePerTon,
    diesPerTon: matched.diesPerTon !== null ? matched.diesPerTon : manual.diesPerTon,
    defectsPerTon: matched.defectPerTon !== null ? matched.defectPerTon : manual.defectsPerTon,
    isHistoricalUsed: true,
    isFallbackToManual: false,
    matchedItem: matched,
  };
}
