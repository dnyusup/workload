import type { ActualOutputRecord } from './actualOutputCatalog';

export interface WwdSpecData {
  constructionDetail: string;
  baseConstruction: string;
  standardSpeed: number;
  standardLength: number;
  linearDensity: number;
  layLength: number;
  tensileStrength: string;
  spoolType: string;
  fracturePerTon?: number | null;
  diesPerTon?: number | null;
  defectPerTon?: number | null;
}

const STORAGE_KEY = 'wl_wwd_specs_catalog';

// In-memory cache
const cache = new Map<string, WwdSpecData>();

function loadFromStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v === 'object') {
          cache.set(k.toLowerCase(), v as WwdSpecData);
        }
      }
    }
  } catch (e) {
    console.warn('[wwdSpecStore] Failed to load specs from localStorage:', e);
  }
}

function persistToStorage(): void {
  try {
    const obj: Record<string, WwdSpecData> = {};
    for (const [k, v] of cache.entries()) {
      obj[k] = v;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (e) {
    console.warn('[wwdSpecStore] Failed to save specs to localStorage:', e);
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
 * (the first 5 segments: [Group]-[Construction]-[LayLength]-[TensileStrength]-[SpoolType]).
 */
export function extractWwdBaseConstruction(fullCode: string): string {
  const parts = fullCode.trim().split('-');
  if (parts.length <= 5) return fullCode.trim();
  return parts.slice(0, 5).join('-');
}

/**
 * Parses and synthesizes a WwdSpecData from a 7-segment ConstructionDetail code
 * with mathematical fallback for linear density if not cached.
 */
export function synthesizeWwdSpec(
  code: string,
  fallbackRates: { fracture?: number; dies?: number; defect?: number } = {},
): WwdSpecData {
  const existing = cache.get(code.trim().toLowerCase());
  if (existing) return existing;

  const parts = code.trim().split('-');
  const baseConstruction = extractWwdBaseConstruction(code);

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

  const spec: WwdSpecData = {
    constructionDetail: code.trim(),
    baseConstruction,
    standardSpeed,
    standardLength,
    linearDensity,
    layLength,
    tensileStrength,
    spoolType,
    fracturePerTon: fallbackRates.fracture ?? 0,
    diesPerTon: fallbackRates.dies ?? 0,
    defectPerTon: fallbackRates.defect ?? 0,
  };

  saveWwdSpec(spec);
  return spec;
}

export function saveWwdSpec(spec: WwdSpecData): void {
  if (!spec.constructionDetail) return;
  cache.set(spec.constructionDetail.trim().toLowerCase(), spec);
  persistToStorage();
}

export function saveWwdSpecsFromActualOutput(records: ActualOutputRecord[]): void {
  let changed = false;
  for (const rec of records) {
    if (!isWwdRecord(rec) || !rec.constructionDetail) continue;

    const baseConstruction = extractWwdBaseConstruction(rec.constructionDetail);
    const speed = typeof rec.standardSpeed === 'number' ? rec.standardSpeed : Number(rec.standardSpeed) || 0;
    const length = typeof rec.standardLength === 'number' ? rec.standardLength : Number(rec.standardLength) || 0;

    const diam = parseFloat(rec.construction);
    const calculatedDensity = Number.isFinite(diam) && diam > 0
      ? Number(((Math.PI / 4) * Math.pow(diam, 2) * 7.85).toFixed(4))
      : 0;

    const density = rec.linerDensity ?? calculatedDensity;

    const spec: WwdSpecData = {
      constructionDetail: rec.constructionDetail.trim(),
      baseConstruction,
      standardSpeed: speed,
      standardLength: length,
      linearDensity: density,
      layLength: Number(rec.layLength) || 0,
      tensileStrength: rec.tensileStrength || '',
      spoolType: rec.spoolType || 'BS40',
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

export function getWwdSpec(code: string | undefined): WwdSpecData | null {
  if (!code) return null;
  const key = code.trim().toLowerCase();
  const direct = cache.get(key);
  if (direct) return direct;

  if (isWwdConstruction(code)) {
    return synthesizeWwdSpec(code);
  }

  return null;
}

/**
 * Robustly matches a WWD base construction against a Set or Map of activity construction keys.
 * Handles common variants such as '1X0.32' vs '0.32', presence/absence of 'WWD-' prefix, and spacing/case differences.
 */
export function findMatchingActivityConstruction(
  baseConstruction: string,
  activitySetOrMap: Set<string> | Map<string, any>,
): string | null {
  if (!baseConstruction) return null;

  const hasKey = (key: string): boolean => {
    const k = key.trim().toLowerCase();
    if (activitySetOrMap instanceof Set) {
      return activitySetOrMap.has(k);
    }
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

  // Generate sensible search variants
  const variants: string[] = [baseConstruction.trim()];

  // Variant: 1X removal (e.g. WWD-1X0.32-0-HT-BS60 -> WWD-0.32-0-HT-BS60)
  variants.push(baseConstruction.replace(/-1[xX]/i, '-'));
  variants.push(baseConstruction.replace(/^WWD-1[xX]/i, 'WWD-'));

  // Variant: 1X addition (e.g. WWD-0.32-0-HT-BS60 -> WWD-1X0.32-0-HT-BS60)
  const parts = baseConstruction.trim().split('-');
  if (parts.length >= 2 && !/^1[xX]/i.test(parts[1])) {
    const with1X = [...parts];
    with1X[1] = '1X' + with1X[1];
    variants.push(with1X.join('-'));
  }

  // Variant: without 'WWD-' prefix
  const withoutWwd = baseConstruction.replace(/^WWD-/i, '');
  variants.push(withoutWwd);
  variants.push(withoutWwd.replace(/^1[xX]/i, ''));
  if (parts.length >= 2 && !/^1[xX]/i.test(parts[1])) {
    variants.push('1X' + withoutWwd);
  }

  // Variant: with 'WWD-' prefix if missing
  if (!/^WWD-/i.test(baseConstruction)) {
    variants.push('WWD-' + baseConstruction);
  }

  for (const v of variants) {
    if (hasKey(v)) {
      return getCanonicalKey(v);
    }
  }

  // Fuzzy fallback: alphanumeric comparison ignoring '1x'
  const simplify = (s: string) =>
    s
      .toLowerCase()
      .replace(/^wwd-?/, '')
      .replace(/1x/g, '')
      .replace(/[^a-z0-9]/g, '');

  const targetSimplified = simplify(baseConstruction);
  if (targetSimplified) {
    const allKeys =
      activitySetOrMap instanceof Map ? Array.from(activitySetOrMap.keys()) : Array.from(activitySetOrMap);
    for (const key of allKeys) {
      if (simplify(key) === targetSimplified) {
        return key;
      }
    }
  }

  return null;
}
