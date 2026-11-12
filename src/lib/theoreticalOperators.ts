import { Mpp_wl_activitiesService } from '../generated/services/Mpp_wl_activitiesService';
import type { Mpp_wl_activities } from '../generated/models/Mpp_wl_activitiesModel';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import type { AppConfig, FrequencyMode, ProductionMachineAssignment, ProductionSetup } from '../types';
import { buildConstructionConfig } from './constructionConfig';
import { fetchAllPages } from './dataversePaging';
import { loadDefaultLayouts, loadDefaultValues, type DefaultValues } from './defaultValuesStore';
import { loadSavedLayouts, type SavedLayout } from './savedLayoutsStore';
import { productOperatorSettings } from './productCatalog';
import { recommendedMachineCountForForecast } from './singleOperatorUtilization';
import type { HistoricalFrequencyMap } from './frequencyCatalog';
import type { HistoricalRejectShortMap } from './rejectShortCatalog';
import { calculateSelectionOccupation } from './productionUtilization';
import {
  machineOperatorIds,
  operatorSharesForActivity,
  type ProductionActivityFamily,
} from './productionActivityRouting';
import type { ResolvedConstruction } from './productionConstructionResolver';

/** What the Work Load Simulator's setup for a Construction Detail is built from. */
export interface OptimizeInputs {
  defaults: DefaultValues;
  layoutByArea: Map<string, SavedLayout>;
  activitiesByConstruction: Map<string, Mpp_wl_activities[]>;
}

function constructionKey(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** Default Values, every Area's Default Layout and all of WL_Activities — read once, then reused for
 * every Construction Detail. */
export async function loadOptimizeInputs(): Promise<OptimizeInputs> {
  const [defaults, layoutIds, savedLayouts, activityRows] = await Promise.all([
    loadDefaultValues(),
    loadDefaultLayouts(),
    loadSavedLayouts(),
    fetchAllPages(Mpp_wl_activitiesService.getAll),
  ]);
  const layoutById = new Map(savedLayouts.map((layout) => [layout.id, layout]));
  const layoutByArea = new Map<string, SavedLayout>();
  Object.entries(layoutIds).forEach(([area, id]) => {
    const layout = layoutById.get(id);
    if (layout) layoutByArea.set(area, layout);
  });
  const activitiesByConstruction = new Map<string, Mpp_wl_activities[]>();
  activityRows.forEach((row) => {
    const key = constructionKey(row.mpp_constructiontype);
    if (!key) return;
    const group = activitiesByConstruction.get(key);
    if (group) group.push(row);
    else activitiesByConstruction.set(key, [row]);
  });
  return { defaults, layoutByArea, activitiesByConstruction };
}

/** The Production Setup's operator settings Optimize runs with (Shift & Movement Settings). */
export interface SetupOperatorSettings {
  taskPriority: ProductionSetup['taskPriority'];
  shiftTime: number;
  lunchTime: number;
  lunchStartAt: number;
  meetingTime: number;
  meetingStartAt: number;
  rpc: number;
  walkingSpeed: number;
  doffPriority: boolean;
  minRemainForDoffPriority: number;
  waitingModel: ProductionSetup['waitingModel'];
  useWaitingModel?: boolean;
  manOcc100Percent?: boolean;
  maxIdealDemandPercent?: number;
  frequencyMode?: FrequencyMode;
  frequencyStartDate?: string;
  frequencyEndDate?: string;
  poLengthCrSource?: FrequencyMode;
  poLengthCrStartDate?: string;
  poLengthCrEndDate?: string;
}

export function setupOperatorSettings(setup: ProductionSetup): SetupOperatorSettings {
  return {
    taskPriority: setup.taskPriority,
    shiftTime: setup.shiftTime,
    lunchTime: setup.lunchTime,
    lunchStartAt: setup.lunchStartAt,
    meetingTime: setup.meetingTime,
    meetingStartAt: setup.meetingStartAt,
    rpc: setup.rpc,
    walkingSpeed: setup.movement.walkingSpeed,
    doffPriority: setup.doffPriority,
    minRemainForDoffPriority: setup.minRemainForDoffPriority,
    waitingModel: setup.waitingModel,
    useWaitingModel: setup.useWaitingModel,
    manOcc100Percent: setup.manOcc100Percent,
    maxIdealDemandPercent: setup.maxIdealDemandPercent,
    frequencyMode: setup.frequencyMode ?? 'manual',
    frequencyStartDate: setup.frequencyStartDate,
    frequencyEndDate: setup.frequencyEndDate,
    poLengthCrSource: setup.poLengthCrSource ?? 'manual',
    poLengthCrStartDate: setup.poLengthCrStartDate,
    poLengthCrEndDate: setup.poLengthCrEndDate,
  };
}

/**
 * The Work Load Simulator's setup for this Construction Detail, ready for Optimize: its spec and
 * Activity Table, its Area's Default Layout and Optimize Step-Up from Default Values — and every
 * operator setting from the Production Setup (the product's own Task/Doff Priority still wins, as
 * in the Production simulation). Without a Default Layout the count still works: Optimize places
 * the machines on its stand-in grid for walking.
 */
export function optimizeConfigFor(
  base: AppConfig,
  product: Mpp_wl_productses,
  inputs: OptimizeInputs,
  settings: SetupOperatorSettings,
  frequencyCatalog?: HistoricalFrequencyMap | null,
  rejectShortCatalog?: HistoricalRejectShortMap | null,
): { config: AppConfig; hasDefaultLayout: boolean } {
  const area = (product.mpp_area ?? '').trim().toUpperCase();
  const layout = inputs.layoutByArea.get(area) ?? null;
  const activityRows = inputs.activitiesByConstruction.get(constructionKey(product.mpp_constructioncode)) ?? [];
  // No Default Layout: start from an empty one rather than whatever the simulator last had open.
  const neutralBase: AppConfig = layout ? base : { ...base, layout: [], walls: [], remarks: [], operatorStart: undefined, assignedMachineIds: [] };
  const { config: built } = buildConstructionConfig({
    base: neutralBase,
    product,
    activityRows,
    defaults: inputs.defaults,
    layout,
    frequencyMode: settings.frequencyMode,
    frequencyCatalog,
    poLengthCrSource: settings.poLengthCrSource,
    rejectShortCatalog,
  });
  const own = productOperatorSettings(product);
  const config: AppConfig = {
    ...built,
    operator: {
      ...built.operator,
      shiftTime: settings.shiftTime,
      lunchTime: settings.lunchTime,
      lunchStartAt: settings.lunchStartAt,
      meetingTime: settings.meetingTime,
      meetingStartAt: settings.meetingStartAt,
      taskPriority: own.taskPriority ?? settings.taskPriority,
      doffPriority: own.doffPriority ?? settings.doffPriority,
      minRemainForDoffPriority: own.minRemainForDoffPriority ?? settings.minRemainForDoffPriority,
      waitingModel: settings.waitingModel,
      useWaitingModel: settings.useWaitingModel,
      manOcc100Percent: settings.manOcc100Percent ?? inputs.defaults.manOcc100Percent,
      maxIdealDemandPercent: settings.maxIdealDemandPercent ?? inputs.defaults.maxIdealDemandPercent,
    },
    movement: { ...built.movement, walkingSpeed: settings.walkingSpeed },
    rpcPercent: settings.rpc,
  };
  return { config, hasDefaultLayout: layout !== null };
}

/** Same as Optimize Man Occupation in the Work Load Simulator. */
export function optimizedMachineCount(config: AppConfig): number {
  return recommendedMachineCountForForecast(config);
}

export interface TheoreticalOperatorRow {
  productId: string;
  constructionDetail: string;
  /** Machines in the setup running this Construction Detail. */
  machines: number;
  /** # Assigned Machines one operator handles (Optimize); 0 = couldn't work it out. */
  machinesPerOperator: number;
  /** machines ÷ machinesPerOperator. */
  operators: number;
  hasDefaultLayout: boolean;
  fracturePerTon?: number;
  defectPerTon?: number;
  diesPerTon?: number;
  frequencyRemark?: 'Historical' | 'Manual (Fallback)' | 'Manual';
  poLength1?: number;
  poLengthCrRemark?: 'Historical' | 'Manual (Fallback)' | 'Manual';
}

/** Theoretical Operator Required: each machine needs 1 ÷ (# Assigned Machines of its Construction
 * Detail) of an operator. Construction Details still being worked out are left out (`pending`). */
export function theoreticalOperators(
  assignments: ProductionMachineAssignment[],
  products: Mpp_wl_productses[],
  counts: ReadonlyMap<string, { machinesPerOperator: number; hasDefaultLayout: boolean }>,
  resolvedConstructions?: Map<string, ResolvedConstruction>,
): { total: number; rows: TheoreticalOperatorRow[]; pending: number; unresolved: number } {
  const machinesByProduct = new Map<string, number>();
  assignments.forEach((assignment) => {
    if (assignment.constructionDetailId) {
      machinesByProduct.set(assignment.constructionDetailId, (machinesByProduct.get(assignment.constructionDetailId) ?? 0) + 1);
    }
  });
  const productById = new Map(products.map((product) => [product.mpp_wl_productsid, product]));
  let total = 0;
  let pending = 0;
  let unresolved = 0;
  const rows: TheoreticalOperatorRow[] = [];
  machinesByProduct.forEach((machines, productId) => {
    const count = counts.get(productId);
    if (!count) {
      pending += 1;
      return;
    }
    const operators = count.machinesPerOperator > 0 ? machines / count.machinesPerOperator : 0;
    if (count.machinesPerOperator <= 0) unresolved += 1;
    total += operators;
    const resolved = resolvedConstructions?.get(productId);
    const prod = productById.get(productId);
    const fracturePerTon = resolved?.spec.fracturePerTon ?? (prod?.mpp_fractureperton != null ? Number(prod.mpp_fractureperton) : undefined);
    const defectPerTon = resolved?.spec.defectsPerTon ?? (prod?.mpp_defectston != null ? Number(prod.mpp_defectston) : undefined);
    const diesPerTon = resolved?.spec.diesPerTon ?? (prod?.mpp_dieston != null ? Number(prod.mpp_dieston) : undefined);
    const frequencyRemark = resolved?.frequencyRemark;
    const poLength1 = resolved?.spec.poLength1;
    const poLengthCrRemark = resolved?.poLengthCrRemark;

    rows.push({
      productId,
      constructionDetail: prod?.mpp_constructiondetailcode ?? productId,
      machines,
      machinesPerOperator: count.machinesPerOperator,
      operators,
      hasDefaultLayout: count.hasDefaultLayout,
      fracturePerTon,
      defectPerTon,
      diesPerTon,
      frequencyRemark,
      poLength1,
      poLengthCrRemark,
    });
  });
  rows.sort((a, b) => b.operators - a.operators || a.constructionDetail.localeCompare(b.constructionDetail, undefined, { numeric: true }));
  return { total, rows, pending, unresolved };
}

export interface TheoreticalActivityItem {
  key: string;
  label: string;
  plannedMinutes: number;
  forecastUtilizationPercent: number;
  utilizationPercent: number;
  operators?: number;
}

export interface TheoreticalActivityBreakdown {
  allTask: TheoreticalActivityItem;
  activities: TheoreticalActivityItem[];
}

/**
 * Returns each active activity family's share of total ideal handling time on a single machine of a
 * Construction Detail (shares are invariant across identical machines of the same Construction Detail).
 */
function constructionActivityShares(
  setup: ProductionSetup,
  resolvedConstructions: Map<string, ResolvedConstruction>,
  sampleMachineId: string,
): { family: ProductionActivityFamily; share: number }[] {
  const rows = calculateSelectionOccupation(setup, resolvedConstructions, [sampleMachineId]).activities.filter(
    (a) => a.plannedMinutes > 0,
  );
  const planned = rows.reduce((sum, a) => sum + a.plannedMinutes, 0);
  if (planned <= 0) return [];
  return rows.map((a) => ({ family: a.key as ProductionActivityFamily, share: a.plannedMinutes / planned }));
}

/**
 * Calculates theoretical operator required per activity family (Doffing, Loading, Fracture Repairing, etc.)
 * by splitting each Construction Detail's operators according to its activities' share of ideal handling time.
 */
export function calculateTheoreticalActivityBreakdown({
  setup,
  resolvedConstructions,
  machineIds,
  requiredRows,
  requiredTotal,
  requiredReady,
  assignmentByMachine,
}: {
  setup: ProductionSetup;
  resolvedConstructions: Map<string, ResolvedConstruction>;
  machineIds: string[];
  requiredRows: TheoreticalOperatorRow[];
  requiredTotal: number;
  requiredReady: boolean;
  assignmentByMachine?: Map<string, ProductionMachineAssignment>;
}): TheoreticalActivityBreakdown | null {
  if (machineIds.length === 0) return null;
  const occupation = calculateSelectionOccupation(setup, resolvedConstructions, machineIds);
  if (occupation.plannedMachineCount === 0) return null;

  const map = assignmentByMachine ?? new Map(setup.assignments.map((a) => [a.machineId, a]));
  const requiredByActivity = new Map<string, number>();

  if (requiredReady) {
    requiredRows.forEach((row) => {
      if (row.operators <= 0) return;
      const machinesOfConstruction = machineIds.filter(
        (id) => map.get(id)?.constructionDetailId === row.productId,
      );
      if (machinesOfConstruction.length === 0) return;
      constructionActivityShares(setup, resolvedConstructions, machinesOfConstruction[0]).forEach(({ family, share }) =>
        requiredByActivity.set(family, (requiredByActivity.get(family) ?? 0) + row.operators * share),
      );
    });
  }

  return {
    allTask: {
      key: 'all',
      label: 'All Task',
      plannedMinutes: occupation.allTask.plannedMinutes,
      forecastUtilizationPercent: occupation.allTask.forecastUtilizationPercent,
      utilizationPercent: occupation.allTask.utilizationPercent,
      operators: requiredReady ? requiredTotal : undefined,
    },
    activities: occupation.activities
      .filter((row) => row.plannedMinutes > 0)
      .map((row) => ({
        key: row.key,
        label: row.label,
        plannedMinutes: row.plannedMinutes,
        forecastUtilizationPercent: row.forecastUtilizationPercent,
        utilizationPercent: row.utilizationPercent,
        operators: requiredByActivity.get(row.key),
      })),
  };
}

/**
 * Calculates Theoretical Operator Required (#Opr) per operator in `setup.operators` from their
 * Multi Task and Split Task assignments across machines. Returns `undefined` for an operator
 * whenever any Construction Detail on their assigned machines is still pending in `counts`.
 */
export function calculateOperatorTheoreticalOperators({
  setup,
  resolvedConstructions,
  counts,
  assignmentByMachine,
}: {
  setup: ProductionSetup;
  resolvedConstructions: Map<string, ResolvedConstruction> | null;
  counts: ReadonlyMap<string, { machinesPerOperator: number }>;
  assignmentByMachine?: Map<string, ProductionMachineAssignment>;
}): Map<string, number | undefined> {
  const result = new Map<string, number | undefined>();
  if (!resolvedConstructions) return result;

  const setupOperatorIds = new Set(setup.operators.map((o) => o.id));
  const totals = new Map<string, number>(setup.operators.map((o) => [o.id, 0]));
  const blocked = new Set<string>();
  const map = assignmentByMachine ?? new Map(setup.assignments.map((a) => [a.machineId, a]));
  const weightsByProduct = new Map<string, { family: ProductionActivityFamily; weight: number }[] | 'pending'>();

  setup.layout.forEach((machine) => {
    const assignment = map.get(machine.id);
    const productId = assignment?.constructionDetailId;
    if (!productId) return;

    let weights = weightsByProduct.get(productId);
    if (weights === undefined) {
      const count = counts.get(productId);
      if (!count) {
        weights = 'pending';
      } else if (count.machinesPerOperator <= 0 || !resolvedConstructions.get(productId)) {
        weights = [];
      } else {
        const perMachine = 1 / count.machinesPerOperator;
        weights = constructionActivityShares(setup, resolvedConstructions, machine.id).map(({ family, share }) => ({
          family,
          weight: perMachine * share,
        }));
      }
      weightsByProduct.set(productId, weights);
    }

    if (weights === 'pending') {
      machineOperatorIds(assignment).forEach((opId) => {
        if (setupOperatorIds.has(opId)) blocked.add(opId);
      });
      return;
    }

    weights.forEach(({ family, weight }) => {
      operatorSharesForActivity(assignment, family).forEach(({ operatorId, share }) => {
        if (!setupOperatorIds.has(operatorId)) return;
        totals.set(operatorId, (totals.get(operatorId) ?? 0) + weight * share);
      });
    });
  });

  setup.operators.forEach((o) => {
    result.set(o.id, blocked.has(o.id) ? undefined : (totals.get(o.id) ?? 0));
  });
  return result;
}

