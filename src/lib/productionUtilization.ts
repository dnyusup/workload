import type { ActivityKey, ProductionSetup } from '../types';
import { availableTimeMinutes, distanceMeters } from './calculations';
import { activityFamily, assignedOperatorIdForActivity } from './productionActivityRouting';
import type { ResolvedConstruction } from './productionConstructionResolver';

const AVERAGE_DIES_PER_CHANGE_EVENT = (7 + 26) / 2;
const GLOBAL_EVENT_ACTIVITIES = new Set(['fractureRepairing', 'diesChange', 'defectRepairing']);

export interface PlannedActivityContribution {
  activityKey: ActivityKey;
  activityLabel: string;
  family: ReturnType<typeof activityFamily>;
  machineId: string;
  machineLabel: string;
  constructionLabel: string;
  operatorId?: string;
  expectedOccurrences: number;
  expectedQuantity?: number;
  plannedMinutes: number;
}

export interface PlannedOperatorUtilization {
  operatorId: string;
  operatorLabel: string;
  availableMinutes: number;
  /** Ideal due-work at nominal machine output; this is the capacity requirement. */
  plannedMinutes: number;
  /** Deterministic forecast after machine stop time and estimated inter-machine walking. */
  forecastServiceMinutes: number;
  forecastWalkingMinutes: number;
  /** Work that would remain queued after the net available operator time is consumed. */
  forecastWaitingMinutes: number;
  utilizationPercent: number;
  forecastUtilizationPercent: number;
  contributions: PlannedActivityContribution[];
}

export interface PlannedMachineUtilization {
  machineId: string;
  machineLabel: string;
  constructionLabel: string;
  contributions: PlannedActivityContribution[];
}

export interface PlannedUtilization {
  availableMinutes: number;
  targetPercent: number;
  operators: PlannedOperatorUtilization[];
  machines: PlannedMachineUtilization[];
  unassignedMinutes: number;
  unresolvedMachineIds: string[];
}

function finitePositive(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function activityMinutesPerProducedSpool(
  activityKey: ActivityKey,
  activityTimeMinutes: number,
  cycle: number | undefined,
): number {
  if (!Number.isFinite(cycle) || (cycle ?? 0) <= 0) return 0;
  const eventRate = activityKey === 'diesChange'
    ? 1 / ((cycle as number) * AVERAGE_DIES_PER_CHANGE_EVENT)
    : 1 / (cycle as number);
  return eventRate * Math.max(0, activityTimeMinutes);
}

/**
 * Estimates the fraction of nominal spool output that remains after machine-stop work.
 * This is deliberately deterministic and does not try to reproduce the engine's random initial
 * spool phase or dispatch order. Waiting caused by an operator queue is reported separately as
 * forecastWaitingMinutes; adding that time to man occupation would mix machine downtime
 * with labor time.
 */
function machineCapacityScale(construction: ResolvedConstruction, runtimePerSpool: number): number {
  const stopMinutesPerSpool = construction.activities.reduce((total, activity) => {
    if ((activity.machCondition ?? 'stop') === 'run') return total;
    return total + activityMinutesPerProducedSpool(
      activity.key,
      activity.timeMinutes,
      construction.cycleLengths[activity.key],
    );
  }, 0);
  return runtimePerSpool > 0 ? runtimePerSpool / (runtimePerSpool + stopMinutesPerSpool) : 1;
}

/** Calculates expected operator handling before a run using the same event ownership rules as the
 * production engine. Machine queue/waiting is deliberately not added to operator minutes: it is
 * machine downtime and reduces later production events rather than occupying an operator. The
 * returned forecast adds deterministic machine-stop and inter-machine walking estimates, while
 * retaining the ideal due-work total so an overload is not hidden. */
export function calculatePlannedUtilization(
  setup: ProductionSetup,
  resolved: Map<string, ResolvedConstruction>,
): PlannedUtilization {
  const availableMinutes = availableTimeMinutes(setup.shiftTime, setup.lunchTime, setup.meetingTime);
  const operatorById = new Map(setup.operators.map((operator) => [operator.id, operator]));
  const assignmentByMachine = new Map(setup.assignments.map((assignment) => [assignment.machineId, assignment]));
  const operators = setup.operators.map((operator) => ({
    operatorId: operator.id,
    operatorLabel: operator.label,
    availableMinutes,
    plannedMinutes: 0,
    forecastServiceMinutes: 0,
    forecastWalkingMinutes: 0,
    forecastWaitingMinutes: 0,
    utilizationPercent: 0,
    forecastUtilizationPercent: 0,
    contributions: [] as PlannedActivityContribution[],
  }));
  const operatorByIdForLoad = new Map(operators.map((operator) => [operator.operatorId, operator]));
  const operatorVisits = new Map<string, Map<string, number>>();
  const machines: PlannedMachineUtilization[] = [];
  const machinePlansByConstruction = new Map<
    string,
    {
      machine: PlannedMachineUtilization;
      assignment: ProductionSetup['assignments'][number] | undefined;
      expectedSpools: number;
      construction: ResolvedConstruction;
      forecastScale: number;
    }[]
  >();
  const unresolvedMachineIds: string[] = [];
  let unassignedMinutes = 0;

  setup.layout.forEach((machine) => {
    const assignment = assignmentByMachine.get(machine.id);
    const constructionId = assignment?.constructionDetailId;
    if (!constructionId) return;
    const construction = resolved.get(constructionId);
    if (!construction) {
      unresolvedMachineIds.push(machine.id);
      return;
    }

    const runtimePerSpool = finitePositive(construction.runtimePerSpool);
    if (!runtimePerSpool) {
      unresolvedMachineIds.push(machine.id);
      return;
    }
    // The engine's random startSpools only shifts the phase of normal periodic tasks. Averaged
    // over that phase, the expected count during a shift is still shiftTime / runtime / cycle,
    // so subtracting an arbitrary "half cycle" would bias the forecast downward.
    const expectedSpools = setup.shiftTime / runtimePerSpool;
    const forecastScale = machineCapacityScale(construction, runtimePerSpool);
    const machineContributions: PlannedActivityContribution[] = [];

    construction.activities.forEach((activity) => {
      // These activities are construction-wide in ProductionSimulationEngine. The engine
      // accumulates one spool counter per Construction and assigns each resulting event to one
      // random running machine. Counting them once per machine here inflated planned demand by
      // the number of machines sharing a Construction (the main source of the planned-vs-run
      // discrepancy).
      if (GLOBAL_EVENT_ACTIVITIES.has(activity.key)) return;
      const cycle = construction.cycleLengths[activity.key];
      if (!Number.isFinite(cycle) || cycle <= 0 || expectedSpools <= 0) return;
      const expectedOccurrences = expectedSpools / cycle;
      const family = activityFamily(activity.key);

      // Dies Change is scheduled as a 7- or 26-die event by the simulator. Its cycle length
      // represents individual dies, so convert the quantity into the same average event count.
      const quantityBased = family === 'diesChange';
      const expectedQuantity = quantityBased ? expectedOccurrences : 0;
      const eventCount = !quantityBased
        ? expectedOccurrences
        : expectedQuantity / AVERAGE_DIES_PER_CHANGE_EVENT;
      const plannedMinutes = quantityBased
        ? expectedQuantity * Math.max(0, activity.timeMinutes)
        : eventCount * Math.max(0, activity.timeMinutes);
      if (plannedMinutes <= 0) return;

      const operatorId = assignedOperatorIdForActivity(assignment, activity.key);
      const contribution: PlannedActivityContribution = {
        activityKey: activity.key,
        activityLabel: activity.label,
        family,
        machineId: machine.id,
        machineLabel: machine.label,
        constructionLabel: construction.label,
        operatorId,
        expectedOccurrences: eventCount,
        ...(quantityBased ? { expectedQuantity } : {}),
        plannedMinutes,
      };
      machineContributions.push(contribution);
      if (operatorId && operatorById.has(operatorId)) {
        const operator = operatorByIdForLoad.get(operatorId);
        if (operator) {
          operator.plannedMinutes += plannedMinutes;
          operator.forecastServiceMinutes += plannedMinutes * forecastScale;
          operator.contributions.push(contribution);
          const visitsByMachine = operatorVisits.get(operatorId) ?? new Map<string, number>();
          visitsByMachine.set(
            machine.id,
            Math.max(visitsByMachine.get(machine.id) ?? 0, expectedOccurrences * forecastScale),
          );
          operatorVisits.set(operatorId, visitsByMachine);
        }
      } else {
        unassignedMinutes += plannedMinutes;
      }
    });

    machines.push({
      machineId: machine.id,
      machineLabel: machine.label,
      constructionLabel: construction.label,
      contributions: machineContributions,
    });
    const plannedMachine = machines[machines.length - 1];
    const group = machinePlansByConstruction.get(constructionId) ?? [];
    group.push({ machine: plannedMachine, assignment, expectedSpools, construction, forecastScale });
    machinePlansByConstruction.set(constructionId, group);
  });

  // Fracture, dies and defect events use the same construction-wide counters as the simulation
  // engine. Distribute the expected group workload back to machines by their share of theoretical
  // spool production so that per-machine rows and operator assignments remain useful, while the
  // total is counted exactly once per Construction.
  machinePlansByConstruction.forEach((group) => {
    const totalExpectedSpools = group.reduce((sum, item) => sum + item.expectedSpools, 0);
    if (totalExpectedSpools <= 0) return;
    const construction = group[0].construction;
    const activitiesByKey = new Map(construction.activities.map((activity) => [activity.key, activity]));

    GLOBAL_EVENT_ACTIVITIES.forEach((activityKey) => {
      const activity = activitiesByKey.get(activityKey);
      const cycle = activity ? construction.cycleLengths[activityKey] : undefined;
      if (!activity || !Number.isFinite(cycle) || (cycle ?? 0) <= 0) return;

      const quantityBased = activityKey === 'diesChange';
      const expectedQuantity = quantityBased ? totalExpectedSpools / (cycle as number) : undefined;
      const eventCount = quantityBased
        ? (expectedQuantity ?? 0) / AVERAGE_DIES_PER_CHANGE_EVENT
        : totalExpectedSpools / (cycle as number);
      if (eventCount <= 0) return;

      group.forEach(({ machine, assignment, expectedSpools, forecastScale }) => {
        const share = expectedSpools / totalExpectedSpools;
        const machineExpectedQuantity = quantityBased ? (expectedQuantity ?? 0) * share : undefined;
        const machineEventCount = eventCount * share;
        const plannedMinutes = quantityBased
          ? (machineExpectedQuantity ?? 0) * Math.max(0, activity.timeMinutes)
          : machineEventCount * Math.max(0, activity.timeMinutes);
        if (plannedMinutes <= 0) return;

        const operatorId = assignedOperatorIdForActivity(assignment, activity.key);
        const contribution: PlannedActivityContribution = {
          activityKey: activity.key,
          activityLabel: activity.label,
          family: activityFamily(activity.key),
          machineId: machine.machineId,
          machineLabel: machine.machineLabel,
          constructionLabel: machine.constructionLabel,
          operatorId,
          expectedOccurrences: machineEventCount,
          ...(quantityBased ? { expectedQuantity: machineExpectedQuantity } : {}),
          plannedMinutes,
        };
        machine.contributions.push(contribution);
        if (operatorId && operatorById.has(operatorId)) {
          const operator = operatorByIdForLoad.get(operatorId);
          if (operator) {
            operator.plannedMinutes += plannedMinutes;
            operator.forecastServiceMinutes += plannedMinutes * forecastScale;
            operator.contributions.push(contribution);
            const visitsByMachine = operatorVisits.get(operatorId) ?? new Map<string, number>();
            visitsByMachine.set(
              machine.machineId,
              Math.max(visitsByMachine.get(machine.machineId) ?? 0, machineEventCount * forecastScale),
            );
            operatorVisits.set(operatorId, visitsByMachine);
          }
        } else {
          unassignedMinutes += plannedMinutes;
        }
      });
    });
  });

  const layoutById = new Map(setup.layout.map((machine) => [machine.id, machine]));
  const startPoint = setup.operatorStart ?? { x: setup.layout[0]?.x ?? 0, y: setup.layout[0]?.y ?? 0 };
  const walkingSpeed = finitePositive(setup.movement.walkingSpeed);
  const pixelsPerMeter = finitePositive(setup.movement.pixelsPerMeter);

  operators.forEach((operator) => {
    const visitsByMachine = operatorVisits.get(operator.operatorId);
    if (visitsByMachine && walkingSpeed > 0 && pixelsPerMeter > 0) {
      const routeMachines = [...visitsByMachine.entries()]
        .map(([machineId, visits]) => ({ machine: layoutById.get(machineId), visits }))
        .filter((entry): entry is { machine: NonNullable<typeof entry.machine>; visits: number } => !!entry.machine && entry.visits > 0)
        .sort((a, b) => {
          const aDistance = distanceMeters(startPoint.x, startPoint.y, a.machine.x, a.machine.y, pixelsPerMeter);
          const bDistance = distanceMeters(startPoint.x, startPoint.y, b.machine.x, b.machine.y, pixelsPerMeter);
          return aDistance - bDistance;
        });
      if (routeMachines.length > 0) {
        const firstPassDistance = routeMachines.reduce(
          (total, entry, index) =>
            total +
            distanceMeters(
              index === 0 ? startPoint.x : routeMachines[index - 1].machine.x,
              index === 0 ? startPoint.y : routeMachines[index - 1].machine.y,
              entry.machine.x,
              entry.machine.y,
              pixelsPerMeter,
            ),
          0,
        );
        const cycleDistance = routeMachines.length > 1
          ? distanceMeters(
              routeMachines[routeMachines.length - 1].machine.x,
              routeMachines[routeMachines.length - 1].machine.y,
              routeMachines[0].machine.x,
              routeMachines[0].machine.y,
              pixelsPerMeter,
            )
          : 0;
        const totalVisits = routeMachines.reduce((total, entry) => total + entry.visits, 0);
        const averageRounds = totalVisits / routeMachines.length;
        const estimatedDistance = firstPassDistance + Math.max(0, averageRounds - 1) * cycleDistance;
        operator.forecastWalkingMinutes = estimatedDistance / walkingSpeed;
      }
    }
    const forecastBusyMinutes = operator.forecastServiceMinutes + operator.forecastWalkingMinutes;
    operator.forecastWaitingMinutes = Math.max(0, forecastBusyMinutes - availableMinutes);
    operator.forecastUtilizationPercent = availableMinutes > 0
      ? Math.min(100, (forecastBusyMinutes / availableMinutes) * 100)
      : 0;
  });

  operators.forEach((operator) => {
    operator.utilizationPercent = availableMinutes > 0 ? (operator.plannedMinutes / availableMinutes) * 100 : 0;
  });

  return {
    availableMinutes,
    targetPercent: 85,
    operators,
    machines,
    unassignedMinutes,
    unresolvedMachineIds,
  };
}
