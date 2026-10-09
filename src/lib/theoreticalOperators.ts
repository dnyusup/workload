import { Mpp_wl_activitiesService } from '../generated/services/Mpp_wl_activitiesService';
import type { Mpp_wl_activities } from '../generated/models/Mpp_wl_activitiesModel';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import type { AppConfig, ProductionMachineAssignment, ProductionSetup } from '../types';
import { buildConstructionConfig } from './constructionConfig';
import { fetchAllPages } from './dataversePaging';
import { loadDefaultLayouts, loadDefaultValues, type DefaultValues } from './defaultValuesStore';
import { loadSavedLayouts, type SavedLayout } from './savedLayoutsStore';
import { productOperatorSettings } from './productCatalog';
import { recommendedMachineCountForForecast } from './singleOperatorUtilization';

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
): { config: AppConfig; hasDefaultLayout: boolean } {
  const area = (product.mpp_area ?? '').trim().toUpperCase();
  const layout = inputs.layoutByArea.get(area) ?? null;
  const activityRows = inputs.activitiesByConstruction.get(constructionKey(product.mpp_constructioncode)) ?? [];
  // No Default Layout: start from an empty one rather than whatever the simulator last had open.
  const neutralBase: AppConfig = layout ? base : { ...base, layout: [], walls: [], remarks: [], operatorStart: undefined, assignedMachineIds: [] };
  const { config: built } = buildConstructionConfig({ base: neutralBase, product, activityRows, defaults: inputs.defaults, layout });
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
}

/** Theoretical Operator Required: each machine needs 1 ÷ (# Assigned Machines of its Construction
 * Detail) of an operator. Construction Details still being worked out are left out (`pending`). */
export function theoreticalOperators(
  assignments: ProductionMachineAssignment[],
  products: Mpp_wl_productses[],
  counts: ReadonlyMap<string, { machinesPerOperator: number; hasDefaultLayout: boolean }>,
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
    rows.push({
      productId,
      constructionDetail: productById.get(productId)?.mpp_constructiondetailcode ?? productId,
      machines,
      machinesPerOperator: count.machinesPerOperator,
      operators,
      hasDefaultLayout: count.hasDefaultLayout,
    });
  });
  rows.sort((a, b) => b.operators - a.operators || a.constructionDetail.localeCompare(b.constructionDetail, undefined, { numeric: true }));
  return { total, rows, pending, unresolved };
}
