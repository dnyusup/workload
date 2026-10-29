import { WL_ActualOutputService } from '../generated/services/WL_ActualOutputService';
import { saveWwdSpecsFromActualOutput } from './wwdSpecStore';

export interface ActualOutputRecord {
  id: string;
  plantName: string;
  date: string;
  shift: number;
  zoneName: string;
  area: string;
  group: string;
  machineType: string;
  sapMachineTypeGroup: string;
  machineName: string;
  productGroup: string;
  bkProductNo: string;
  spgCode: string;
  constTG: string;
  construction: string;
  layLength: number | string;
  tensileStrength: string;
  spoolType: string;
  standardLength: number | string;
  standardSpeed: number | string;
  linerDensity: number | null;
  constructionDetail: string;

  // Aggregations
  doffedSpoolCount: number | null;
  doffedRejectSpoolCount: number | null;
  aQualityKG: number | null;
  shortLengthAQualityKG: number | null;
  totalRejectedKG: number | null;
  totalProducedKG: number | null;
  effectiveHours: number | null; // raw minutes from MES DB
  effectiveHoursInHours: number | null; // converted to hours (effectiveHours / 60)
  totalFracture: number | null;
  diesCount: number | null;
  headDiesCount: number | null;

  // Measures & KPI Rates
  totalDefect: number | null;
  effectiveHrs: number | null;
  scheduledHrs: number | null;
  tonProduced: number | null;
  oee: number | null; // (effectiveHours / 60) / scheduledHrs * 100
  fracturePerTon: number | null; // totalFracture / tonProduced
  defectPerTon: number | null; // totalDefect / tonProduced
  diesPerTon: number | null; // diesCount / tonProduced

  raw: Record<string, any>;
}

export interface ActualOutputFilterParams {
  plant: string;
  date: string;
  shift: number;
}

export function generateActualOutputDax(params: ActualOutputFilterParams): string {
  const { plant, date, shift } = params;
  return `EVALUATE
ADDCOLUMNS(
SUMMARIZECOLUMNS(
    -- 1. DIMENSI GROUP BY
    DimPlantRegion[PlantName],
    DimDate[Date],
    DimShift[DaySequenceNo],
    DimZone[ZoneName],
    McGroup[Group],
    DimMachine[MachineType],
    DimWIPOrder[SAPMachineTypeGroup],
    DimMachine[Name],
    DimProduct[ProductGroup],
    DimProduct[BK_ProductNo],
    DimProduct[SPGCode],
    DimProduct[Const+TG],
    DimProduct[Construction],
    DimProduct[LayLength],
    DimProduct[TensileStrength],
    DimProduct[SpoolType],
    DimProduct[StandardLength],
    DimWIPOrder[StandardSpeed],
    DimProduct[LinerDensity],

    -- 2. FILTER PLANT, DATE & SHIFT:
    TREATAS({"${plant}"}, DimPlantRegion[PlantName]),
    FILTER(
        ALL(DimDate[Date]), 
        DimDate[Date] = DATEVALUE("${date}")
    ),
    TREATAS({${shift}}, DimShift[DaySequenceNo]),

    -- 3. NILAI AGREGASI
    "DoffedSpoolCount", SUM(FactMachineProductivity[DoffedSpoolCount]),
    "DoffedRejectSpoolCount", SUM(FactMachineProductivity[DoffedRejectSpoolCount]),
    "AQualityKG", SUM(FactMachineProductivity[AQualityKG]),
    "ShortLengthAQualityKG", SUM(FactMachineEmployeeProductivity[ShortLengthAQualityKG]),
    "TotalRejectedKG", SUM(FactMachineProductivity[TotalRejectedKG]),
    "TotalProducedKG", SUM(FactMachineProductivity[TotalProducedKG]),
    "EffectiveHours", SUM(FactMachineEmployeeProductivity[EffectiveHours]),
    "TotalFracture", SUM(FactMachineProductivity[TotalFracture]),
    "DiesCount", SUM(FactMachineProductivity[DiesCount]),
    "HeadDiesCount", SUM(FactMachineProductivity[HeadDiesCount]),
    
    -- 4. MEASURES RESMI
    "TotalDefect", [TotalDefect],
    "EffectiveHrs", [Effective Time (Hrs)],
    "ScheduledHrs", [Scheduled Time (Hrs)],
    "TonProduced", [TonProduced]
),

    "ConstructionDetail", 
        IF(
			(OR(McGroup[Group] = "BFM",McGroup[Group] = "KT")),
			DimWIPOrder[SAPMachineTypeGroup],
			IF(
				McGroup[Group] = "SP",
				"HENX",
				McGroup[Group]
			)
		) & "-" & 
        DimProduct[Construction] & "-" & 
        If(ISBLANK(DimProduct[LayLength]),0,DimProduct[LayLength]) & "-" & 
        DimProduct[TensileStrength] & "-" &
        IF(
            LEFT(DimProduct[SpoolType], 2) = "BS",
            LEFT(DimProduct[SpoolType], 4),
            DimProduct[SpoolType]
        ) & "-" &
        DimProduct[StandardLength] & "-" &
        DimWIPOrder[StandardSpeed],
        
    "Area", Left(DimZone[ZoneName], 2)
)`;
}

function getField(obj: any, ...keys: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    const stripped = k.replace(/^\[|\]$/g, '').replace(/.*\[(.*)\]/, '$1');
    if (obj[stripped] !== undefined && obj[stripped] !== null) return obj[stripped];
  }
  return undefined;
}

function parseNumber(val: any): number | null {
  if (val === null || val === undefined || val === '') return null;
  const num = typeof val === 'number' ? val : Number(String(val).replace(/,/g, '').trim());
  return isNaN(num) ? null : num;
}

function cleanFloat(val: any, decimals = 2): number | null {
  const n = parseNumber(val);
  if (n === null) return null;
  return Number(n.toFixed(decimals));
}

export function parseActualOutputRows(rawItems: any[]): ActualOutputRecord[] {
  const records = rawItems.map((raw, index) => {
    const plantName = String(getField(raw, 'DimPlantRegion[PlantName]', '[DimPlantRegion].[PlantName]', 'PlantName') ?? '').trim();
    const date = String(getField(raw, 'DimDate[Date]', '[DimDate].[Date]', 'Date') ?? '').trim();
    const shift = parseNumber(getField(raw, 'DimShift[DaySequenceNo]', '[DimShift].[DaySequenceNo]', 'DaySequenceNo', 'Shift')) ?? 1;
    const zoneName = String(getField(raw, 'DimZone[ZoneName]', '[DimZone].[ZoneName]', 'ZoneName') ?? '').trim();
    let area = String(getField(raw, 'Area', '[Area]') ?? '').trim();
    if (!area && zoneName) {
      area = zoneName.slice(0, 2).toUpperCase();
    }

    const group = String(getField(raw, 'McGroup[Group]', '[McGroup].[Group]', 'Group') ?? '').trim();
    const machineType = String(getField(raw, 'DimMachine[MachineType]', '[DimMachine].[MachineType]', 'MachineType') ?? '').trim();
    const sapMachineTypeGroup = String(getField(raw, 'DimWIPOrder[SAPMachineTypeGroup]', '[DimWIPOrder].[SAPMachineTypeGroup]', 'SAPMachineTypeGroup') ?? '').trim();
    const machineName = String(getField(raw, 'DimMachine[Name]', '[DimMachine].[Name]', 'MachineName', 'Name') ?? '').trim();

    const productGroup = String(getField(raw, 'DimProduct[ProductGroup]', '[DimProduct].[ProductGroup]', 'ProductGroup') ?? '').trim();
    const bkProductNo = String(getField(raw, 'DimProduct[BK_ProductNo]', '[DimProduct].[BK_ProductNo]', 'BK_ProductNo') ?? '').trim();
    const spgCode = String(getField(raw, 'DimProduct[SPGCode]', '[DimProduct].[SPGCode]', 'SPGCode') ?? '').trim();
    const constTG = String(getField(raw, 'DimProduct[Const+TG]', '[DimProduct].[Const+TG]', 'Const+TG') ?? '').trim();
    const construction = String(getField(raw, 'DimProduct[Construction]', '[DimProduct].[Construction]', 'Construction') ?? '').trim();

    const layLengthRaw = getField(raw, 'DimProduct[LayLength]', '[DimProduct].[LayLength]', 'LayLength');
    const layLengthClean = cleanFloat(layLengthRaw, 2);
    const layLength = layLengthClean !== null ? layLengthClean : String(layLengthRaw ?? '').trim();

    const tensileStrength = String(getField(raw, 'DimProduct[TensileStrength]', '[DimProduct].[TensileStrength]', 'TensileStrength') ?? '').trim();
    const spoolType = String(getField(raw, 'DimProduct[SpoolType]', '[DimProduct].[SpoolType]', 'SpoolType') ?? '').trim();

    const standardLengthRaw = getField(raw, 'DimProduct[StandardLength]', '[DimProduct].[StandardLength]', 'StandardLength');
    const standardLengthClean = cleanFloat(standardLengthRaw, 0);
    const standardLength = standardLengthClean !== null ? standardLengthClean : String(standardLengthRaw ?? '').trim();

    const standardSpeedRaw = getField(raw, 'DimWIPOrder[StandardSpeed]', '[DimWIPOrder].[StandardSpeed]', 'StandardSpeed');
    const standardSpeedClean = cleanFloat(standardSpeedRaw, 1);
    const standardSpeed = standardSpeedClean !== null ? standardSpeedClean : String(standardSpeedRaw ?? '').trim();

    const linerDensityRaw = getField(raw, 'DimProduct[LinerDensity]', '[DimProduct].[LinerDensity]', 'LinerDensity', 'LinearDensity');
    const linerDensity = cleanFloat(linerDensityRaw, 4);

    let constructionDetail = String(getField(raw, 'ConstructionDetail', '[ConstructionDetail]') ?? '').trim();
    if (!constructionDetail && group && construction) {
      const prefix =
        group === 'BFM' || group === 'KT'
          ? sapMachineTypeGroup || group
          : group === 'SP'
          ? 'HENX'
          : group;
      const lay = layLength === '' || layLength === null || layLength === undefined ? 0 : layLength;
      const spoolNorm = spoolType.startsWith('BS') ? spoolType.slice(0, 4) : spoolType;
      constructionDetail = `${prefix}-${construction}-${lay}-${tensileStrength}-${spoolNorm}-${standardLength}-${standardSpeed}`;
    }

    const doffedSpoolCount = parseNumber(getField(raw, 'DoffedSpoolCount', '[DoffedSpoolCount]'));
    const doffedRejectSpoolCount = parseNumber(getField(raw, 'DoffedRejectSpoolCount', '[DoffedRejectSpoolCount]'));
    const aQualityKG = parseNumber(getField(raw, 'AQualityKG', '[AQualityKG]'));
    const shortLengthAQualityKG = parseNumber(getField(raw, 'ShortLengthAQualityKG', '[ShortLengthAQualityKG]'));
    const totalRejectedKG = parseNumber(getField(raw, 'TotalRejectedKG', '[TotalRejectedKG]'));
    const totalProducedKG = parseNumber(getField(raw, 'TotalProducedKG', '[TotalProducedKG]'));
    const effectiveHoursRaw = parseNumber(getField(raw, 'EffectiveHours', '[EffectiveHours]', 'Effective Time (Hrs)', 'EffectiveHrs'));
    const effectiveHours = effectiveHoursRaw;
    // Nilai EffectiveHours saat ini dari DB MES berupa menit, bagi 60 agar menjadi jam:
    const effectiveHoursInHours = effectiveHoursRaw !== null ? Number((effectiveHoursRaw / 60).toFixed(2)) : null;

    const totalFracture = parseNumber(getField(raw, 'TotalFracture', '[TotalFracture]'));
    const diesCount = parseNumber(getField(raw, 'DiesCount', '[DiesCount]'));
    const headDiesCount = parseNumber(getField(raw, 'HeadDiesCount', '[HeadDiesCount]'));

    const totalDefect = parseNumber(getField(raw, 'TotalDefect', '[TotalDefect]'));
    const effectiveHrs = parseNumber(getField(raw, 'EffectiveHrs', '[EffectiveHrs]', 'Effective Time (Hrs)'));
    const scheduledHrs = parseNumber(getField(raw, 'ScheduledHrs', '[ScheduledHrs]', 'Scheduled Time (Hrs)'));

    let tonProduced = parseNumber(getField(raw, 'TonProduced', '[TonProduced]'));
    if (tonProduced === null && totalProducedKG !== null && totalProducedKG > 0) {
      tonProduced = Number((totalProducedKG / 1000).toFixed(3));
    }

    // OEE = (Eff Hrs in hours / Sched Hrs) * 100
    const oee =
      scheduledHrs && scheduledHrs > 0 && effectiveHoursInHours !== null
        ? Number(((effectiveHoursInHours / scheduledHrs) * 100).toFixed(1))
        : null;

    // Rates per Ton Produced
    const fracturePerTon =
      tonProduced && tonProduced > 0 && totalFracture !== null
        ? Number((totalFracture / tonProduced).toFixed(3))
        : null;

    const defectPerTon =
      tonProduced && tonProduced > 0 && totalDefect !== null
        ? Number((totalDefect / tonProduced).toFixed(3))
        : null;

    // Rumus Dies/T = (DiesCount + HeadDiesCount) / Ton
    const totalDiesCombined = (diesCount ?? 0) + (headDiesCount ?? 0);
    const diesPerTon =
      tonProduced && tonProduced > 0 && (diesCount !== null || headDiesCount !== null)
        ? Number((totalDiesCombined / tonProduced).toFixed(3))
        : null;

    return {
      id: `act-out-${index}-${machineName}-${constructionDetail || Math.random()}`,
      plantName,
      date,
      shift,
      zoneName,
      area,
      group,
      machineType,
      sapMachineTypeGroup,
      machineName,
      productGroup,
      bkProductNo,
      spgCode,
      constTG,
      construction,
      layLength,
      tensileStrength,
      spoolType,
      standardLength,
      standardSpeed,
      linerDensity,
      constructionDetail,
      doffedSpoolCount,
      doffedRejectSpoolCount,
      aQualityKG,
      shortLengthAQualityKG,
      totalRejectedKG,
      totalProducedKG,
      effectiveHours,
      effectiveHoursInHours,
      totalFracture,
      diesCount,
      headDiesCount,
      totalDefect,
      effectiveHrs,
      scheduledHrs,
      tonProduced,
      oee,
      fracturePerTon,
      defectPerTon,
      diesPerTon,
      raw,
    };
  });
  saveWwdSpecsFromActualOutput(records);
  return records;
}

const cacheMap = new Map<string, ActualOutputRecord[]>();

export async function loadActualOutputData(
  params: ActualOutputFilterParams,
  forceRefresh = false,
): Promise<{ records: ActualOutputRecord[]; daxQuery: string }> {
  const { plant, date, shift } = params;
  const cacheKey = `${plant}|${date}|${shift}`;

  if (!forceRefresh && cacheMap.has(cacheKey)) {
    return {
      records: cacheMap.get(cacheKey)!,
      daxQuery: generateActualOutputDax(params),
    };
  }

  const payload = {
    text: plant,
    date,
    number: Number(shift),
    PlantName: plant,
    Date: date,
    Shift: Number(shift),
  };

  console.log('[WL_ActualOutput] Sending parameters to flow:', payload);
  const response = await WL_ActualOutputService.Run(payload as any);
  console.log('[WL_ActualOutput] Response from flow:', response);

  if (!response.success) {
    throw new Error(response.error?.message || 'Call to Power Automate flow WL_ActualOutput failed.');
  }

  const rawResult = response.data?.result;

  if (!rawResult || rawResult === '[]') {
    console.warn('[WL_ActualOutput] Flow returned empty data:', rawResult);
    cacheMap.set(cacheKey, []);
    return { records: [], daxQuery: generateActualOutputDax(params) };
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
    throw new Error('Query result is not an array of rows.');
  }

  const records = parseActualOutputRows(parsed);
  cacheMap.set(cacheKey, records);
  return {
    records,
    daxQuery: generateActualOutputDax(params),
  };
}
