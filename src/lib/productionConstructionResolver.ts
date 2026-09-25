import { Mpp_wl_activitiesService } from '../generated/services/Mpp_wl_activitiesService';
import type { Mpp_wl_activities } from '../generated/models/Mpp_wl_activitiesModel';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import type { ActivityConfig, ActivityKey, MachineSpecInput } from '../types';
import { buildActivitiesFromRows, mapProductToSpec } from './productCatalog';
import { activityCycleLength, deriveMachineSpec, ensureCoreActivities } from './calculations';
import { fetchAllPages } from './dataversePaging';

export interface ResolvedConstruction {
  productId: string;
  label: string;
  /** WL_Products SpoolType (e.g. BS40) — decides Finish Product vs Semi Finish Product tonnage. */
  spoolType: string;
  spec: MachineSpecInput;
  activities: ActivityConfig[];
  runtimePerSpool: number;
  cycleLengths: Record<ActivityKey, number>;
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
): Promise<{ resolved: Map<string, ResolvedConstruction>; errors: string[] }> {
  const resolved = new Map<string, ResolvedConstruction>();
  const errors: string[] = [];
  if (productIds.length === 0) return { resolved, errors };

  const productById = new Map(products.map((p) => [p.mpp_wl_productsid, p]));
  const activitiesByConstruction = new Map<string, Mpp_wl_activities[]>();
  let activitiesLoadFailed = false;
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
      errors.push(`Construction Detail (id ${productId}) not found in WL_Products.`);
      continue;
    }
    const spec = mapProductToSpec(product);
    const derived = deriveMachineSpec(spec);
    const construction = product.mpp_constructioncode?.trim();

    let activityRows: Mpp_wl_activities[] = [];
    if (construction) {
      if (!activitiesLoadFailed) activityRows = activitiesByConstruction.get(constructionKey(construction)) ?? [];
    } else {
      errors.push(`${product.mpp_constructiondetailcode} has no Construction code set — cannot resolve its activities.`);
    }

    const built = buildActivitiesFromRows(activityRows, product, derived.spoolWeight, spec.fracturePerTon);
    const activities = ensureCoreActivities(built.activities, derived.spoolWeight, spec.fracturePerTon);
    built.errors.forEach((e) => errors.push(`${product.mpp_constructiondetailcode}: ${e}`));

    const cycleLengths = Object.fromEntries(activities.map((a) => [a.key, activityCycleLength(a)]));

    resolved.set(productId, {
      productId,
      label: product.mpp_constructiondetailcode ?? productId,
      // SpoolType column first; else the Construction code's last segment
      // (Mach-Product-LayLength-TensileGroup-SpoolType).
      spoolType: (product.mpp_spooltype?.trim() || product.mpp_constructioncode?.split('-').pop()?.trim() || ''),
      spec,
      activities,
      runtimePerSpool: derived.runtimePerSpool > 0 ? derived.runtimePerSpool : 1,
      cycleLengths,
    });
  }

  return { resolved, errors };
}
