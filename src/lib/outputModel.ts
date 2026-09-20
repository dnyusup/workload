import type { Mpp_wl_outputmodelses } from '../generated/models/Mpp_wl_outputmodelsesModel';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import { Mpp_wl_outputmodelsesService } from '../generated/services/Mpp_wl_outputmodelsesService';
import { Mpp_wl_productsesService } from '../generated/services/Mpp_wl_productsesService';
import { calculateSingleOperatorForecast } from './singleOperatorUtilization';
import { deriveMachineSpec } from './calculations';
import type { AppConfig, SimulationState } from '../types';
import type { Mpp_wl_outputmodelsesBase } from '../generated/models/Mpp_wl_outputmodelsesModel';
import { escapeODataString, fetchAllPages } from './dataversePaging';

export type OutputModelPayload = Omit<Mpp_wl_outputmodelsesBase, 'mpp_wl_outputmodelsid'>;

export interface OutputModelSaveMetadata {
  version: string;
  versionRemark?: string;
}

export const OUTPUT_MODEL_PERCENT_KEYS = [
  'mpp_plannedmanoccupation',
  'mpp_actualmanoccupation',
  'mpp_plannedmachineefficiency',
  'mpp_actualmachineefficiency',
  'mpp_doffingtime',
  'mpp_loadingtime',
  'mpp_fracturerepairingtime',
  'mpp_defectrepairingtime',
  'mpp_dieschangetime',
  'mpp_walkingtime',
  'mpp_othertime',
  'mpp_idle',
] as const;

export type OutputModelPercentKey = (typeof OUTPUT_MODEL_PERCENT_KEYS)[number];

export function storedPercentage(value: number) {
  return value / 100;
}

export function percentageForDisplay(value: number | undefined) {
  if (value === undefined || value === null) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  // Older rows stored 30 for 30%; newer rows store 0.3.
  return Math.abs(numeric) > 1 ? numeric : numeric * 100;
}

export function outputModelVersionNumber(version: string | undefined) {
  const parsed = Number.parseInt(version ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function formatOutputModelVersion(version: number) {
  return String(Math.max(1, Math.floor(version))).padStart(4, '0');
}

function sumActivityMinutes(record: Record<string, number>, prefix: string) {
  return Object.entries(record)
    .filter(([key]) => key === prefix || key.startsWith(`${prefix}-`))
    .reduce((total, [, minutes]) => total + Math.max(0, minutes), 0);
}

function runningMachineMinutes(state: SimulationState) {
  return state.machines.reduce(
    (total, machine) =>
      total +
      machine.timeline.reduce((machineTotal, segment) => {
        const isRunning = segment.kind === 'running' || segment.kind.startsWith('running:');
        return isRunning ? machineTotal + Math.max(0, segment.endMin - segment.startMin) : machineTotal;
      }, 0),
    0,
  );
}

function percentage(value: number, denominator: number) {
  return denominator > 0 ? (value / denominator) * 100 : 0;
}

function activityPercentages(state: SimulationState, workedElapsed: number) {
  const serviceByActivity = state.metrics.servicingByActivity;
  const doffing = sumActivityMinutes(serviceByActivity, 'doffing');
  const loading = sumActivityMinutes(serviceByActivity, 'loading');
  const fractureRepairing = sumActivityMinutes(serviceByActivity, 'fractureRepairing');
  const defectRepairing = sumActivityMinutes(serviceByActivity, 'defectRepairing');
  const diesChange = sumActivityMinutes(serviceByActivity, 'diesChange');
  const walking = Math.max(0, state.metrics.walkingMin);
  const knownMinutes = doffing + loading + fractureRepairing + defectRepairing + diesChange + walking;
  const busyMinutes = Math.max(0, state.metrics.servicingMin + state.metrics.walkingMin);
  const others = Math.max(0, busyMinutes - knownMinutes);
  const idle = Math.max(0, workedElapsed - busyMinutes);

  return {
    doffing: percentage(doffing, workedElapsed),
    loading: percentage(loading, workedElapsed),
    fractureRepairing: percentage(fractureRepairing, workedElapsed),
    defectRepairing: percentage(defectRepairing, workedElapsed),
    diesChange: percentage(diesChange, workedElapsed),
    walking: percentage(walking, workedElapsed),
    others: percentage(others, workedElapsed),
    idle: percentage(idle, workedElapsed),
  };
}

function countActivityEvents(record: Record<string, number>, prefix: string) {
  return Object.entries(record)
    .filter(([key]) => key === prefix || key.startsWith(`${prefix}-`))
    .reduce((total, [, count]) => total + Math.max(0, count), 0);
}

async function selectedProduct(config: AppConfig) {
  if (!config.selectedProductId) {
    throw new Error('No selected Construction Detail product is available to save.');
  }
  const result = await Mpp_wl_productsesService.get(config.selectedProductId);
  if (!result.success || !result.data) {
    throw new Error(result.error?.message ?? 'Failed to load the selected Construction Detail.');
  }
  return result.data;
}

export function buildOutputModelPayload(
  config: AppConfig,
  state: SimulationState,
  product: Mpp_wl_productses,
  updatedBy: string,
  metadata: OutputModelSaveMetadata,
  updatedOn = new Date().toISOString(),
): OutputModelPayload {
  const derived = deriveMachineSpec(config.spec);
  const forecast = calculateSingleOperatorForecast(config);
  const plannedMachineMinutes = forecast.assignedMachineCount * Math.max(0, config.operator.shiftTime);
  const plannedDowntimeMinutes = Math.min(
    plannedMachineMinutes,
    forecast.activityContributions.reduce((total, contribution) => total + contribution.downtimeMinutes, 0) +
      forecast.forecastWaitingMinutes,
  );
  const plannedMachineEfficiency = plannedMachineMinutes > 0
    ? Math.max(0, ((plannedMachineMinutes - plannedDowntimeMinutes) / plannedMachineMinutes) * 100)
    : 0;
  const workedElapsed = Math.max(0, state.metrics.clockMin - state.metrics.breakElapsedMin);
  const actualBusyMinutes = Math.max(0, state.metrics.walkingMin + state.metrics.servicingMin);
  const actualManOccupation = percentage(actualBusyMinutes, workedElapsed);
  const totalRunningMachineMinutes = runningMachineMinutes(state);
  const runtimePerSpool = derived.runtimePerSpool > 0 ? derived.runtimePerSpool : 0;
  const totalSpool = runtimePerSpool > 0 ? totalRunningMachineMinutes / runtimePerSpool : 0;
  const tonageKg = totalSpool * Math.max(0, derived.spoolWeight);
  const tonage = tonageKg / 1000;
  const shiftHours = Math.max(0, config.operator.shiftTime) / 60;
  const scheduledMachineMinutes = state.metrics.assignedMachineCount * Math.max(0, config.operator.shiftTime);
  const actualMachineEfficiency = percentage(totalRunningMachineMinutes, scheduledMachineMinutes);
  const activityPercent = activityPercentages(state, workedElapsed);
  const totalFractureCount = countActivityEvents(state.metrics.completedByActivity, 'fractureRepairing');
  const totalDefectCount = countActivityEvents(state.metrics.completedByActivity, 'defectRepairing');
  const actualFracturePerTon = tonage > 0 ? totalFractureCount / tonage : 0;
  const actualDefectPerTon = tonage > 0 ? totalDefectCount / tonage : 0;
  const actualDiesPerTon = tonage > 0 ? state.metrics.diesChanged / tonage : 0;

  return {
    mpp_constructiondetailcode: product.mpp_constructiondetailcode ?? config.selectedConstructionDetail,
    mpp_construction: product.mpp_constructioncode,
    mpp_areacode: product.mpp_area ?? config.spec.area,
    mpp_machinecode: product.mpp_machinecode,
    mpp_productcode: product.mpp_productspecification,
    mpp_tensilegroup: product.mpp_tensilegroup,
    mpp_laylength: config.spec.layLength,
    mpp_spooltype: product.mpp_spooltype,
    mpp_spoollength: config.spec.spoolLength,
    mpp_nofwires: config.spec.noOfWires,
    mpp_speed: config.spec.speed,
    mpp_fractureperton: config.spec.fracturePerTon,
    mpp_defectperton: config.spec.defectsPerTon,
    mpp_diesperton: config.spec.diesPerTon,
    mpp_polength1: product.mpp_polength1,
    mpp_polength2: product.mpp_polength2,
    mpp_polength3: product.mpp_polength3,
    mpp_lineardensity: config.spec.linearDensity,
    mpp_twistperminute: derived.twistPerMin,
    mpp_spoolweight: derived.spoolWeight,
    mpp_linearspeed: derived.linearSpeed,
    mpp_runtimeperspool: derived.runtimePerSpool,
    mpp_taskpriority: config.operator.taskPriority,
    mpp_shifttime: config.operator.shiftTime,
    mpp_lunchtime: config.operator.lunchTime,
    mpp_lunchstarttime: config.operator.lunchStartAt,
    mpp_meetingtime: config.operator.meetingTime,
    mpp_meetingstarttime: config.operator.meetingStartAt,
    mpp_numberofmachinesassigned: state.metrics.assignedMachineCount,
    mpp_plannedmanoccupation: storedPercentage(forecast.forecastUtilizationPercent),
    mpp_actualmanoccupation: storedPercentage(actualManOccupation),
    mpp_tonspershift: tonage,
    mpp_plannedmachineefficiency: storedPercentage(plannedMachineEfficiency),
    mpp_actualmachineefficiency: storedPercentage(actualMachineEfficiency),
    mpp_manhoursperton: tonage > 0 ? shiftHours / tonage : 0,
    mpp_machinehoursperton: tonage > 0 ? (state.metrics.assignedMachineCount * shiftHours) / tonage : 0,
    mpp_totalspoolcount: totalSpool,
    mpp_actualfractureperton: actualFracturePerTon,
    mpp_actualdefectperton: actualDefectPerTon,
    mpp_actualdiesperton: actualDiesPerTon,
    mpp_doffingtime: storedPercentage(activityPercent.doffing),
    mpp_loadingtime: storedPercentage(activityPercent.loading),
    mpp_fracturerepairingtime: storedPercentage(activityPercent.fractureRepairing),
    mpp_defectrepairingtime: storedPercentage(activityPercent.defectRepairing),
    mpp_dieschangetime: storedPercentage(activityPercent.diesChange),
    mpp_walkingtime: storedPercentage(activityPercent.walking),
    mpp_othertime: storedPercentage(activityPercent.others),
    mpp_idle: storedPercentage(activityPercent.idle),
    mpp_updatedby: updatedBy,
    mpp_updatedon: updatedOn,
    mpp_version: metadata.version,
    mpp_versionremark: metadata.versionRemark?.trim() || undefined,
    mpp_startmachcondition: JSON.stringify(state.initialMachineConditions),
    statecode: 0,
  };
}

export async function prepareSimulationOutputModel(
  config: AppConfig,
  state: SimulationState,
  updatedBy: string,
  metadata: OutputModelSaveMetadata,
): Promise<OutputModelPayload> {
  if (!updatedBy.trim()) {
    throw new Error('The signed-in email is unavailable, so the WLM output cannot be saved.');
  }
  const product = await selectedProduct(config);
  if (!(product.mpp_constructiondetailcode ?? config.selectedConstructionDetail)?.trim()) {
    throw new Error('The selected Construction Detail is unavailable, so the WLM output cannot be saved.');
  }
  return buildOutputModelPayload(config, state, product, updatedBy, metadata);
}

export async function findOutputModelsForConstruction(constructionDetail: string) {
  const escapedDetail = escapeODataString(constructionDetail);
  const filteredRows = await fetchAllPages(Mpp_wl_outputmodelsesService.getAll, {
    filter: `mpp_constructiondetailcode eq '${escapedDetail}'`,
    orderBy: ['mpp_version asc', 'mpp_updatedon asc'],
  });
  if (filteredRows.length > 0) return filteredRows;

  const normalizedDetail = constructionDetail.trim().toLowerCase();
  const allRows = await fetchAllPages(Mpp_wl_outputmodelsesService.getAll, {
    orderBy: ['mpp_version asc', 'mpp_updatedon asc'],
  });
  return allRows.filter(
    (row) => row.mpp_constructiondetailcode?.trim().toLowerCase() === normalizedDetail,
  );
}

export async function createOutputModel(payload: OutputModelPayload): Promise<Mpp_wl_outputmodelses> {
  const result = await Mpp_wl_outputmodelsesService.create(payload);
  if (!result.success || !result.data) {
    throw new Error(result.error?.message ?? 'Failed to save WLM output model.');
  }
  return result.data;
}

export async function replaceOutputModel(
  id: string,
  payload: OutputModelPayload,
): Promise<Mpp_wl_outputmodelses> {
  const result = await Mpp_wl_outputmodelsesService.update(id, payload);
  if (!result.success || !result.data) {
    throw new Error(result.error?.message ?? 'Failed to replace the existing WLM output model.');
  }
  return result.data;
}
