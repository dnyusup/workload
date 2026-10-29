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
