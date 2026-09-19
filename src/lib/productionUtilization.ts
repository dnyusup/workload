import type { ActivityKey, ProductionSetup } from '../types';
import { availableTimeMinutes } from './calculations';
import { activityFamily, assignedOperatorIdForActivity } from './productionActivityRouting';
import type { ResolvedConstruction } from './productionConstructionResolver';

const AVERAGE_DIES_PER_CHANGE_EVENT = (7 + 26) / 2;

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
  plannedMinutes: number;
  utilizationPercent: number;
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

/** Calculates demand before a run using each assigned machine's resolved Construction. */
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
    utilizationPercent: 0,
    contributions: [] as PlannedActivityContribution[],
  }));
  const operatorByIdForLoad = new Map(operators.map((operator) => [operator.operatorId, operator]));
  const machines: PlannedMachineUtilization[] = [];
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
    const expectedSpools = setup.shiftTime / runtimePerSpool;
    const machineContributions: PlannedActivityContribution[] = [];

    construction.activities.forEach((activity) => {
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
          operator.contributions.push(contribution);
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
