import { Mpp_wl_activitiesService } from '../generated/services/Mpp_wl_activitiesService';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import type { ActivityConfig, ActivityKey, MachineSpecInput } from '../types';
import { buildActivitiesFromRows, mapProductToSpec } from './productCatalog';
import { activityCycleLength, deriveMachineSpec, ensureCoreActivities } from './calculations';

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

export interface ResolvedConstruction {
  productId: string;
  label: string;
  spec: MachineSpecInput;
  activities: ActivityConfig[];
  runtimePerSpool: number;
  cycleLengths: Record<ActivityKey, number>;
}

/** Fetches WL_Activities and builds the {spec, activities} pair for every distinct Construction
 * Detail actually used in a Production Setup's assignments — once per Construction, not once per
 * machine, since the same Construction is typically shared by many machines. */
export async function resolveConstructions(
  productIds: string[],
  products: Mpp_wl_productses[],
): Promise<{ resolved: Map<string, ResolvedConstruction>; errors: string[] }> {
  const resolved = new Map<string, ResolvedConstruction>();
  const errors: string[] = [];

  for (const productId of productIds) {
    const product = products.find((p) => p.mpp_wl_productsid === productId);
    if (!product) {
      errors.push(`Construction Detail (id ${productId}) not found in WL_Products.`);
      continue;
    }
    const spec = mapProductToSpec(product);
    const derived = deriveMachineSpec(spec);
    const construction = product.mpp_constructioncode?.trim();

    let activityRows: Awaited<ReturnType<typeof Mpp_wl_activitiesService.getAll>>['data'] = [];
    if (construction) {
      const result = await Mpp_wl_activitiesService.getAll({
        filter: `mpp_constructiontype eq '${escapeODataString(construction)}'`,
      });
      if (result.success) {
        activityRows = result.data ?? [];
      } else {
        errors.push(`Failed to load WL_Activities for ${product.mpp_constructiondetailcode}: ${result.error?.message ?? 'unknown error'}`);
      }
    } else {
      errors.push(`${product.mpp_constructiondetailcode} has no Construction code set — cannot resolve its activities.`);
    }

    const built = buildActivitiesFromRows(activityRows ?? [], product, derived.spoolWeight, spec.fracturePerTon);
    const activities = ensureCoreActivities(built.activities, derived.spoolWeight, spec.fracturePerTon);
    built.errors.forEach((e) => errors.push(`${product.mpp_constructiondetailcode}: ${e}`));

    const cycleLengths = Object.fromEntries(activities.map((a) => [a.key, activityCycleLength(a)]));

    resolved.set(productId, {
      productId,
      label: product.mpp_constructiondetailcode ?? productId,
      spec,
      activities,
      runtimePerSpool: derived.runtimePerSpool > 0 ? derived.runtimePerSpool : 1,
      cycleLengths,
    });
  }

  return { resolved, errors };
}
