import { Mpp_wl_activitiesService } from '../generated/services/Mpp_wl_activitiesService';
import type { Mpp_wl_activities } from '../generated/models/Mpp_wl_activitiesModel';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import type { ActivityConfig, ActivityKey, FrequencyMode, MachineSpecInput } from '../types';
import { buildActivitiesFromRows, mapProductToSpec, productOperatorSettings, type ProductOperatorSettings } from './productCatalog';
import { activityCycleLength, deriveMachineSpec, ensureCoreActivities, syncAutoActivityValues } from './calculations';
import { fetchAllPages } from './dataversePaging';
import { resolveEffectiveFrequencies, type HistoricalFrequencyMap } from './frequencyCatalog';
import { isWwdConstruction, getWwdSpec, synthesizeWwdSpec } from './wwdSpecStore';
import { loadDefaultValuesOrBuiltIn } from './defaultValuesStore';

export interface ResolvedConstruction {
  productId: string;
  label: string;
  /** WL_Products SpoolType (e.g. BS40) — decides Finish Product vs Semi Finish Product tonnage. */
  spoolType: string;
  /** WL_Products descriptive columns, for grouping the Production Report. */
  attributes: ConstructionAttributes;
  spec: MachineSpecInput;
  activities: ActivityConfig[];
  runtimePerSpool: number;
  cycleLengths: Record<ActivityKey, number>;
  /** The product's own Task/Doff Priority — where set, it wins over the setup's for its machines. */
  operatorSettings: ProductOperatorSettings;
}

export interface ConstructionAttributes {
  constructionDetail: string;
  construction: string;
  area: string;
  machineCode: string;
  product: string;
  tensileGroup: string;
  spoolType: string;
  layLength: string;
  spoolLength: string;
  speed: string;
  numberOfWires: string;
}

/** Dataverse's `eq` on a string column is case-insensitive, so grouping in memory has to be too —
 * otherwise a Construction that matched its WL_Activities rows via the old per-Construction filter
 * would silently lose them here. */
function constructionKey(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** Fetches WL_Activities and builds the {spec, activities} pair for every distinct Construction
 * Detail actually used in a Production Setup's assignments — once per Construction, not once per
 * machine, since the same Construction is typically shared by many machines.
 *
 * A setup can use hundreds of different Constructions, so WL_Activities is read ONCE in full (paged)
 * and grouped in memory, instead of one filtered request per Construction — that was one sequential
 * HTTP round-trip each, i.e. minutes of loading at ~500 Constructions. */
export async function resolveConstructions(
  productIds: string[],
  products: Mpp_wl_productses[],
  frequencyMode: FrequencyMode = 'manual',
  frequencyCatalog: HistoricalFrequencyMap | null = null,
): Promise<{ resolved: Map<string, ResolvedConstruction>; errors: string[] }> {
  const resolved = new Map<string, ResolvedConstruction>();
  const errors: string[] = [];
  if (productIds.length === 0) return { resolved, errors };

  const productById = new Map(products.map((p) => [p.mpp_wl_productsid, p]));
  const activitiesByConstruction = new Map<string, Mpp_wl_activities[]>();
  let activitiesLoadFailed = false;
  const defaults = await loadDefaultValuesOrBuiltIn();
  try {
    const rows = await fetchAllPages(Mpp_wl_activitiesService.getAll);
    for (const row of rows) {
      const key = constructionKey(row.mpp_constructiontype);
      if (!key) continue;
      const group = activitiesByConstruction.get(key);
      if (group) group.push(row);
      else activitiesByConstruction.set(key, [row]);
    }
  } catch (err) {
    activitiesLoadFailed = true;
    errors.push(`Failed to load WL_Activities: ${err instanceof Error ? err.message : 'unknown error'}`);
  }

  for (const productId of productIds) {
    const product = productById.get(productId);
    if (!product) {
      if (isWwdConstruction(productId)) {
        const wwdSpec = getWwdSpec(productId) ?? synthesizeWwdSpec(productId, {
          fracture: defaults.defaultFracturePerTon,
          dies: defaults.defaultDiesPerTon,
          defect: defaults.defaultDefectPerTon,
        });

        let spec: MachineSpecInput = {
          area: 'WW',
          layLength: wwdSpec.layLength ?? 0,
          noOfWires: 1,
          speed: wwdSpec.standardSpeed,
          spoolLength: wwdSpec.standardLength,
          linearDensity: wwdSpec.linearDensity,
          fracturePerTon: wwdSpec.fracturePerTon ?? defaults.defaultFracturePerTon ?? 0,
          diesPerTon: wwdSpec.diesPerTon ?? defaults.defaultDiesPerTon ?? 0,
          defectsPerTon: wwdSpec.defectPerTon ?? defaults.defaultDefectPerTon ?? 0,
          poLength1: defaults.defaultWwdPoLength1 ?? 5000,
          poLength2: 0,
          poLength3: 0,
        };

        if (frequencyMode === 'historical' && frequencyCatalog) {
          const effective = resolveEffectiveFrequencies({
            manual: {
              fracturePerTon: spec.fracturePerTon,
              diesPerTon: spec.diesPerTon,
              defectsPerTon: spec.defectsPerTon,
            },
            lookupParams: {
              mach: 'WWD',
              product: wwdSpec.baseConstruction.split('-')[1] ?? '',
              layLength: wwdSpec.layLength,
              tensileGroup: wwdSpec.tensileStrength,
            },
            mode: frequencyMode,
            catalog: frequencyCatalog,
          });
          spec = {
            ...spec,
            fracturePerTon: effective.fracturePerTon,
            diesPerTon: effective.diesPerTon,
            defectsPerTon: effective.defectsPerTon,
          };
        }

        const derived = deriveMachineSpec(spec);
        const baseConstruction = wwdSpec.baseConstruction;

        let activityRows: Mpp_wl_activities[] = [];
        if (baseConstruction) {
          if (!activitiesLoadFailed) activityRows = activitiesByConstruction.get(constructionKey(baseConstruction)) ?? [];
        }

        if (activityRows.length === 0) {
          errors.push(`WWD Base Construction "${baseConstruction}" has no activities in WL_Activities.`);
        }

        const mockProduct = {
          mpp_area: 'WW',
          mpp_polength1: spec.poLength1,
          mpp_polength2: 0,
          mpp_polength3: 0,
          mpp_spoollength: spec.spoolLength,
          mpp_dieston: String(spec.diesPerTon),
          mpp_defectston: String(spec.defectsPerTon),
        };

        const built = buildActivitiesFromRows(activityRows, mockProduct as any, derived.spoolWeight, spec.fracturePerTon);
        const activities = syncAutoActivityValues(
          ensureCoreActivities(built.activities, derived.spoolWeight, spec.fracturePerTon),
          spec,
        );
        built.errors.forEach((e) => errors.push(`${productId}: ${e}`));

        const cycleLengths = Object.fromEntries(activities.map((a) => [a.key, activityCycleLength(a)]));

        resolved.set(productId, {
          productId,
          label: productId,
          spoolType: wwdSpec.spoolType,
          attributes: {
            constructionDetail: productId,
            construction: baseConstruction,
            area: 'WW',
            machineCode: 'WWD',
            product: baseConstruction.split('-')[1] ?? '',
            tensileGroup: wwdSpec.tensileStrength,
            spoolType: wwdSpec.spoolType,
            layLength: String(wwdSpec.layLength ?? 0),
            spoolLength: String(wwdSpec.standardLength ?? 0),
            speed: String(wwdSpec.standardSpeed ?? 0),
            numberOfWires: '1',
          },
          spec,
          activities,
          runtimePerSpool: derived.runtimePerSpool > 0 ? derived.runtimePerSpool : 1,
          cycleLengths,
          operatorSettings: {},
        });
        continue;
      }

      errors.push(`Construction Detail (id ${productId}) not found in WL_Products.`);
      continue;
    }
    let spec = mapProductToSpec(product);
    if (frequencyMode === 'historical' && frequencyCatalog) {
      const effective = resolveEffectiveFrequencies({
        manual: {
          fracturePerTon: spec.fracturePerTon,
          diesPerTon: spec.diesPerTon,
          defectsPerTon: spec.defectsPerTon,
        },
        lookupParams: {
          mach: product.mpp_machinecode,
          product: product.mpp_productspecification,
          layLength: product.mpp_laylength,
          tensileGroup: product.mpp_tensilegroup,
        },
        mode: frequencyMode,
        catalog: frequencyCatalog,
      });
      spec = {
        ...spec,
        fracturePerTon: effective.fracturePerTon,
        diesPerTon: effective.diesPerTon,
        defectsPerTon: effective.defectsPerTon,
      };
    }
    const derived = deriveMachineSpec(spec);
    const construction = product.mpp_constructioncode?.trim();

    let activityRows: Mpp_wl_activities[] = [];
    if (construction) {
      if (!activitiesLoadFailed) activityRows = activitiesByConstruction.get(constructionKey(construction)) ?? [];
    } else {
      errors.push(`${product.mpp_constructiondetailcode} has no Construction code set — cannot resolve its activities.`);
    }

    const built = buildActivitiesFromRows(activityRows, product, derived.spoolWeight, spec.fracturePerTon);
    const activities = syncAutoActivityValues(
      ensureCoreActivities(built.activities, derived.spoolWeight, spec.fracturePerTon),
      spec,
    );
    built.errors.forEach((e) => errors.push(`${product.mpp_constructiondetailcode}: ${e}`));

    const cycleLengths = Object.fromEntries(activities.map((a) => [a.key, activityCycleLength(a)]));

    resolved.set(productId, {
      productId,
      label: product.mpp_constructiondetailcode ?? productId,
      // SpoolType column first; else the Construction code's last segment
      // (Mach-Product-LayLength-TensileGroup-SpoolType).
      spoolType: (product.mpp_spooltype?.trim() || product.mpp_constructioncode?.split('-').pop()?.trim() || ''),
      attributes: {
        constructionDetail: product.mpp_constructiondetailcode?.trim() ?? '',
        construction: product.mpp_constructioncode?.trim() ?? '',
        area: product.mpp_area?.trim().toUpperCase() ?? '',
        machineCode: product.mpp_machinecode?.trim() ?? '',
        product: product.mpp_productspecification?.trim() ?? '',
        tensileGroup: product.mpp_tensilegroup?.trim() ?? '',
        spoolType: (product.mpp_spooltype?.trim() || product.mpp_constructioncode?.split('-').pop()?.trim() || ''),
        layLength: product.mpp_laylength != null ? String(product.mpp_laylength) : '',
        spoolLength: product.mpp_spoollength != null ? String(product.mpp_spoollength) : '',
        speed: product.mpp_speed?.toString().trim() ?? '',
        numberOfWires: product.mpp_numberoffibers != null ? String(product.mpp_numberoffibers) : '',
      },
      spec,
      activities,
      runtimePerSpool: derived.runtimePerSpool > 0 ? derived.runtimePerSpool : 1,
      cycleLengths,
      operatorSettings: productOperatorSettings(product),
    });
  }

  return { resolved, errors };
}
