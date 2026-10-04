import { Mpp_wl_activitiesService } from '../generated/services/Mpp_wl_activitiesService';
import { Mpp_wl_productsesService } from '../generated/services/Mpp_wl_productsesService';
import type { AppConfig, InheritedSimulationSnapshot } from '../types';
import { buildConstructionConfig } from './constructionConfig';
import { escapeODataString, fetchAllPages } from './dataversePaging';
import { loadDefaultValuesOrBuiltIn } from './defaultValuesStore';

/**
 * The Work Load Simulator setup to replay a saved output model's start condition: the Construction
 * Detail's own spec and Activity Table (from WL_Products / WL_Activities, with Default Values) —
 * the same setup Batch Simulation and picking it in the simulator build — then the snapshot's
 * layout, operator settings, assignment, machine conditions and seed on top. Without rebuilding
 * the spec and activities, a replay would run on whatever Construction was last picked.
 */
export async function configForStartCondition(
  base: AppConfig,
  constructionDetail: string,
  snapshot: InheritedSimulationSnapshot,
): Promise<{ config: AppConfig; warnings: string[] }> {
  const detail = constructionDetail.trim();
  const products = await fetchAllPages(Mpp_wl_productsesService.getAll, {
    filter: `mpp_constructiondetailcode eq '${escapeODataString(detail)}'`,
  });
  const product = products[0];
  if (!product) throw new Error(`Construction Detail ${detail} is not in WL_Products, so its spec and activities can't be loaded.`);
  const construction = product.mpp_constructioncode?.trim();
  const [defaults, activityResult] = await Promise.all([
    loadDefaultValuesOrBuiltIn(),
    construction
      ? Mpp_wl_activitiesService.getAll({ filter: `mpp_constructiontype eq '${escapeODataString(construction)}'` })
      : Promise.resolve(null),
  ]);
  if (activityResult && !activityResult.success) {
    throw new Error(activityResult.error?.message ?? 'Failed to load WL_Activities for this Construction.');
  }
  const built = buildConstructionConfig({ base, product, activityRows: activityResult?.data ?? [], defaults, layout: null });
  const hasLayout = snapshot.layout.length > 0;
  return {
    config: {
      ...built.config,
      ...(hasLayout
        ? {
            layout: snapshot.layout,
            walls: snapshot.walls,
            remarks: snapshot.remarks,
            operatorStart: snapshot.operatorStart,
            assignedMachineIds: snapshot.assignedMachineIds,
            ...(snapshot.operator ? { operator: snapshot.operator } : {}),
          }
        : {}),
      initialMachineConditions: snapshot.conditions,
      seed: snapshot.seed,
    },
    warnings: built.errors,
  };
}
