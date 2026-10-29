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
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);

  if (type === 'last3Months') {
    start.setMonth(start.getMonth() - 3);
  } else if (type === 'last6Months') {
    start.setMonth(start.getMonth() - 6);
  } else if (type === 'last1Year') {
    start.setFullYear(start.getFullYear() - 1);
  } else {
    const days = type === 'last14Days' ? 14 : type === 'last30Days' ? 30 : 7;
    start.setDate(start.getDate() - days);
  }

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
        McGroup[Group],
        DimProduct[Construction],
        DimProduct[LayLength],
        DimProduct[TensileStrength],

        -- Filter Plant
        TREATAS({"${plant}"}, DimPlantRegion[PlantName]),

        -- 2. FILTER DATE BETWEEN (START DATE & END DATE)
        FILTER(
            ALL(DimDate[Date]), 
            DimDate[Date] >= DATE(${sParts.year}, ${sParts.month}, ${sParts.day}) && DimDate[Date] <= DATE(${eParts.year}, ${eParts.month}, ${eParts.day})
        ),

        -- Aggregation Values (For Measure, enclose in square brackets [ ])
        "Fr/T", [Fracture/Ton (#)],
        "Def/T", [Def/Ton (#)],
        "Dies/T", [Die/Ton (#)],
        "TonProduced", [TonProduced]
    ),
    -- MERGE 4 COLUMNS WITH "-" DELIMITER:
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
  sapMachineTypeGroup?: string;
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
  // Only normalize values that are purely decimal numbers with a dot (e.g. "14.000000000000002" -> "14")
  // Do NOT parse strings that are cord/product specifications like "1x0.32" (parseFloat gives 1)
  // or comma decimals like "0,280" (which stripped comma to 280)!
  if (/^-?\d+\.\d+$/.test(str)) {
    const num = parseFloat(str);
    if (Number.isFinite(num)) {
      return String(Number(num.toFixed(4)));
    }
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

export interface LoadFrequencyOptions {
  forceRefresh?: boolean;
  plant?: string;
  startDate?: string;
  endDate?: string;
  dateRangeType?: FrequencyDateRangeType;
}

const catalogCacheMap = new Map<string, { catalog: HistoricalFrequencyMap; records: FrequencyRecord[] }>();
const inFlightPromises = new Map<string, Promise<{ catalog: HistoricalFrequencyMap; records: FrequencyRecord[] }>>();

/**
 * Mengambil data frekuensi dari Power Automate flow WL_Frequency dan menyimpannya di memory cache.
 * Mendukung opsi custom date range per production setup.
 */
export async function loadFrequencyCatalog(
  optionsOrForceRefresh: boolean | LoadFrequencyOptions = false,
): Promise<{ catalog: HistoricalFrequencyMap; records: FrequencyRecord[] }> {
  const options: LoadFrequencyOptions =
    typeof optionsOrForceRefresh === 'boolean'
      ? { forceRefresh: optionsOrForceRefresh }
      : (optionsOrForceRefresh ?? {});

  const defaults = await loadDefaultValuesOrBuiltIn();
  const plant = options.plant || defaults.frequencyPlant || 'PTBI';

  let startDate: string;
  let endDate: string;
  let startParts: { year: number; month: number; day: number };
  let endParts: { year: number; month: number; day: number };

  if (
    options.startDate &&
    options.endDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(options.startDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(options.endDate)
  ) {
    const s = options.startDate.split('-').map(Number);
    const e = options.endDate.split('-').map(Number);
    if (!isNaN(s[0]) && !isNaN(s[1]) && !isNaN(s[2]) && !isNaN(e[0]) && !isNaN(e[1]) && !isNaN(e[2])) {
      startDate = options.startDate;
      endDate = options.endDate;
      startParts = { year: s[0], month: s[1], day: s[2] };
      endParts = { year: e[0], month: e[1], day: e[2] };
    } else {
      const rangeInfo = computeFrequencyDateRange(
        defaults.frequencyDateRangeType,
        defaults.frequencyStartDate,
        defaults.frequencyEndDate,
      );
      startDate = rangeInfo.startDate;
      endDate = rangeInfo.endDate;
      startParts = rangeInfo.startParts;
      endParts = rangeInfo.endParts;
    }
  } else {
    const rangeInfo = computeFrequencyDateRange(
      defaults.frequencyDateRangeType,
      defaults.frequencyStartDate,
      defaults.frequencyEndDate,
    );
    startDate = rangeInfo.startDate;
    endDate = rangeInfo.endDate;
    startParts = rangeInfo.startParts;
    endParts = rangeInfo.endParts;
  }

  const cacheKey = `${plant}|${startDate}|${endDate}`;

  if (!options.forceRefresh && catalogCacheMap.has(cacheKey)) {
    return catalogCacheMap.get(cacheKey)!;
  }

  if (inFlightPromises.has(cacheKey) && !options.forceRefresh) {
    return inFlightPromises.get(cacheKey)!;
  }

  const promise = (async () => {
    try {
      const daxQuery = generateDaxQuery({
        plant,
        startParts,
        endParts,
      });

      lastActiveFilterParams = {
        plant,
        dateRangeType: options.dateRangeType || (options.startDate ? 'custom' : defaults.frequencyDateRangeType),
        startDate,
        endDate,
        daxQuery,
      };

      const payload = {
        // Parameter names as defined in PowerApps (V2) trigger
        PlantName: plant,
        StartDate: startDate,
        EndDate: endDate,
        // camelCase aliases
        plantName: plant,
        startDate,
        endDate,
        plant,
        // Power Automate internal type keys for Text and Date inputs
        text: plant,
        date: startDate,
        date_1: endDate,
        text_1: startDate,
        text_2: endDate,
        // Full query string
        daxQuery,
        DaxQuery: daxQuery,
      };

      console.log('[WL_Frequency] Sending parameters to flow:', payload);
      const response = await WL_FrequencyService.Run(payload as any);
      console.log('[WL_Frequency] Response from flow:', response);

      if (!response.success) {
        throw new Error(response.error?.message || 'Call to Power Automate flow WL_Frequency failed.');
      }

      const rawResult = response.data?.result;

      if (!rawResult || rawResult === '[]') {
        console.warn('[WL_Frequency] Flow returned empty data (rawResult):', rawResult);
        const emptyCatalog: HistoricalFrequencyMap = new Map();
        const emptyRes = { catalog: emptyCatalog, records: [] as FrequencyRecord[] };
        catalogCacheMap.set(cacheKey, emptyRes);
        return emptyRes;
      }

      let parsed: any[] = [];
      if (typeof rawResult === 'string') {
        try {
          parsed = JSON.parse(rawResult);
        } catch {
          throw new Error('Failed to parse flow output result as JSON: ' + rawResult.slice(0, 150));
        }
      } else if (Array.isArray(rawResult)) {
        parsed = rawResult;
      }

      if (!Array.isArray(parsed)) {
        throw new Error('Query result is not an array of data rows.');
      }

      const records = parseFrequencyRows(parsed);
      const catalog = buildHistoricalFrequencyMap(records);

      const result = { catalog, records };
      catalogCacheMap.set(cacheKey, result);

      return result;
    } finally {
      inFlightPromises.delete(cacheKey);
    }
  })();

  inFlightPromises.set(cacheKey, promise);
  return promise;
}

/**
 * Mencari historical frequency berdasarkan spesifikasi produk.
 * Menjaga ketat spesifikasi produk (1X0.32, 0.32, dan 0,320 adalah produk berbeda).
 * Mendukung variasi tanda desimal koma vs titik (0,280 <-> 0.280) serta LayLength blank <-> 0 untuk WWD.
 */
export function lookupHistoricalFrequency(
  catalog: HistoricalFrequencyMap | null | undefined,
  mach: string | undefined | null,
  product: string | undefined | null,
  layLength: number | string | undefined | null,
  tensileGroup: string | undefined | null,
): HistoricalFrequencyItem | null {
  if (!catalog) return null;

  // 1. Direct lookup
  const key = buildFrequencyLookupKey(mach, product, layLength, tensileGroup);
  const direct = catalog.get(key);
  if (direct) return direct;

  // 2. Check alternative LayLength representation:
  // For WWD or zero-lay machines, DimProduct[LayLength] in Power BI MES is often BLANK/NULL (""),
  // whereas in WL_Products it is stored as 0 ("0").
  const normLay = normalizeFrequencyKeyPart(layLength);
  const altLay = normLay === '0' || normLay === '' ? (normLay === '0' ? '' : '0') : null;
  if (altLay !== null) {
    const keyAltLay = buildFrequencyLookupKey(mach, product, altLay, tensileGroup);
    const matchAltLay = catalog.get(keyAltLay);
    if (matchAltLay) return matchAltLay;
  }

  // 3. Check comma <-> dot decimal separator in product spec (e.g. "0,280" vs "0.280")
  // Strictly preserves product identity (e.g. 1X0.32, 0.32, and 0,320 are strictly separate)
  const prodStr = String(product ?? '').trim();
  let altProduct: string | null = null;
  if (prodStr.includes(',')) {
    altProduct = prodStr.replace(/,/g, '.');
  } else if (prodStr.includes('.')) {
    altProduct = prodStr.replace(/\./g, ',');
  }

  if (altProduct) {
    const keyAltProd = buildFrequencyLookupKey(mach, altProduct, layLength, tensileGroup);
    const matchAltProd = catalog.get(keyAltProd);
    if (matchAltProd) return matchAltProd;

    if (altLay !== null) {
      const keyBoth = buildFrequencyLookupKey(mach, altProduct, altLay, tensileGroup);
      const matchBoth = catalog.get(keyBoth);
      if (matchBoth) return matchBoth;
    }
  }

  return null;
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
