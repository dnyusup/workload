import type { ActualOutputRecord } from './actualOutputCatalog';

export interface DynamicSpecData {
  constructionDetail: string;
  baseConstruction: string;
  area?: string;
  machineCode?: string;
  product?: string;
  standardSpeed: number;
  standardLength: number;
  linearDensity: number;
  layLength: number;
  tensileStrength: string;
  spoolType: string;
  numberOfWires?: number;
  fracturePerTon?: number | null;
  diesPerTon?: number | null;
  defectPerTon?: number | null;
}

export type WwdSpecData = DynamicSpecData;

const STORAGE_KEY = 'wl_dynamic_specs_catalog';
const LEGACY_STORAGE_KEY = 'wl_wwd_specs_catalog';

// In-memory cache
const cache = new Map<string, DynamicSpecData>();

function loadFromStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v === 'object') {
          cache.set(k.toLowerCase(), v as DynamicSpecData);
        }
      }
    }
  } catch (e) {
    console.warn('[dynamicSpecStore] Failed to load specs from localStorage:', e);
  }
}

function persistToStorage(): void {
  try {
    const obj: Record<string, DynamicSpecData> = {};
    for (const [k, v] of cache.entries()) {
      obj[k] = v;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (e) {
    console.warn('[dynamicSpecStore] Failed to save specs to localStorage:', e);
  }
}

// Initialize on module load
loadFromStorage();

/**
 * Checks whether an MES record or machine corresponds to Area WW or McGroup WWD.
 */
export function isWwdRecord(rec: { area?: string; group?: string; constructionDetail?: string }): boolean {
  const area = (rec.area ?? '').trim().toUpperCase();
  const group = (rec.group ?? '').trim().toUpperCase();
  const code = (rec.constructionDetail ?? '').trim().toUpperCase();
  return area === 'WW' || group === 'WWD' || code.startsWith('WWD-');
}

/**
 * Checks whether a construction code string represents a WWD construction.
 */
export function isWwdConstruction(code: string | undefined): boolean {
  if (!code) return false;
  const upper = code.trim().toUpperCase();
  return upper.startsWith('WWD-') || upper.startsWith('WW-');
}

/**
 * Extracts base construction without standard length and standard speed
 * (strips only the last 2 numeric segments: standardLength and standardSpeed).
 * Retains feature extensions like DUAL, TRIPLE, etc. Always uppercase.
 */
export function extractBaseConstruction(fullCode: string): string {
  const parts = fullCode.trim().split('-');
  if (parts.length > 2) {
    return parts.slice(0, parts.length - 2).join('-').toUpperCase();
  }
  return fullCode.trim().toUpperCase();
}

export const extractWwdBaseConstruction = extractBaseConstruction;

/**
 * Parses and synthesizes a DynamicSpecData from a 7-segment ConstructionDetail code
 * with mathematical fallback for linear density if not cached.
 */
export function synthesizeDynamicSpec(
  code: string,
  fallbackRates: { fracture?: number; dies?: number; defect?: number } = {},
): DynamicSpecData {
  const existing = cache.get(code.trim().toLowerCase());
  if (existing) return existing;

  const parts = code.trim().split('-');
  const baseConstruction = extractBaseConstruction(code);
  const machCode = parts[0] ?? '';
  const construction = parts[1] ?? '';
  const layLength = Number(parts[2]) || 0;
  const tensileStrength = parts[3] ?? '';
  const spoolType = parts[4] ?? 'BS40';
  const standardLength = Number(parts[5]) || 0;
  const standardSpeed = Number(parts[6]) || 0;

  // Approximate linear density for steel wire (density = 7.85 g/cm3)
  // Linear density (g/m) = Area (mm2) * 7.85 = (pi/4 * d^2) * 7.85
  const diam = parseFloat(construction);
  let linearDensity = 0;
  if (Number.isFinite(diam) && diam > 0) {
    const areaMm2 = (Math.PI / 4) * Math.pow(diam, 2);
    linearDensity = Number((areaMm2 * 7.85).toFixed(4));
  }

  const upperMach = machCode.toUpperCase();
  const area = upperMach.startsWith('WWD') || upperMach.startsWith('WW')
    ? 'WW'
    : (upperMach.startsWith('BU') ? 'BU' : (upperMach.startsWith('CB') ? 'CB' : (upperMach.startsWith('SP') || upperMach.startsWith('HENX') ? 'SP' : upperMach)));

  const spec: DynamicSpecData = {
    constructionDetail: code.trim(),
    baseConstruction,
    area,
    machineCode: machCode,
    product: construction,
    standardSpeed,
    standardLength,
    linearDensity,
    layLength,
    tensileStrength,
    spoolType,
    numberOfWires: 1,
    fracturePerTon: fallbackRates.fracture ?? 0,
    diesPerTon: fallbackRates.dies ?? 0,
    defectPerTon: fallbackRates.defect ?? 0,
  };

  saveDynamicSpec(spec);
  return spec;
}

export const synthesizeWwdSpec = synthesizeDynamicSpec;

export function saveDynamicSpec(spec: DynamicSpecData): void {
  if (!spec.constructionDetail) return;
  cache.set(spec.constructionDetail.trim().toLowerCase(), spec);
  persistToStorage();
}

export const saveWwdSpec = saveDynamicSpec;

export function saveDynamicSpecsFromActualOutput(records: ActualOutputRecord[]): void {
  let changed = false;
  for (const rec of records) {
    if (!rec.constructionDetail) continue;

    const baseConstruction = extractBaseConstruction(rec.constructionDetail);
    const speed = typeof rec.standardSpeed === 'number' ? rec.standardSpeed : Number(rec.standardSpeed) || 0;
    const length = typeof rec.standardLength === 'number' ? rec.standardLength : Number(rec.standardLength) || 0;

    const diam = parseFloat(rec.construction);
    const calculatedDensity = Number.isFinite(diam) && diam > 0
      ? Number(((Math.PI / 4) * Math.pow(diam, 2) * 7.85).toFixed(4))
      : 0;

    const density = rec.linerDensity ?? calculatedDensity;
    const machCode = rec.group || rec.sapMachineTypeGroup || rec.constructionDetail.split('-')[0] || '';
    const recArea = (rec.area || '').trim().toUpperCase() || machCode.toUpperCase();

    const spec: DynamicSpecData = {
      constructionDetail: rec.constructionDetail.trim(),
      baseConstruction,
      area: recArea,
      machineCode: machCode,
      product: rec.construction || rec.constructionDetail.split('-')[1] || '',
      standardSpeed: speed,
      standardLength: length,
      linearDensity: density,
      layLength: Number(rec.layLength) || 0,
      tensileStrength: rec.tensileStrength || '',
      spoolType: rec.spoolType || 'BS40',
      numberOfWires: rec.numberOfWires ?? 1,
      fracturePerTon: rec.fracturePerTon ?? 0,
      diesPerTon: rec.diesPerTon ?? 0,
      defectPerTon: rec.defectPerTon ?? 0,
    };

    cache.set(rec.constructionDetail.trim().toLowerCase(), spec);
    changed = true;
  }
  if (changed) {
    persistToStorage();
  }
}

export const saveWwdSpecsFromActualOutput = saveDynamicSpecsFromActualOutput;

export function getDynamicSpec(code: string | undefined): DynamicSpecData | null {
  if (!code) return null;
  const key = code.trim().toLowerCase();
  const direct = cache.get(key);
  if (direct) return direct;

  if (isWwdConstruction(code) || code.includes('-')) {
    return synthesizeDynamicSpec(code);
  }

  return null;
}

export const getWwdSpec = getDynamicSpec;

/**
 * Matches a base construction against a Set or Map of activity construction keys.
 * Directly uses the Area column (e.g. Area BU for BOS, Area WW for WWD),
 * matching against machine code prefix, area prefix, or pure product specification.
 */
export function findMatchingActivityConstruction(
  baseConstruction: string,
  activitySetOrMap: Set<string> | Map<string, any>,
  area?: string,
): string | null {
  if (!baseConstruction) return null;

  const hasKey = (key: string): boolean => {
    const k = key.trim().toLowerCase();
    return activitySetOrMap.has(k);
  };

  const getCanonicalKey = (key: string): string => {
    const k = key.trim().toLowerCase();
    if (activitySetOrMap instanceof Map) {
      for (const mapKey of activitySetOrMap.keys()) {
        if (mapKey.trim().toLowerCase() === k) return mapKey;
      }
    } else if (activitySetOrMap instanceof Set) {
      for (const item of activitySetOrMap) {
        if (item.trim().toLowerCase() === k) return item;
      }
    }
    return key;
  };

  const raw = baseConstruction.trim();
  const parts = raw.split('-');
  const machCode = parts[0]?.toUpperCase() ?? '';
  const areaCode = (area || '').trim().toUpperCase();

  // Prefixes to test:
  // 1. The code's own machine prefix (e.g. 'BOS' or 'WWD')
  // 2. The Area column from the record (e.g. 'BU' or 'WW')
  // 3. WWD <-> WW alias (since historically WWD has area WW)
  // 4. No prefix (pure body)
  const prefixes: string[] = [];
  if (machCode) prefixes.push(machCode);
  if (areaCode && !prefixes.includes(areaCode)) prefixes.push(areaCode);
  if (areaCode === 'WW' && !prefixes.includes('WWD')) prefixes.push('WWD');
  if (machCode === 'WWD' && !prefixes.includes('WW')) prefixes.push('WW');
  if (areaCode === 'SP' && !prefixes.includes('HENX')) prefixes.push('HENX');
  if (machCode === 'HENX' && !prefixes.includes('SP')) prefixes.push('SP');
  prefixes.push('');

  // Bodies to test:
  // - full body after prefix: e.g. '2+2X0.23-13-HT-BS40'
  // - without spool type: e.g. '2+2X0.23-13-HT'
  // - product spec only: e.g. '2+2X0.23'
  const bodies: string[] = [];
  if (parts.length > 1) {
    const fullBody = parts.slice(1).join('-');
    bodies.push(fullBody);
    if (parts.length > 2) {
      const withoutSpool = parts.slice(1, -1).join('-');
      if (!bodies.includes(withoutSpool)) bodies.push(withoutSpool);
    }
    const productSpec = parts[1];
    if (productSpec && !bodies.includes(productSpec)) bodies.push(productSpec);
  } else {
    bodies.push(raw);
  }

  // Generate candidates with dot and comma variants
  const variants: string[] = [raw];

  for (const pfx of prefixes) {
    for (const b of bodies) {
      const candidate = pfx ? `${pfx}-${b}` : b;
      if (!variants.includes(candidate)) variants.push(candidate);

      if (candidate.includes('.')) {
        const withComma = candidate.replace(/\./g, ',');
        if (!variants.includes(withComma)) variants.push(withComma);
      }
      if (candidate.includes(',')) {
        const withDot = candidate.replace(/,/g, '.');
        if (!variants.includes(withDot)) variants.push(withDot);
      }
    }
  }

  // 1. Direct check
  for (const v of variants) {
    if (hasKey(v)) {
      return getCanonicalKey(v);
    }
  }

  // 2. Normalized check (ignoring punctuation, spaces, case, dot vs comma)
  const normStr = (str: string) => str.toLowerCase().replace(/[\s\-_]/g, '').replace(/,/g, '.');

  const existingKeys: string[] = [];
  if (activitySetOrMap instanceof Map) {
    for (const k of activitySetOrMap.keys()) existingKeys.push(k);
  } else if (activitySetOrMap instanceof Set) {
    for (const k of activitySetOrMap) existingKeys.push(k);
  }

  const existingNormMap = new Map<string, string>();
  for (const ek of existingKeys) {
    existingNormMap.set(normStr(ek), ek);
  }

  for (const v of variants) {
    const nv = normStr(v);
    if (existingNormMap.has(nv)) {
      return existingNormMap.get(nv)!;
    }
  }

  return null;
}
