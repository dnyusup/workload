import type { ActivityConfig, AppConfig } from '../types';
import { activityCycleLength, availableTimeMinutes, deriveMachineSpec, distanceMeters } from './calculations';

const AVERAGE_DIES_PER_CHANGE_EVENT = (7 + 26) / 2;
const GLOBAL_EVENT_ACTIVITIES = new Set(['fractureRepairing', 'diesChange', 'defectRepairing']);

export interface ForecastActivityContribution {
  key: string;
  label: string;
  handlingMinutes: number;
  downtimeMinutes: number;
}

export interface SingleOperatorForecast {
  availableMinutes: number;
  plannedMinutes: number;
  forecastServiceMinutes: number;
  forecastWalkingMinutes: number;
  forecastWaitingMinutes: number;
  utilizationPercent: number;
  forecastUtilizationPercent: number;
  assignedMachineCount: number;
  expectedFinishedSpools: number;
  activityContributions: ForecastActivityContribution[];
}

function positiveFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function minutesPerSpool(activity: ActivityConfig): number {
  const cycle = activityCycleLength(activity);
  if (!Number.isFinite(cycle) || cycle <= 0) return 0;
  const eventRate = activity.key === 'diesChange'
    ? 1 / (cycle * AVERAGE_DIES_PER_CHANGE_EVENT)
    : 1 / cycle;
  return eventRate * Math.max(0, activity.timeMinutes);
}

function forecastScale(activities: ActivityConfig[], runtimePerSpool: number): number {
  const stopMinutesPerSpool = activities.reduce(
    (total, activity) => total + (activity.machCondition === 'run' ? 0 : minutesPerSpool(activity)),
    0,
  );
  return runtimePerSpool > 0 ? runtimePerSpool / (runtimePerSpool + stopMinutesPerSpool) : 1;
}

export function previewAssignedMachineIds(config: AppConfig, machineCount: number): string[] {
  const layoutById = new Map(config.layout.map((machine) => [machine.id, machine]));
  const explicitAssigned = (config.assignedMachineIds ?? []).filter((id) => layoutById.has(id));
  const handled = Math.max(0, Math.floor(machineCount));
  return [
    ...explicitAssigned.slice(0, handled),
    ...config.layout
      .filter((machine) => !explicitAssigned.includes(machine.id))
      .slice(0, Math.max(0, handled - explicitAssigned.length))
      .map((machine) => machine.id),
  ];
}

/**
 * Estimates the setup simulator's single operator using the same deterministic model as the
 * production utilization forecast. All assigned machines share one operator and global activities
 * are counted once across the line.
 */
export function calculateSingleOperatorForecast(config: AppConfig): SingleOperatorForecast {
  const availableMinutes = availableTimeMinutes(
    config.operator.shiftTime,
    config.operator.lunchTime,
    config.operator.meetingTime,
  );
  const handled = Math.max(0, Math.floor(config.operator.machHandled));
  // Use the explicit assignment first, then fill the requested count from the remaining layout
  // machines. This keeps the forecast responsive while the user is changing the count before
  // completing the Assign action in the Machine Layout step.
  const layoutById = new Map(config.layout.map((machine) => [machine.id, machine]));
  const assignedPreviewIds = previewAssignedMachineIds(config, handled);
  const assignedMachines = assignedPreviewIds
    .map((id) => layoutById.get(id))
    .filter((machine): machine is NonNullable<typeof machine> => !!machine);
  const derived = deriveMachineSpec(config.spec);
  const runtimePerSpool = positiveFinite(derived.runtimePerSpool);
  const expectedSpools = runtimePerSpool > 0 ? config.operator.shiftTime / runtimePerSpool : 0;
  const scale = forecastScale(config.activities, runtimePerSpool);
  const availableMachines = assignedMachines.length;

  let plannedMinutes = 0;
  let forecastServiceMinutes = 0;
  const visitsByMachine = new Map<string, number>();
  const activityContributions = new Map<string, ForecastActivityContribution>();
  const addActivityContribution = (activity: ActivityConfig, handlingMinutes: number) => {
    const existing = activityContributions.get(activity.key) ?? {
      key: activity.key,
      label: activity.label,
      handlingMinutes: 0,
      downtimeMinutes: 0,
    };
    existing.handlingMinutes += handlingMinutes;
    if (activity.machCondition !== 'run') existing.downtimeMinutes += handlingMinutes;
    activityContributions.set(activity.key, existing);
  };

  assignedMachines.forEach((machine) => {
    let machinePlannedMinutes = 0;
    let machineVisits = 0;
    config.activities.forEach((activity) => {
      if (GLOBAL_EVENT_ACTIVITIES.has(activity.key)) return;
      const cycle = activityCycleLength(activity);
      if (!Number.isFinite(cycle) || cycle <= 0 || expectedSpools <= 0) return;
      const occurrences = expectedSpools / cycle;
      const quantityBased = activity.key === 'diesChange';
      const quantity = quantityBased ? occurrences : 0;
      const eventCount = quantityBased ? quantity / AVERAGE_DIES_PER_CHANGE_EVENT : occurrences;
      const minutes = quantityBased
        ? quantity * Math.max(0, activity.timeMinutes)
        : eventCount * Math.max(0, activity.timeMinutes);
      machinePlannedMinutes += minutes;
      machineVisits = Math.max(machineVisits, eventCount);
      addActivityContribution(activity, minutes * scale);
    });
    plannedMinutes += machinePlannedMinutes;
    forecastServiceMinutes += machinePlannedMinutes * scale;
    visitsByMachine.set(machine.id, machineVisits * scale);
  });

  if (availableMachines > 0 && expectedSpools > 0) {
    const totalExpectedSpools = expectedSpools * availableMachines;
    config.activities.forEach((activity) => {
      if (!GLOBAL_EVENT_ACTIVITIES.has(activity.key)) return;
      const cycle = activityCycleLength(activity);
      if (!Number.isFinite(cycle) || cycle <= 0) return;
      const quantityBased = activity.key === 'diesChange';
      const totalQuantity = quantityBased ? totalExpectedSpools / cycle : 0;
      const totalEvents = quantityBased
        ? totalQuantity / AVERAGE_DIES_PER_CHANGE_EVENT
        : totalExpectedSpools / cycle;
      const minutes = quantityBased
        ? totalQuantity * Math.max(0, activity.timeMinutes)
        : totalEvents * Math.max(0, activity.timeMinutes);
      plannedMinutes += minutes;
      forecastServiceMinutes += minutes * scale;
      addActivityContribution(activity, minutes * scale);
      assignedMachines.forEach((machine) => {
        const machineEvents = totalEvents / availableMachines;
        visitsByMachine.set(machine.id, Math.max(visitsByMachine.get(machine.id) ?? 0, machineEvents * scale));
      });
    });
  }

  let forecastWalkingMinutes = 0;
  const walkingSpeed = positiveFinite(config.movement.walkingSpeed);
  const pixelsPerMeter = positiveFinite(config.movement.pixelsPerMeter);
  if (walkingSpeed > 0 && pixelsPerMeter > 0) {
    const start = config.operatorStart ?? { x: assignedMachines[0]?.x ?? 0, y: assignedMachines[0]?.y ?? 0 };
    const route = assignedMachines
      .map((machine) => ({ machine, visits: visitsByMachine.get(machine.id) ?? 0 }))
      .filter((entry) => entry.visits > 0)
      .sort(
        (left, right) =>
          distanceMeters(start.x, start.y, left.machine.x, left.machine.y, pixelsPerMeter) -
          distanceMeters(start.x, start.y, right.machine.x, right.machine.y, pixelsPerMeter),
      );
    if (route.length > 0) {
      const firstPassDistance = route.reduce(
        (total, entry, index) =>
          total +
          distanceMeters(
            index === 0 ? start.x : route[index - 1].machine.x,
            index === 0 ? start.y : route[index - 1].machine.y,
            entry.machine.x,
            entry.machine.y,
            pixelsPerMeter,
          ),
        0,
      );
      const cycleDistance = route.length > 1
        ? distanceMeters(
            route[route.length - 1].machine.x,
            route[route.length - 1].machine.y,
            route[0].machine.x,
            route[0].machine.y,
            pixelsPerMeter,
          )
        : 0;
      const totalVisits = route.reduce((total, entry) => total + entry.visits, 0);
      forecastWalkingMinutes =
        (firstPassDistance + Math.max(0, totalVisits / route.length - 1) * cycleDistance) / walkingSpeed;
    }
  }

  const forecastBusyMinutes = forecastServiceMinutes + forecastWalkingMinutes;
  return {
    availableMinutes,
    plannedMinutes,
    forecastServiceMinutes,
    forecastWalkingMinutes,
    forecastWaitingMinutes: Math.max(0, forecastBusyMinutes - availableMinutes),
    utilizationPercent: availableMinutes > 0 ? (plannedMinutes / availableMinutes) * 100 : 0,
    forecastUtilizationPercent: availableMinutes > 0
      ? Math.min(100, (forecastBusyMinutes / availableMinutes) * 100)
      : 0,
    assignedMachineCount: availableMachines,
    expectedFinishedSpools: expectedSpools * availableMachines * scale,
    activityContributions: [...activityContributions.values()],
  };
}

/** Finds the largest available machine count that still leaves no forecast backlog. */
export function recommendedMachineCountForForecast(config: AppConfig): number {
  if (config.layout.length === 0) return 0;

  let recommended = 0;
  for (let machineCount = 1; machineCount <= config.layout.length; machineCount += 1) {
    const forecast = calculateSingleOperatorForecast({
      ...config,
      operator: { ...config.operator, machHandled: machineCount },
    });
    if (forecast.forecastWaitingMinutes <= 0.0001) {
      recommended = machineCount;
    }
  }

  return recommended;
}
