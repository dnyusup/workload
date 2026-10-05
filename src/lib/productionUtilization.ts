import type { ActivityKey, ProductionSetup } from '../types';
import { applyRpc, availableTimeMinutes, distanceMeters } from './calculations';
import { activityFamily, eligibleOperatorIds, operatorSharesForActivity, TASK_OPERATOR_FIELDS, type TaskOperatorField } from './productionActivityRouting';
import type { ResolvedConstruction } from './productionConstructionResolver';
import { forecastCycleLength } from './frequencyTypes';
import { DEFAULT_WAITING_MODEL, machineInterference } from './singleOperatorUtilization';

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
  /** Machine time lost waiting for this operator: the larger of machine interference (the setup's
   * waiting model) and the backlog. Its machines then make fewer spools, so the forecast handling
   * and walking above are already reduced by it. */
  machineWaitingMinutes: number;
  utilizationPercent: number;
  forecastUtilizationPercent: number;
  contributions: PlannedActivityContribution[];
}

export interface PlannedMachineUtilization {
  machineId: string;
  machineLabel: string;
  constructionLabel: string;
  /** Share of the shift the machine runs after its Stop activities (the forecast scale). */
  availability: number;
  /** availability × the share left after waiting for its operator(s) — what its forecast events
   * (contributions' expectedOccurrences are at 100%) come out at. */
  oee: number;
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
function machineCapacityScale(construction: ResolvedConstruction, runtimePerSpool: number, spoolsPerShift: number): number {
  const stopMinutesPerSpool = construction.activities.reduce((total, activity) => {
    if ((activity.machCondition ?? 'stop') === 'run') return total;
    return total + activityMinutesPerProducedSpool(
      activity.key,
      activity.timeMinutes,
      forecastCycleLength(activity, construction.activities, spoolsPerShift),
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
    machineWaitingMinutes: 0,
    utilizationPercent: 0,
    forecastUtilizationPercent: 0,
    contributions: [] as PlannedActivityContribution[],
  }));
  const operatorByIdForLoad = new Map(operators.map((operator) => [operator.operatorId, operator]));
  const operatorVisits = new Map<string, Map<string, number>>();
  /** Per operator, the forecast scale (machine availability) of each machine it works. */
  const operatorMachineScales = new Map<string, Map<string, number>>();
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
  /** The one operator who does this activity on the machine, when there's exactly one. */
  const soleOperatorId = (assignment: ProductionSetup['assignments'][number] | undefined, activity: string) => {
    const ids = eligibleOperatorIds(assignment, activity);
    return ids.length === 1 ? ids[0] : undefined;
  };

  /** Books a contribution onto whoever handles it — split equally across everyone who may do it
   * (Multi Task plus that activity's Split Task operators) — or onto unassigned demand when nobody does. */
  const bookContribution = (
    contribution: PlannedActivityContribution,
    assignment: ProductionSetup['assignments'][number] | undefined,
    visits: number,
    forecastScale: number,
  ) => {
    const shares = operatorSharesForActivity(assignment, contribution.activityKey).filter(({ operatorId }) =>
      operatorById.has(operatorId),
    );
    if (shares.length === 0) {
      unassignedMinutes += contribution.plannedMinutes;
      return;
    }
    shares.forEach(({ operatorId, share }) => {
      const operator = operatorByIdForLoad.get(operatorId);
      if (!operator) return;
      const minutes = contribution.plannedMinutes * share;
      operator.plannedMinutes += minutes;
      operator.forecastServiceMinutes += minutes * forecastScale;
      operator.contributions.push(
        share === 1
          ? contribution
          : {
              ...contribution,
              operatorId,
              plannedMinutes: minutes,
              expectedOccurrences: contribution.expectedOccurrences * share,
              ...(contribution.expectedQuantity !== undefined ? { expectedQuantity: contribution.expectedQuantity * share } : {}),
            },
      );
      const scales = operatorMachineScales.get(operatorId) ?? new Map<string, number>();
      scales.set(contribution.machineId, forecastScale);
      operatorMachineScales.set(operatorId, scales);
      const visitsByMachine = operatorVisits.get(operatorId) ?? new Map<string, number>();
      visitsByMachine.set(contribution.machineId, Math.max(visitsByMachine.get(contribution.machineId) ?? 0, visits * share));
      operatorVisits.set(operatorId, visitsByMachine);
    });
  };

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
    const forecastScale = machineCapacityScale(construction, runtimePerSpool, expectedSpools);
    const machineContributions: PlannedActivityContribution[] = [];

    construction.activities.forEach((activity) => {
      // These activities are construction-wide in ProductionSimulationEngine. The engine
      // accumulates one spool counter per Construction and assigns each resulting event to one
      // random running machine. Counting them once per machine here inflated planned demand by
      // the number of machines sharing a Construction (the main source of the planned-vs-run
      // discrepancy).
      if (GLOBAL_EVENT_ACTIVITIES.has(activity.key)) return;
      const cycle = forecastCycleLength(activity, construction.activities, expectedSpools);
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
      // Handling includes the RPC allowance, as the simulation does it.
      const timeWithRpc = applyRpc(Math.max(0, activity.timeMinutes), setup.rpc);
      const plannedMinutes = quantityBased ? expectedQuantity * timeWithRpc : eventCount * timeWithRpc;
      if (plannedMinutes <= 0) return;

      const contribution: PlannedActivityContribution = {
        activityKey: activity.key,
        activityLabel: activity.label,
        family,
        machineId: machine.id,
        machineLabel: machine.label,
        constructionLabel: construction.label,
        operatorId: soleOperatorId(assignment, activity.key),
        expectedOccurrences: eventCount,
        ...(quantityBased ? { expectedQuantity } : {}),
        plannedMinutes,
      };
      machineContributions.push(contribution);
      bookContribution(contribution, assignment, expectedOccurrences * forecastScale, forecastScale);
    });

    machines.push({
      machineId: machine.id,
      machineLabel: machine.label,
      constructionLabel: construction.label,
      availability: forecastScale,
      oee: forecastScale,
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
        const timeWithRpc = applyRpc(Math.max(0, activity.timeMinutes), setup.rpc);
        const plannedMinutes = quantityBased
          ? (machineExpectedQuantity ?? 0) * timeWithRpc
          : machineEventCount * timeWithRpc;
        if (plannedMinutes <= 0) return;

        const contribution: PlannedActivityContribution = {
          activityKey: activity.key,
          activityLabel: activity.label,
          family: activityFamily(activity.key),
          machineId: machine.machineId,
          machineLabel: machine.machineLabel,
          constructionLabel: machine.constructionLabel,
          operatorId: soleOperatorId(assignment, activity.key),
          expectedOccurrences: machineEventCount,
          ...(quantityBased ? { expectedQuantity: machineExpectedQuantity } : {}),
          plannedMinutes,
        };
        machine.contributions.push(contribution);
        bookContribution(contribution, assignment, machineEventCount * forecastScale, forecastScale);
      });
    });
  });

  const layoutById = new Map(setup.layout.map((machine) => [machine.id, machine]));
  const startPoint = setup.operatorStart ?? { x: setup.layout[0]?.x ?? 0, y: setup.layout[0]?.y ?? 0 };
  const walkingSpeed = finitePositive(setup.movement.walkingSpeed);
  const pixelsPerMeter = finitePositive(setup.movement.pixelsPerMeter);

  /** Per operator, the share of the shift its machines still run after waiting for it. */
  const runningShareByOperator = new Map<string, number>();
  operators.forEach((operator) => {
    /** Walking for a given share of the visits: the first pass is walked anyway; only the rounds
     * after it shrink when machines make fewer spools (same as the Work Load Simulator forecast). */
    let walkingAt: (visitShare: number) => number = () => 0;
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
        walkingAt = (visitShare) => (firstPassDistance + Math.max(0, averageRounds * visitShare - 1) * cycleDistance) / walkingSpeed;
        operator.forecastWalkingMinutes = walkingAt(1);
      }
    }
    // Machines waiting for the operator make fewer spools, leaving the operator less to do, which
    // shortens the waiting — solved per operator the same way as the Work Load Simulator forecast.
    const scales = [...(operatorMachineScales.get(operator.operatorId)?.values() ?? [])];
    const machineCount = scales.length;
    const averageScale = machineCount > 0 ? scales.reduce((total, scale) => total + scale, 0) / machineCount : 0;
    const shift = Math.max(0, setup.shiftTime);
    const fullService = operator.forecastServiceMinutes;
    const waitingModel = setup.waitingModel ?? DEFAULT_WAITING_MODEL;
    const passAt = (waitingPerMachine: number) => {
      const runningShare = shift > 0 ? Math.max(0, shift - waitingPerMachine) / shift : 0;
      const busy = fullService * runningShare + walkingAt(runningShare);
      const backlog = Math.max(0, busy - availableMinutes);
      const interference = machineInterference(waitingModel, machineCount, shift * averageScale * runningShare, busy);
      return { runningShare, busy, backlog, waiting: Math.min(shift * machineCount, Math.max(backlog, interference.minutes)) };
    };
    let waitingPerMachine = 0;
    let pass = passAt(0);
    for (let i = 0; i < 100 && machineCount > 0; i += 1) {
      const produced = pass.waiting / machineCount;
      if (Math.abs(produced - waitingPerMachine) < 0.001) break;
      waitingPerMachine = (waitingPerMachine + produced) / 2;
      pass = passAt(waitingPerMachine);
    }
    operator.forecastServiceMinutes = fullService * pass.runningShare;
    operator.forecastWalkingMinutes = walkingAt(pass.runningShare);
    runningShareByOperator.set(operator.operatorId, pass.runningShare);
    operator.forecastWaitingMinutes = pass.backlog;
    operator.machineWaitingMinutes = waitingPerMachine * machineCount;
    operator.forecastUtilizationPercent = availableMinutes > 0
      ? Math.min(100, (pass.busy / availableMinutes) * 100)
      : 0;
  });

  operators.forEach((operator) => {
    operator.utilizationPercent = availableMinutes > 0 ? (operator.plannedMinutes / availableMinutes) * 100 : 0;
  });

  // A machine runs less when its operators keep it waiting — the average over the operators working it.
  const sharesByMachine = new Map<string, number[]>();
  operatorMachineScales.forEach((scales, operatorId) => {
    const share = runningShareByOperator.get(operatorId);
    if (share === undefined) return;
    scales.forEach((_, machineId) => {
      const list = sharesByMachine.get(machineId) ?? [];
      list.push(share);
      sharesByMachine.set(machineId, list);
    });
  });
  machines.forEach((machine) => {
    const shares = sharesByMachine.get(machine.machineId);
    const runningShare = shares && shares.length > 0 ? shares.reduce((total, share) => total + share, 0) / shares.length : 1;
    machine.oee = machine.availability * runningShare;
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

export interface SelectionOccupationRow {
  key: 'all' | NonNullable<ReturnType<typeof activityFamily>>;
  label: string;
  plannedMinutes: number;
  forecastUtilizationPercent: number;
  utilizationPercent: number;
}

export interface SelectionOccupation {
  availableMinutes: number;
  machineCount: number;
  /** Selected machines with a resolved Construction — the only ones that add demand. */
  plannedMachineCount: number;
  constructionLabels: string[];
  allTask: SelectionOccupationRow;
  activities: SelectionOccupationRow[];
}

const SELECTION_FAMILIES: { key: NonNullable<ReturnType<typeof activityFamily>>; label: string; field: TaskOperatorField }[] = [
  { key: 'doffing', label: 'Doffing', field: TASK_OPERATOR_FIELDS.doffing },
  { key: 'loading', label: 'Loading', field: TASK_OPERATOR_FIELDS.loading },
  { key: 'fractureRepairing', label: 'Fracture Repairing', field: TASK_OPERATOR_FIELDS.fractureRepairing },
  { key: 'diesChange', label: 'Dies Change', field: TASK_OPERATOR_FIELDS.diesChange },
  { key: 'defectRepairing', label: 'Defect Repairing', field: TASK_OPERATOR_FIELDS.defectRepairing },
];

/** Man occupation of one hypothetical operator handling the selected machines — "All Task" does
 * every activity, each activity row handles only that family. Runs calculatePlannedUtilization on
 * a setup restricted to the selection, so each machine uses its own Construction. Construction-wide
 * events (fracture/dies/defect) are distributed by spool share, which is linear, so restricting the
 * layout yields exactly the selected machines' share. */
export function calculateSelectionOccupation(
  setup: ProductionSetup,
  resolved: Map<string, ResolvedConstruction>,
  machineIds: string[],
): SelectionOccupation {
  const selected = new Set(machineIds);
  const layout = setup.layout.filter((machine) => selected.has(machine.id));
  const ALL = '__selection_all__';
  const familyOperatorId = (key: string) => `__selection_${key}__`;
  const assignments = setup.assignments
    .filter((assignment) => selected.has(assignment.machineId))
    .map((assignment) => ({
      machineId: assignment.machineId,
      constructionDetailId: assignment.constructionDetailId,
      constructionDetailLabel: assignment.constructionDetailLabel,
    }));
  const scopedSetup: ProductionSetup = {
    ...setup,
    layout,
    // Keep the real start point so walking is measured from where operators actually begin.
    operatorStart: setup.operatorStart ?? (setup.layout[0] ? { x: setup.layout[0].x, y: setup.layout[0].y } : undefined),
  };

  const allTaskResult = calculatePlannedUtilization(
    {
      ...scopedSetup,
      operators: [{ id: ALL, label: 'All Task' }],
      assignments: assignments.map((assignment) => ({ ...assignment, assignedOperatorIds: [ALL] })),
    },
    resolved,
  );
  const splitResult = calculatePlannedUtilization(
    {
      ...scopedSetup,
      operators: SELECTION_FAMILIES.map((family) => ({ id: familyOperatorId(family.key), label: family.label })),
      assignments: assignments.map((assignment) => ({
        ...assignment,
        ...Object.fromEntries(SELECTION_FAMILIES.map((family) => [family.field, [familyOperatorId(family.key)]])),
      })),
    },
    resolved,
  );

  const toRow = (
    key: SelectionOccupationRow['key'],
    label: string,
    operator: PlannedOperatorUtilization | undefined,
  ): SelectionOccupationRow => ({
    key,
    label,
    plannedMinutes: operator?.plannedMinutes ?? 0,
    forecastUtilizationPercent: operator?.forecastUtilizationPercent ?? 0,
    utilizationPercent: operator?.utilizationPercent ?? 0,
  });
  const splitById = new Map(splitResult.operators.map((operator) => [operator.operatorId, operator]));

  return {
    availableMinutes: allTaskResult.availableMinutes,
    machineCount: layout.length,
    plannedMachineCount: allTaskResult.machines.length,
    constructionLabels: [...new Set(allTaskResult.machines.map((machine) => machine.constructionLabel))],
    allTask: toRow('all', 'All Task', allTaskResult.operators[0]),
    activities: SELECTION_FAMILIES.map((family) =>
      toRow(family.key, family.label, splitById.get(familyOperatorId(family.key))),
    ),
  };
}
