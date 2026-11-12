import type { Mpp_wl_activities } from '../generated/models/Mpp_wl_activitiesModel';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import type { AppConfig, FrequencyMode } from '../types';
import { deriveMachineSpec, ensureCoreActivities, syncAutoActivityValues } from './calculations';
import type { DefaultValues } from './defaultValuesStore';
import { getDefaultPoLengthForArea } from './defaultValuesStore';
import { DEFAULT_PIXELS_PER_METER } from './layoutConstants';
import { buildActivitiesFromRows, isLoadingTaskRow, mapProductToSpec, productOperatorSettings, rebuildLoadingActivities } from './productCatalog';
import type { SavedLayout } from './savedLayoutsStore';
import { previewAssignedMachineIds, recommendedMachineCountForForecast } from './singleOperatorUtilization';
import { resolveEffectiveFrequencies, type HistoricalFrequencyMap } from './frequencyCatalog';
import { resolveEffectiveCrPoLength, type HistoricalRejectShortMap } from './rejectShortCatalog';

/**
 * The Work Load Simulator setup for one Construction Detail: its spec from WL_Products, its
 * Activity Table from WL_Activities, every operator setting from Default Values (Task/Doff Priority
 * from the product itself where filled in), and — when given —
 * the Area's default layout with a fresh assignment. Shared by picking a Construction Detail and by
 * Batch Simulation, so both start from exactly the same setup.
 */
export function buildConstructionConfig({
  base,
  product,
  activityRows,
  defaults,
  layout,
  frequencyMode,
  frequencyCatalog,
  poLengthCrSource,
  rejectShortCatalog,
}: {
  base: AppConfig;
  product: Mpp_wl_productses;
  activityRows: Mpp_wl_activities[];
  defaults: DefaultValues;
  /** The Area's default layout; null keeps base's layout and assignment. */
  layout: SavedLayout | null;
  frequencyMode?: FrequencyMode;
  frequencyCatalog?: HistoricalFrequencyMap | null;
  poLengthCrSource?: FrequencyMode;
  rejectShortCatalog?: HistoricalRejectShortMap | null;
}): { config: AppConfig; errors: string[] } {
  let spec = mapProductToSpec(product);
  const prodArea = (product.mpp_area ?? '').trim().toUpperCase();
  if (product.mpp_polength1 == null || Number(product.mpp_polength1) === 0) {
    const fallbackDefault = getDefaultPoLengthForArea(defaults, prodArea, spec.spoolLength);
    if (fallbackDefault != null && fallbackDefault > 0) {
      spec.poLength1 = fallbackDefault;
    }
  }
  const effectiveCrMode = poLengthCrSource ?? defaults.poLengthCrSource ?? 'manual';
  if (prodArea === 'CR' && effectiveCrMode === 'historical' && rejectShortCatalog) {
    const effectivePo = resolveEffectiveCrPoLength({
      manualPoLength1: spec.poLength1 ?? 0,
      lookupParams: {
        product: product.mpp_productspecification,
        layLength: product.mpp_laylength,
        tensileGroup: product.mpp_tensilegroup,
      },
      mode: effectiveCrMode,
      catalog: rejectShortCatalog,
    });
    spec = { ...spec, poLength1: effectivePo.poLength1 };
  }

  const effectiveMode = frequencyMode ?? base.frequencyMode ?? defaults.frequencyMode ?? 'manual';
  if (effectiveMode === 'historical' && frequencyCatalog) {
    const effective = resolveEffectiveFrequencies({
      manual: {
        fracturePerTon: spec.fracturePerTon > 0 ? spec.fracturePerTon : defaults.defaultFracturePerTon,
        diesPerTon: spec.diesPerTon > 0 ? spec.diesPerTon : defaults.defaultDiesPerTon,
        defectsPerTon: spec.defectsPerTon > 0 ? spec.defectsPerTon : defaults.defaultDefectPerTon,
      },
      lookupParams: {
        mach: product.mpp_machinecode,
        product: product.mpp_productspecification,
        layLength: product.mpp_laylength,
        tensileGroup: product.mpp_tensilegroup,
      },
      mode: effectiveMode,
      catalog: frequencyCatalog,
    });
    spec = {
      ...spec,
      fracturePerTon: effective.fracturePerTon,
      diesPerTon: effective.diesPerTon,
      defectsPerTon: effective.defectsPerTon,
    };
  } else {
    // Mode manual: jika produk bernilai 0 tapi ada default fallback, gunakan default fallback
    if (spec.fracturePerTon === 0 && defaults.defaultFracturePerTon > 0) {
      spec.fracturePerTon = defaults.defaultFracturePerTon;
    }
    if (spec.defectsPerTon === 0 && defaults.defaultDefectPerTon > 0) {
      spec.defectsPerTon = defaults.defaultDefectPerTon;
    }
    if (spec.diesPerTon === 0 && defaults.defaultDiesPerTon > 0) {
      spec.diesPerTon = defaults.defaultDiesPerTon;
    }
  }

  const productSettings = productOperatorSettings(product);
  const derived = deriveMachineSpec(spec);
  const effectiveProduct = spec.poLength1 != null ? { ...product, mpp_polength1: spec.poLength1 } : product;
  const built = buildActivitiesFromRows(activityRows, effectiveProduct, derived.spoolWeight, spec.fracturePerTon);
  // Synced the way Start does it (auto Num/Dem, Dies/Defect per ton), so a batch run, a replay and a
  // run started from the setup all simulate the very same Activity Table.
  const activities = syncAutoActivityValues(ensureCoreActivities(built.activities, derived.spoolWeight, spec.fracturePerTon), spec);
  const config: AppConfig = {
    ...base,
    frequencyMode: effectiveMode,
    frequencyStartDate: base.frequencyStartDate,
    frequencyEndDate: base.frequencyEndDate,
    poLengthCrSource: effectiveCrMode,
    poLengthCrStartDate: base.poLengthCrStartDate,
    poLengthCrEndDate: base.poLengthCrEndDate,
    // A fresh assignment on the default layout, so it follows the default order from the top-left.
    ...(layout
      ? { layout: layout.machines, operatorStart: layout.operatorStart, walls: layout.walls, remarks: layout.remarks, assignedMachineIds: [] }
      : {}),
    // Shift/break/priority settings start from Setting → Default Values for every Construction;
    // extra "Other" breaks belong to the previous Construction's scenario — start clean.
    operator: {
      ...base.operator,
      extraBreaks: [],
      // The Construction Detail's own Task/Doff Priority (WL_Products) wins where it's filled in.
      taskPriority: productSettings.taskPriority ?? defaults.taskPriority,
      shiftTime: defaults.shiftTime,
      lunchTime: defaults.lunchTime,
      lunchStartAt: defaults.lunchStartAt,
      meetingTime: defaults.meetingTime,
      meetingStartAt: defaults.meetingStartAt,
      doffPriority: productSettings.doffPriority ?? defaults.doffPriority,
      minRemainForDoffPriority: productSettings.minRemainForDoffPriority ?? defaults.minRemainForDoffPriority,
      waitingModel: defaults.waitingModel,
      useWaitingModel: defaults.useWaitingModel,
      manOcc100Percent: defaults.manOcc100Percent,
      maxIdealDemandPercent: defaults.maxIdealDemandPercent,
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

/**
 * Mengubah frequency mode (manual <-> historical) pada AppConfig yang sudah ada
 * dan memperbarui numerator/denominator aktivitas otomatis.
 */
export function applyFrequencyModeToConfig({
  config,
  product,
  mode,
  catalog,
}: {
  config: AppConfig;
  product: Mpp_wl_productses;
  mode: FrequencyMode;
  catalog: HistoricalFrequencyMap | null;
}): AppConfig {
  const manualSpec = mapProductToSpec(product);
  const effective = resolveEffectiveFrequencies({
    manual: {
      fracturePerTon: manualSpec.fracturePerTon,
      diesPerTon: manualSpec.diesPerTon,
      defectsPerTon: manualSpec.defectsPerTon,
    },
    lookupParams: {
      mach: product.mpp_machinecode,
      product: product.mpp_productspecification,
      layLength: product.mpp_laylength,
      tensileGroup: product.mpp_tensilegroup,
    },
    mode,
    catalog,
  });

  const updatedSpec = {
    ...config.spec,
    fracturePerTon: effective.fracturePerTon,
    diesPerTon: effective.diesPerTon,
    defectsPerTon: effective.defectsPerTon,
  };

  const updatedActivities = syncAutoActivityValues(config.activities, updatedSpec);

  return {
    ...config,
    frequencyMode: mode,
    spec: updatedSpec,
    activities: updatedActivities,
  };
}

/**
 * Updates Area CR PO Length 1 (Manual / %SpoolLength fallback vs Historical MES_RejectShort) on an existing AppConfig
 * and rebuilds Loading + auto activity values cleanly.
 */
export function applyPoLengthCrSourceToConfig({
  config,
  product,
  mode,
  catalog,
  defaults,
}: {
  config: AppConfig;
  product: Mpp_wl_productses;
  mode: FrequencyMode;
  catalog: HistoricalRejectShortMap | null;
  defaults: DefaultValues;
}): AppConfig {
  const area = (product.mpp_area ?? config.spec.area ?? '').trim().toUpperCase();
  if (area !== 'CR') {
    return {
      ...config,
      poLengthCrSource: mode,
    };
  }

  const manualRaw = product.mpp_polength1 != null ? Number(product.mpp_polength1) : 0;
  const manualFallback =
    Number.isFinite(manualRaw) && manualRaw > 0
      ? manualRaw
      : (getDefaultPoLengthForArea(defaults, 'CR', config.spec.spoolLength) ?? 0);

  const effectivePo = resolveEffectiveCrPoLength({
    manualPoLength1: manualFallback,
    lookupParams: {
      product: product.mpp_productspecification,
      layLength: product.mpp_laylength,
      tensileGroup: product.mpp_tensilegroup,
    },
    mode,
    catalog,
  });

  const updatedSpec = {
    ...config.spec,
    poLength1: effectivePo.poLength1,
  };

  const rebuilt =
    config.loadingActivityRows && config.loadingActivityRows.length > 0
      ? rebuildLoadingActivities(config.activities, updatedSpec, config.loadingActivityRows).activities
      : config.activities;
  const updatedActivities = syncAutoActivityValues(rebuilt, updatedSpec);

  return {
    ...config,
    poLengthCrSource: mode,
    spec: updatedSpec,
    activities: updatedActivities,
  };
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
