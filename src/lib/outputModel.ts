import type { Mpp_wl_outputmodelses } from '../generated/models/Mpp_wl_outputmodelsesModel';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import { Mpp_wl_outputmodelsesService } from '../generated/services/Mpp_wl_outputmodelsesService';
import { Mpp_wl_productsesService } from '../generated/services/Mpp_wl_productsesService';
import { calculateSingleOperatorForecast } from './singleOperatorUtilization';
import { deriveMachineSpec } from './calculations';
import type { AppConfig, SimulationState } from '../types';
import type { Mpp_wl_outputmodelsesBase } from '../generated/models/Mpp_wl_outputmodelsesModel';

export type OutputModelPayload = Omit<Mpp_wl_outputmodelsesBase, 'mpp_wl_outputmodelsid'>;

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

function activityPercentages(state: SimulationState) {
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

  return {
    doffing: percentage(doffing, busyMinutes),
    loading: percentage(loading, busyMinutes),
    fractureRepairing: percentage(fractureRepairing, busyMinutes),
    defectRepairing: percentage(defectRepairing, busyMinutes),
    diesChange: percentage(diesChange, busyMinutes),
    walking: percentage(walking, busyMinutes),
    others: percentage(others, busyMinutes),
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
  const activityPercent = activityPercentages(state);
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
    mpp_plannedmanoccupation: forecast.forecastUtilizationPercent,
    mpp_actualmanoccupation: actualManOccupation,
    mpp_tonspershift: tonage,
    mpp_plannedmachineefficiency: plannedMachineEfficiency,
    mpp_actualmachineefficiency: actualMachineEfficiency,
    mpp_manhoursperton: tonage > 0 ? shiftHours / tonage : 0,
    mpp_machinehoursperton: tonage > 0 ? (state.metrics.assignedMachineCount * shiftHours) / tonage : 0,
    mpp_totalspoolcount: totalSpool,
    mpp_actualfractureperton: actualFracturePerTon,
    mpp_actualdefectperton: actualDefectPerTon,
    mpp_actualdiesperton: actualDiesPerTon,
    mpp_doffingtime: activityPercent.doffing,
    mpp_loadingtime: activityPercent.loading,
    mpp_fracturerepairingtime: activityPercent.fractureRepairing,
    mpp_defectrepairingtime: activityPercent.defectRepairing,
    mpp_dieschangetime: activityPercent.diesChange,
    mpp_walkingtime: activityPercent.walking,
    mpp_othertime: activityPercent.others,
    mpp_updatedby: updatedBy,
    mpp_updatedon: updatedOn,
    statecode: 0,
  };
}

export async function saveSimulationOutputModel(
  config: AppConfig,
  state: SimulationState,
  updatedBy: string,
): Promise<Mpp_wl_outputmodelses> {
  if (!updatedBy.trim()) {
    throw new Error('The signed-in email is unavailable, so the WLM output cannot be saved.');
  }
  const product = await selectedProduct(config);
  const result = await Mpp_wl_outputmodelsesService.create(buildOutputModelPayload(config, state, product, updatedBy));
  if (!result.success || !result.data) {
    throw new Error(result.error?.message ?? 'Failed to save WLM output model.');
  }
  return result.data;
}
