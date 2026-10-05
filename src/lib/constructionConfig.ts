import type { Mpp_wl_activities } from '../generated/models/Mpp_wl_activitiesModel';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import type { AppConfig } from '../types';
import { deriveMachineSpec, ensureCoreActivities, syncAutoActivityValues } from './calculations';
import type { DefaultValues } from './defaultValuesStore';
import { DEFAULT_PIXELS_PER_METER } from './layoutConstants';
import { buildActivitiesFromRows, isLoadingTaskRow, mapProductToSpec } from './productCatalog';
import type { SavedLayout } from './savedLayoutsStore';
import { previewAssignedMachineIds, recommendedMachineCountForForecast } from './singleOperatorUtilization';

/**
 * The Work Load Simulator setup for one Construction Detail: its spec from WL_Products, its
 * Activity Table from WL_Activities, every operator setting from Default Values, and — when given —
 * the Area's default layout with a fresh assignment. Shared by picking a Construction Detail and by
 * Batch Simulation, so both start from exactly the same setup.
 */
export function buildConstructionConfig({
  base,
  product,
  activityRows,
  defaults,
  layout,
}: {
  base: AppConfig;
  product: Mpp_wl_productses;
  activityRows: Mpp_wl_activities[];
  defaults: DefaultValues;
  /** The Area's default layout; null keeps base's layout and assignment. */
  layout: SavedLayout | null;
}): { config: AppConfig; errors: string[] } {
  const spec = mapProductToSpec(product);
  const derived = deriveMachineSpec(spec);
  const built = buildActivitiesFromRows(activityRows, product, derived.spoolWeight, spec.fracturePerTon);
  // Synced the way Start does it (auto Num/Dem, Dies/Defect per ton), so a batch run, a replay and a
  // run started from the setup all simulate the very same Activity Table.
  const activities = syncAutoActivityValues(ensureCoreActivities(built.activities, derived.spoolWeight, spec.fracturePerTon), spec);
  const config: AppConfig = {
    ...base,
    // A fresh assignment on the default layout, so it follows the default order from the top-left.
    ...(layout
      ? { layout: layout.machines, operatorStart: layout.operatorStart, walls: layout.walls, remarks: layout.remarks, assignedMachineIds: [] }
      : {}),
    // Shift/break/priority settings start from Setting → Default Values for every Construction;
    // extra "Other" breaks belong to the previous Construction's scenario — start clean.
    operator: {
      ...base.operator,
      extraBreaks: [],
      taskPriority: defaults.taskPriority,
      shiftTime: defaults.shiftTime,
      lunchTime: defaults.lunchTime,
      lunchStartAt: defaults.lunchStartAt,
      meetingTime: defaults.meetingTime,
      meetingStartAt: defaults.meetingStartAt,
      doffPriority: defaults.doffPriority,
      minRemainForDoffPriority: defaults.minRemainForDoffPriority,
      waitingModel: defaults.waitingModel,
      optimizeStepUpBelow: defaults.optimizeStepUpBelow,
    },
    movement: { walkingSpeed: defaults.walkingSpeed, pixelsPerMeter: DEFAULT_PIXELS_PER_METER },
    rpcPercent: defaults.rpc,
    spec,
    activities,
    selectedProductId: product.mpp_wl_productsid,
    selectedConstructionDetail: product.mpp_constructiondetailcode,
    loadingActivityRows: activityRows.filter(isLoadingTaskRow),
    initialMachineConditions: undefined,
    // A replayed run's seed belongs to that run — a fresh setup draws a new one each time.
    seed: undefined,
  };
  return { config, errors: built.errors };
}

/** The config with Optimize applied: the most machines the operator can keep up with, assigned in
 * the default order. */
export function withOptimizedAssignment(config: AppConfig): AppConfig {
  const machineCount = recommendedMachineCountForForecast(config);
  return {
    ...config,
    operator: { ...config.operator, machHandled: machineCount },
    assignedMachineIds: previewAssignedMachineIds(config, machineCount),
  };
}
