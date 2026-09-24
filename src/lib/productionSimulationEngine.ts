import type {
  ActivityConfig,
  ActivityKey,
  EventLogEntry,
  MachineRuntimeState,
  MachineTimelineKind,
  MachineTimelineSegment,
  OperatorTimelineKind,
  PendingTask,
  ProductionOperatorRuntimeState,
  ProductionSetup,
  ProductionSimMetrics,
  ProductionSimulationState,
} from '../types';
import { availableTimeMinutes, deriveMachineSpec, distanceMeters } from './calculations';
import { machineWidthPx, machineHeightPx } from './layoutConstants';
import { buildServiceSegments } from './machineZones';
import { computeWalkingWaypoints, createRoutingRowCache, type RoutingRowCache } from './operatorRouting';
import { activityFamily, assignedOperatorIdForActivity } from './productionActivityRouting';
import type { ResolvedConstruction } from './productionConstructionResolver';

function emptyCounts(activities: ActivityConfig[]): Record<ActivityKey, number> {
  return Object.fromEntries(activities.map((a) => [a.key, 0]));
}

const GLOBAL_EVENT_ACTIVITIES = new Set(['fractureRepairing', 'diesChange', 'defectRepairing']);
const AVERAGE_DIES_PER_CHANGE_EVENT = (7 + 26) / 2;

/** Root activity family an activity key belongs to (doffing / loading / fractureRepairing),
 * matching the `<family>` / `<family>-sub-*` / `<family>-*` key conventions used throughout the
 * app (see productCatalog.ts) — this decides which of a machine assignment's three operator slots
 * a given task is routed to. */
interface ProdMachine extends MachineRuntimeState {
  constructionId: string | null;
  cycleLengths: Record<ActivityKey, number>;
  activities: ActivityConfig[];
  runtimePerSpool: number;
  spoolWeight: number;
  /** Which operator currently "owns" a visit to this machine — prevents two operators from
   * servicing the same machine at once even though different activities on it can belong to
   * different operators. Released once that operator finishes its visit. */
  lockedByOperatorId: string | null;
}

interface BreakDef {
  label: string;
  startAt: number;
  duration: number;
  done: boolean;
}

/** Fracture Repairing's own regulation, scoped per Construction (not per machine, and not one
 * single line-wide pool across every Construction): every machine running the SAME Construction
 * shares one cumulative spool counter, and once that group's own Fracture/Ton cycle is reached the
 * event lands on a random currently-running machine within that same Construction group — mirrors
 * simulationEngine.ts's single global counter, just partitioned per Construction instead of one
 * pool for the whole layout, since different Constructions have different Fracture/Ton rates. */
interface ConstructionFractureState {
  cycle: number;
  globalSpoolsCompleted: number;
  fractureEventsTriggered: number;
  diesChangeCycle: number;
  diesChangeEventsTriggered: number;
  plannedDies: number;
  scheduledDies: number;
  defectRepairingCycle: number;
  defectRepairingEventsTriggered: number;
}

function findActivity(activities: ActivityConfig[], key: ActivityKey): ActivityConfig {
  return (
    activities.find((a) => a.key === key) ?? {
      key,
      label: key,
      timeMinutes: 0,
      numerator: 1,
      numeratorAuto: false,
      denominator: Infinity,
      denominatorAuto: false,
      machCondition: 'stop',
    }
  );
}

function isStopActivity(activities: ActivityConfig[], key: ActivityKey): boolean {
  return (findActivity(activities, key).machCondition ?? 'stop') !== 'run';
}

function dueBreakKind(label: string | null): 'lunch' | 'meeting' {
  return label?.toLowerCase().includes('meeting') ? 'meeting' : 'lunch';
}

export class ProductionSimulationEngine {
  private setup: ProductionSetup;
  private machines: ProdMachine[];
  private operators: ProductionOperatorRuntimeState[];
  private breaksByOperator: Map<string, BreakDef[]> = new Map();
  private metrics: ProductionSimMetrics;
  private log: EventLogEntry[] = [];
  private logIdCounter = 0;
  private warnings: string[] = [];
  private warnedNoOperator = new Set<string>();
  private routeCache: RoutingRowCache = createRoutingRowCache();
  private fractureByConstruction = new Map<string, ConstructionFractureState>();
  private constructionLabelById = new Map<string, string>();
  /** Rebuilt once per tick sub-step (see tick()) — machineId → the operator currently servicing
   * it, if any. accumulateDowntime and recordMachineTime both need this lookup for EVERY machine
   * every sub-step; scanning `this.operators` per machine would make a full tick pass cost
   * O(machines × operators), which gets expensive fast at real-factory scale (~1500 machines ×
   * ~80 operators = 120k scans per sub-step). Building this map costs O(operators) once instead. */
  private servicingOperatorByMachineId = new Map<string, ProductionOperatorRuntimeState>();
  /** Built once at construction time (assignments never change mid-run) so per-Construction
   * fracture logic never has to re-filter the full machine list every tick sub-step. */
  private machinesByConstruction = new Map<string, ProdMachine[]>();

  constructor(setup: ProductionSetup, resolved: Map<string, ResolvedConstruction>, resolveErrors: string[] = []) {
    this.setup = setup;
    this.warnings.push(...resolveErrors);

    const assignmentByMachine = new Map(setup.assignments.map((a) => [a.machineId, a]));

    this.machines = setup.layout.map((m) => {
      const assignment = assignmentByMachine.get(m.id);
      const construction: ResolvedConstruction | undefined = assignment?.constructionDetailId
        ? resolved.get(assignment.constructionDetailId)
        : undefined;
      const assigned = construction !== undefined;
      const runtimePerSpool = construction ? construction.runtimePerSpool || 1 : 1;
      const spoolWeight = construction ? deriveMachineSpec(construction.spec).spoolWeight : 0;
      const activities = construction ? construction.activities : [];
      const theoreticalSpoolsPerShift = assigned ? Math.max(1, Math.floor(setup.shiftTime / runtimePerSpool)) : 0;
      // Phase spans the longest count-based cycle (see the same note in simulationEngine.ts) so a
      // Loading cycle longer than one shift's spools isn't under-sampled at shift start.
      const longestCycle = activities
        .filter((activity) => !GLOBAL_EVENT_ACTIVITIES.has(activity.key) && !activity.loadingInterrupt)
        .reduce((max, activity) => {
          const cycle = construction?.cycleLengths[activity.key];
          return cycle !== undefined && Number.isFinite(cycle) && cycle > max ? cycle : max;
        }, 0);
      const startPhaseRange = Math.max(theoreticalSpoolsPerShift, Math.ceil(longestCycle));
      const startSpools = assigned ? Math.floor(Math.random() * startPhaseRange) : 0;
      const completedByActivity = emptyCounts(activities);
      activities.forEach(({ key }) => {
        const cycle = construction ? construction.cycleLengths[key] : undefined;
        completedByActivity[key] = Number.isFinite(cycle) && (cycle ?? 0) > 0 ? Math.floor(startSpools / cycle!) : 0;
      });

      const machine: ProdMachine = {
        id: m.id,
        label: m.label,
        x: m.x + machineWidthPx(m, setup.movement.pixelsPerMeter) / 2,
        y: m.y + machineHeightPx(m, setup.movement.pixelsPerMeter) / 2,
        type: m.type,
        orientation: m.orientation,
        pairSide: m.pairSide,
        widthPx: machineWidthPx(m, setup.movement.pixelsPerMeter),
        heightPx: machineHeightPx(m, setup.movement.pixelsPerMeter),
        status: assigned ? 'running' : 'unassigned',
        spoolsCompleted: startSpools,
        shiftSpoolsCompleted: 0,
        spoolsSinceLoading: (() => {
          const loading = activities.find((activity) => activity.key === 'loading');
          const loadingCycle = construction?.cycleLengths.loading;
          if (loading?.loadingInterrupt && Number.isFinite(loadingCycle) && (loadingCycle ?? 0) > 0) {
            return Math.random() * loadingCycle!;
          }
          return startSpools;
        })(),
        nextCompletionAt: assigned ? Math.random() * runtimePerSpool : runtimePerSpool,
        pendingTasks: [],
        queuedSince: null,
        totalServiced: 0,
        completedByActivity,
        downtimeMin: 0,
        downtimeByReason: { ...emptyCounts(activities), waiting: 0 },
        timeline: [],
        runtimePaused: false,
        runtimeRemainingMin: null,
        constructionId: assignment?.constructionDetailId ?? null,
        cycleLengths: construction ? construction.cycleLengths : {},
        activities,
        runtimePerSpool,
        spoolWeight,
        lockedByOperatorId: null,
      };
      return machine;
    });

    resolved.forEach((construction, id) => this.constructionLabelById.set(id, construction.label));
    this.machines.forEach((m) => {
      if (!m.constructionId) return;
      const list = this.machinesByConstruction.get(m.constructionId);
      if (list) list.push(m);
      else this.machinesByConstruction.set(m.constructionId, [m]);
    });
    const constructionIds = new Set(this.machines.map((m) => m.constructionId).filter((id): id is string => !!id));
    constructionIds.forEach((id) => {
      const groupMachines = this.machinesByConstruction.get(id) ?? [];
      const cycle = groupMachines[0]?.cycleLengths.fractureRepairing ?? Infinity;
      const initialSpools = groupMachines.reduce((sum, m) => sum + m.spoolsCompleted, 0);
      const diesChangeCycle = groupMachines[0]?.cycleLengths.diesChange ?? Infinity;
      const diesActivity = groupMachines[0]?.activities.find((activity) => activity.key === 'diesChange');
      const plannedDies =
        diesActivity && diesActivity.numerator > 0
          ? (groupMachines.length *
              setup.shiftTime /
              Math.max(1, groupMachines[0]?.runtimePerSpool ?? 1) *
              (groupMachines[0]?.spoolWeight ?? 0) *
              diesActivity.numerator) /
            1000
          : 0;
      const defectRepairingCycle = groupMachines[0]?.cycleLengths.defectRepairing ?? Infinity;
      const expectedDiesEvents = plannedDies > 0 ? Math.ceil(plannedDies / AVERAGE_DIES_PER_CHANGE_EVENT) : 0;
      const totalTheoreticalSpools =
        (setup.shiftTime / Math.max(1, groupMachines[0]?.runtimePerSpool ?? 1)) * groupMachines.length;
      this.fractureByConstruction.set(id, {
        cycle,
        globalSpoolsCompleted: initialSpools,
        fractureEventsTriggered: Number.isFinite(cycle) && cycle > 0 ? Math.floor(initialSpools / cycle) : 0,
        diesChangeCycle,
        diesChangeEventsTriggered:
          expectedDiesEvents > 0
            ? Math.floor(initialSpools / Math.max(1, totalTheoreticalSpools / expectedDiesEvents))
            : 0,
        plannedDies,
        scheduledDies: 0,
        defectRepairingCycle,
        defectRepairingEventsTriggered:
          Number.isFinite(defectRepairingCycle) && defectRepairingCycle > 0 ? Math.floor(initialSpools / defectRepairingCycle) : 0,
      });
    });

    // All operators begin the shift standing at the layout's single configured start point, if
    // one was set (see AppConfig.operatorStart / SavedLayout.operatorStart); otherwise fall back
    // to the first machine's position, same as the single-operator Simulator.
    const initialX = setup.operatorStart?.x ?? this.machines[0]?.x ?? 0;
    const initialY = setup.operatorStart?.y ?? this.machines[0]?.y ?? 0;
    this.operators = setup.operators.map((op) => ({
      id: op.id,
      label: op.label,
      x: initialX,
      y: initialY,
      phase: 'idle',
      targetMachineId: null,
      targetMachineLabel: null,
      fromX: 0,
      fromY: 0,
      toX: 0,
      toY: 0,
      walkProgress: 0,
      walkDurationMin: 0,
      pendingWaypoints: [],
      plannedRoute: [],
      serviceTasks: [],
      serviceSegments: [],
      serviceSubPhase: null,
      currentZoneLabel: null,
      zoneMoveFromX: 0,
      zoneMoveFromY: 0,
      zoneMoveToX: 0,
      zoneMoveToY: 0,
      zoneMoveProgress: 0,
      zoneMoveDurationMin: 0,
      zoneDwellRemainingMin: 0,
      breakLabel: null,
      breakRemainingMin: 0,
      timeline: [],
    }));

    this.operators.forEach((op) => {
      this.breaksByOperator.set(
        op.id,
        [
          { label: 'Lunch Time', startAt: Math.max(0, setup.lunchStartAt), duration: Math.max(0, setup.lunchTime), done: setup.lunchTime <= 0 },
          { label: 'Meeting Time', startAt: Math.max(0, setup.meetingStartAt), duration: Math.max(0, setup.meetingTime), done: setup.meetingTime <= 0 },
        ].sort((a, b) => a.startAt - b.startAt),
      );
    });

    const assignedCount = this.machines.filter((m) => m.status !== 'unassigned').length;
    // Pre-seed every activity key actually in play (across every Construction used) at 0 — same
    // as the single-operator Simulator's emptyCounts(config.activities) — so e.g. Fracture
    // Repairing still shows up as "0" in the dashboard before its first occurrence, instead of
    // being entirely absent from the object (and so invisible in the UI) until then.
    const allActivityKeys = new Set<ActivityKey>();
    this.machines.forEach((m) => m.activities.forEach((a) => allActivityKeys.add(a.key)));
    this.metrics = {
      clockMin: 0,
      shiftTimeMin: setup.shiftTime,
      assignedMachineCount: assignedCount,
      completedByActivity: Object.fromEntries([...allActivityKeys].map((k) => [k, 0])),
      diesChanged: 0,
      plannedDies: [...this.fractureByConstruction.values()].reduce((sum, state) => sum + state.plannedDies, 0),
      downtimeByReason: { waiting: 0, ...Object.fromEntries([...allActivityKeys].map((k) => [k, 0])) },
      tonageKg: 0,
      producedMachineMin: 0,
      perOperator: this.operators.map((op) => ({ id: op.id, label: op.label, walkingMin: 0, servicingMin: 0, idleMin: 0 })),
    };

    if (setup.operators.length === 0) {
      this.warnings.push('No operators defined for this Production Setup — nothing will be serviced.');
    }
  }

  private addLog(atMin: number, message: string) {
    this.logIdCounter += 1;
    this.log.push({ id: `plog-${this.logIdCounter}`, timeMin: atMin, message });
    if (this.log.length > 300) this.log.shift();
  }

  private operatorIdForTask(machineAssignment: ProdMachine, activity: ActivityKey): string | undefined {
    const assignment = this.setup.assignments.find((a) => a.machineId === machineAssignment.id);
    return assignedOperatorIdForActivity(assignment, activity);
  }

  /** If both Loading Partial1 and Partial2 just came due together on the same machine, the
   * regulation is a single combined "Loading Partial3" task instead of doing both back to back —
   * mirrors combineLoadingPartials in simulationEngine.ts, adapted to this machine's own
   * activities list (each machine can run a different Construction). */
  private combineLoadingPartials(machine: ProdMachine, newTasks: PendingTask[]) {
    const partial1 = machine.activities.find((a) => a.loadingPartialSlot === 1);
    const partial2 = machine.activities.find((a) => a.loadingPartialSlot === 2);
    const partial3 = machine.activities.find((a) => a.loadingPartialSlot === 3);
    if (!partial1 || !partial2 || !partial3) return;
    const index1 = newTasks.findIndex((t) => t.activity === partial1.key);
    const index2 = newTasks.findIndex((t) => t.activity === partial2.key);
    if (index1 === -1 || index2 === -1) return;
    const insertAt = Math.min(index1, index2);
    const combined: PendingTask = {
      activity: partial3.key,
      label: partial3.label,
      timeMinutes: partial3.timeMinutes,
      assignedOperatorId: this.operatorIdForTask(machine, partial3.key),
    };
    const remaining = newTasks.filter((t) => t.activity !== partial1.key && t.activity !== partial2.key);
    remaining.splice(insertAt, 0, combined);
    newTasks.length = 0;
    newTasks.push(...remaining);
  }

  private queueTasksForMachine(machine: ProdMachine, atMin: number) {
    if (machine.status === 'unassigned') return;
    const newTasks: PendingTask[] = [];
    const dueCounts = new Map<ActivityKey, number>();
    const handledCounts = new Map<ActivityKey, number>();
    machine.activities.forEach(({ key }) => {
      const cycle = machine.cycleLengths[key];
      dueCounts.set(key, Number.isFinite(cycle) && cycle > 0 ? Math.floor(machine.spoolsCompleted / cycle) : 0);
      handledCounts.set(key, machine.completedByActivity[key] ?? 0);
    });
    machine.activities.filter((a) => !GLOBAL_EVENT_ACTIVITIES.has(a.key)).forEach((activity) => {
      const { key } = activity;
      if (activity.loadingInterrupt) return;
      const cycle = machine.cycleLengths[key];
      if (!Number.isFinite(cycle) || cycle <= 0) return;
      const dueCount = dueCounts.get(key) ?? 0;
      const alreadyHandled = handledCounts.get(key) ?? 0;
      if (dueCount > alreadyHandled) {
        const parent = activity.parentKey ? machine.activities.find((item) => item.key === activity.parentKey) : null;
        const parentDue = parent ? (dueCounts.get(parent.key) ?? 0) > (handledCounts.get(parent.key) ?? 0) : false;
        const altersWithParent = parent?.key === 'loading';
        if (!altersWithParent || !parentDue) {
          const assignedOperatorId = this.operatorIdForTask(machine, key);
          if (!assignedOperatorId) {
            const warnKey = `${machine.id}:${key}`;
            if (!this.warnedNoOperator.has(warnKey)) {
              this.warnedNoOperator.add(warnKey);
              this.warnings.push(`Machine ${machine.label}: "${activity.label}" is due but has no operator assigned.`);
            }
          }
          newTasks.push({
            activity: key,
            label: activity.label,
            timeMinutes: activity.timeMinutes,
            assignedOperatorId,
            loadingPayoffOnly: activity.loadingInterrupt,
            defectTakeupOnly: activity.defectTakeupOnly,
          });
        }
        machine.completedByActivity[key] = dueCount;
      }
    });

    this.combineLoadingPartials(machine, newTasks);
    // Fracture Repairing is NOT queued here — it's injected directly by
    // triggerMidRuntimeFractureForConstruction, scoped per Construction group (see
    // ConstructionFractureState), mirroring the single-operator Simulator's global-pool
    // regulation rather than a per-machine due/cycle comparison.

    if (newTasks.length > 0) {
      const existingKeys = new Set(machine.pendingTasks.map((t) => t.activity));
      newTasks.forEach((t) => {
        if (!existingKeys.has(t.activity)) machine.pendingTasks.push(t);
      });
      this.addLog(atMin, `${machine.label} needs ${newTasks.map((t) => t.label).join(', ')}`);
    }

    if (machine.status === 'running' && machine.pendingTasks.some((t) => isStopActivity(machine.activities, t.activity))) {
      machine.status = 'needs-service';
      machine.queuedSince = atMin;
    }
  }

  private advanceMachines(fromMin: number, toMin: number) {
    for (const machine of this.machines) {
      if (machine.status !== 'running') continue;
      let guard = 0;
      while (machine.nextCompletionAt <= toMin && guard < 200) {
        guard += 1;
        machine.spoolsCompleted += 1;
        machine.shiftSpoolsCompleted += 1;
        machine.spoolsSinceLoading += 1;
        const completedAt = Math.max(fromMin, machine.nextCompletionAt);
        machine.nextCompletionAt += machine.runtimePerSpool;
        this.queueTasksForMachine(machine, completedAt);
        if (machine.constructionId) {
          const state = this.fractureByConstruction.get(machine.constructionId);
          if (state) state.globalSpoolsCompleted += 1;
        }

      }
    }
  }

  private triggerMidRuntimeLoading(machine: ProdMachine, atMin: number) {
    const activity = machine.activities.find((item) => item.key === 'loading');
    if (!activity?.loadingInterrupt || machine.status !== 'running') return;
    const cycle = machine.cycleLengths.loading;
    if (!Number.isFinite(cycle) || cycle <= 0) return;
    const fractionalProgress = Math.max(
      0,
      Math.min(1, (machine.runtimePerSpool - (machine.nextCompletionAt - atMin)) / machine.runtimePerSpool),
    );
    if (machine.spoolsSinceLoading + fractionalProgress < cycle ||
      machine.pendingTasks.some((task) => task.activity === 'loading')) return;
    const assignedOperatorId = this.operatorIdForTask(machine, 'loading');
    machine.pendingTasks.push({
      activity: 'loading',
      label: activity.label,
      timeMinutes: activity.timeMinutes,
      assignedOperatorId,
      loadingPayoffOnly: true,
    });
    machine.runtimeRemainingMin = Math.max(0, machine.nextCompletionAt - atMin);
    machine.runtimePaused = true;
    machine.status = 'needs-service';
    machine.queuedSince = atMin;
    machine.nextCompletionAt = Number.POSITIVE_INFINITY;
    const constructionLabel = machine.constructionId ? this.constructionLabelById.get(machine.constructionId) ?? machine.constructionId : machine.label;
    this.addLog(atMin, `${machine.label} needs Loading (${constructionLabel}, weight threshold reached)`);
  }

  /** Once a Construction group's cumulative (fractional, to stay smooth between whole-spool
   * completions) spool progress crosses its next Fracture/Ton threshold, the event lands on a
   * random currently-running machine within THAT SAME Construction group — mirrors
   * simulationEngine.ts's triggerMidRuntimeFracture/injectFractureTask, just partitioned per
   * Construction instead of one pool for the whole layout. */
  private triggerMidRuntimeFractureForConstruction(constructionId: string, atMin: number) {
    const state = this.fractureByConstruction.get(constructionId);
    if (!state || !Number.isFinite(state.cycle) || state.cycle <= 0) return;
    const groupMachines = this.machinesByConstruction.get(constructionId) ?? [];
    const fractionalSpools = groupMachines.reduce((total, machine) => {
      if (machine.status !== 'running' || machine.runtimePerSpool <= 0) return total;
      const elapsed = machine.runtimePerSpool - (machine.nextCompletionAt - atMin);
      return total + Math.max(0, Math.min(1, elapsed / machine.runtimePerSpool));
    }, state.globalSpoolsCompleted);
    while (fractionalSpools >= (state.fractureEventsTriggered + 1) * state.cycle) {
      if (!this.injectFractureTaskForConstruction(constructionId, atMin)) break;
      state.fractureEventsTriggered += 1;
    }
  }

  private injectFractureTaskForConstruction(constructionId: string, atMin: number): boolean {
    const candidates = (this.machinesByConstruction.get(constructionId) ?? []).filter((m) => m.status === 'running');
    if (candidates.length === 0) return false;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (target.pendingTasks.some((t) => t.activity === 'fractureRepairing')) return false;
    const activity = findActivity(target.activities, 'fractureRepairing');
    const assignedOperatorId = this.operatorIdForTask(target, 'fractureRepairing');
    if (!assignedOperatorId) {
      const warnKey = `${target.id}:fractureRepairing`;
      if (!this.warnedNoOperator.has(warnKey)) {
        this.warnedNoOperator.add(warnKey);
        this.warnings.push(`Machine ${target.label}: "${activity.label}" is due but has no operator assigned.`);
      }
    }
    target.pendingTasks.push({ activity: 'fractureRepairing', label: activity.label, timeMinutes: activity.timeMinutes, assignedOperatorId });
    const constructionLabel = this.constructionLabelById.get(constructionId) ?? constructionId;
    if (isStopActivity(target.activities, 'fractureRepairing')) {
      target.runtimeRemainingMin = Math.max(0, target.nextCompletionAt - atMin);
      target.runtimePaused = true;
      target.status = 'needs-service';
      target.queuedSince = atMin;
      target.nextCompletionAt = Number.POSITIVE_INFINITY;
      this.addLog(atMin, `Fracture occurred (${constructionLabel}) — scheduled on Machine ${target.label} after the current runtime`);
    } else {
      this.addLog(atMin, `Fracture occurred (${constructionLabel}) — Machine ${target.label} will be serviced while running`);
    }
    return true;
  }

  private injectGlobalActivityForConstruction(
    constructionId: string,
    activityKey: 'diesChange' | 'defectRepairing',
    atMin: number,
  ): boolean {
    const candidates = (this.machinesByConstruction.get(constructionId) ?? []).filter((m) => m.status === 'running');
    if (candidates.length === 0) return false;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (target.pendingTasks.some((t) => t.activity === activityKey)) return false;
    const activity = findActivity(target.activities, activityKey);
    const state = this.fractureByConstruction.get(constructionId);
    const remainingDies = state ? Math.max(0, Math.ceil(state.plannedDies - state.scheduledDies)) : 0;
    const requestedQuantity = Math.random() < 0.5 ? 7 : 26;
    const quantity =
      activityKey === 'diesChange' && state
        ? requestedQuantity <= remainingDies
          ? requestedQuantity
          : remainingDies >= 7
            ? 7
            : 0
        : undefined;
    if (activityKey === 'diesChange' && (!quantity || quantity <= 0)) return false;
    const assignedOperatorId = this.operatorIdForTask(target, activityKey);
    if (!assignedOperatorId) {
      const warnKey = `${target.id}:${activityKey}`;
      if (!this.warnedNoOperator.has(warnKey)) {
        this.warnedNoOperator.add(warnKey);
        this.warnings.push(`Machine ${target.label}: "${activity.label}" is due but has no operator assigned.`);
      }
    }
    const label = quantity ? `${activity.label} (${quantity} dies)` : activity.label;
    target.pendingTasks.push({
      activity: activityKey,
      label,
      timeMinutes: activity.timeMinutes * (quantity ?? 1),
      quantity,
      defectTakeupOnly: activity.defectTakeupOnly,
      assignedOperatorId,
    });
    if (activityKey === 'diesChange' && state) state.scheduledDies += quantity ?? 0;
    const constructionLabel = this.constructionLabelById.get(constructionId) ?? constructionId;
    if (isStopActivity(target.activities, activityKey)) {
      target.runtimeRemainingMin = Math.max(0, target.nextCompletionAt - atMin);
      target.runtimePaused = true;
      target.status = 'needs-service';
      target.queuedSince = atMin;
      target.nextCompletionAt = Number.POSITIVE_INFINITY;
      this.addLog(atMin, `${label} (${constructionLabel}) — scheduled on Machine ${target.label} after the current runtime`);
    } else {
      this.addLog(atMin, `${label} (${constructionLabel}) — Machine ${target.label} will be serviced while running`);
    }
    return true;
  }

  private triggerMidRuntimeGlobalActivityForConstruction(
    constructionId: string,
    activityKey: 'diesChange' | 'defectRepairing',
    atMin: number,
  ) {
    const state = this.fractureByConstruction.get(constructionId);
    if (!state) return;
    const groupMachines = this.machinesByConstruction.get(constructionId) ?? [];
    const cycle = activityKey === 'diesChange' ? state.diesChangeCycle : state.defectRepairingCycle;
    if (!Number.isFinite(cycle) || cycle <= 0) return;
    const expectedDiesEvents =
      activityKey === 'diesChange' && state.plannedDies > 0
        ? Math.ceil(state.plannedDies / AVERAGE_DIES_PER_CHANGE_EVENT)
        : 0;
    const totalTheoreticalSpools = Math.max(
      1,
      (this.setup.shiftTime / Math.max(1, groupMachines[0]?.runtimePerSpool ?? 1)) * groupMachines.length,
    );
    const eventCycle =
      activityKey === 'diesChange' && expectedDiesEvents > 0
        ? totalTheoreticalSpools / expectedDiesEvents
        : cycle;
    const fractionalSpools = groupMachines.reduce((total, machine) => {
      if (machine.status !== 'running' || machine.runtimePerSpool <= 0) return total;
      const elapsed = machine.runtimePerSpool - (machine.nextCompletionAt - atMin);
      return total + Math.max(0, Math.min(1, elapsed / machine.runtimePerSpool));
    }, state.globalSpoolsCompleted);
    let eventsTriggered =
      activityKey === 'diesChange' ? state.diesChangeEventsTriggered : state.defectRepairingEventsTriggered;
    while (fractionalSpools >= (eventsTriggered + 1) * eventCycle) {
      if (!this.injectGlobalActivityForConstruction(constructionId, activityKey, atMin)) break;
      eventsTriggered += 1;
    }
    if (activityKey === 'diesChange') state.diesChangeEventsTriggered = eventsTriggered;
    else state.defectRepairingEventsTriggered = eventsTriggered;
  }

  private accumulateDowntime(deltaMin: number) {
    for (const machine of this.machines) {
      if (machine.status === 'unassigned' || machine.status === 'running') continue;
      if (this.servicingOperatorByMachineId.has(machine.id)) continue;
      machine.downtimeMin += deltaMin;
      machine.downtimeByReason.waiting += deltaMin;
      this.metrics.downtimeByReason.waiting = (this.metrics.downtimeByReason.waiting ?? 0) + deltaMin;
    }
  }

  private walkingDistanceMeters(fromX: number, fromY: number, toX: number, toY: number): number {
    const route = computeWalkingWaypoints({ x: fromX, y: fromY }, { x: toX, y: toY }, this.machines, this.setup.movement.pixelsPerMeter, this.routeCache);
    let total = 0;
    for (let i = 1; i < route.length; i += 1) {
      total += distanceMeters(route[i - 1].x, route[i - 1].y, route[i].x, route[i].y, this.setup.movement.pixelsPerMeter);
    }
    return total;
  }

  private estimateServiceEtaMin(operator: ProductionOperatorRuntimeState, machine: ProdMachine, myTasks: PendingTask[]): number {
    const speed = this.setup.movement.walkingSpeed > 0 ? this.setup.movement.walkingSpeed : 1;
    const pxPerM = this.setup.movement.pixelsPerMeter;
    const segments = buildServiceSegments(myTasks, machine.x, machine.y, machine.orientation, machine.pairSide, this.setup.movement.walkingSpeed, pxPerM, machine.widthPx, machine.heightPx);
    if (segments.length === 0) return this.walkingDistanceMeters(operator.x, operator.y, machine.x, machine.y) / speed;
    let total = this.walkingDistanceMeters(operator.x, operator.y, segments[0].x, segments[0].y) / speed;
    total += segments[0].dwellMin;
    for (let i = 1; i < segments.length; i += 1) {
      total += distanceMeters(segments[i - 1].x, segments[i - 1].y, segments[i].x, segments[i].y, pxPerM) / speed;
      total += segments[i].dwellMin;
    }
    return total;
  }

  /** A Loading-family task can't start until the machine has actually been Doffed — physically
   * you can't load a machine that still has its finished spool on it. When Doffing and Loading are
   * split across two different operators, that dependency isn't automatic anymore (a single
   * operator naturally does them in order during one visit, but two operators act independently),
   * so block the Loading task from being offered until any pending Doffing task assigned to a
   * DIFFERENT operator is gone. Same-operator or unassigned-doffing cases are left alone — either
   * order is already correct (one visit) or there's nothing to wait for. */
  private isTaskReady(machine: ProdMachine, task: PendingTask): boolean {
    if (activityFamily(task.activity) !== 'loading') return true;
    return !machine.pendingTasks.some(
      (t) => activityFamily(t.activity) === 'doffing' && t.assignedOperatorId && t.assignedOperatorId !== task.assignedOperatorId,
    );
  }

  private tasksFor(operatorId: string, machine: ProdMachine): PendingTask[] {
    return machine.pendingTasks.filter((t) => t.assignedOperatorId === operatorId && this.isTaskReady(machine, t));
  }

  private pickNextTarget(operator: ProductionOperatorRuntimeState): ProdMachine | null {
    const candidates = this.machines.filter((m) => {
      if (m.status !== 'needs-service' && m.status !== 'running') return false;
      if (m.lockedByOperatorId && m.lockedByOperatorId !== operator.id) return false;
      return this.tasksFor(operator.id, m).length > 0;
    });
    if (candidates.length === 0) return null;
    const score = (m: ProdMachine) =>
      this.setup.taskPriority === 'quickest'
        ? this.estimateServiceEtaMin(operator, m, this.tasksFor(operator.id, m))
        : this.walkingDistanceMeters(operator.x, operator.y, m.x, m.y);
    let best = candidates[0];
    let bestScore = score(best);
    for (const c of candidates.slice(1)) {
      const s = score(c);
      if (s < bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return best;
  }

  private startWalkingTo(operator: ProductionOperatorRuntimeState, machine: ProdMachine) {
    machine.lockedByOperatorId = operator.id;
    const myTasks = this.tasksFor(operator.id, machine);
    const segments = buildServiceSegments(myTasks, machine.x, machine.y, machine.orientation, machine.pairSide, this.setup.movement.walkingSpeed, this.setup.movement.pixelsPerMeter, machine.widthPx, machine.heightPx);
    const firstStop = segments[0] ?? { x: machine.x, y: machine.y };
    const route = computeWalkingWaypoints({ x: operator.x, y: operator.y }, { x: firstStop.x, y: firstStop.y }, this.machines, this.setup.movement.pixelsPerMeter, this.routeCache);
    const [firstHop, ...remainingHops] = route.slice(1);
    const speed = this.setup.movement.walkingSpeed > 0 ? this.setup.movement.walkingSpeed : 1;
    operator.phase = 'walking';
    operator.targetMachineId = machine.id;
    operator.targetMachineLabel = machine.label;
    operator.fromX = operator.x;
    operator.fromY = operator.y;
    operator.toX = firstHop.x;
    operator.toY = firstHop.y;
    operator.walkProgress = 0;
    operator.walkDurationMin = distanceMeters(operator.fromX, operator.fromY, firstHop.x, firstHop.y, this.setup.movement.pixelsPerMeter) / speed;
    operator.pendingWaypoints = remainingHops;
    operator.plannedRoute = route;
  }

  private advanceWalkOrFinish(operator: ProductionOperatorRuntimeState) {
    const next = operator.pendingWaypoints.shift();
    if (!next) {
      this.finishWalk(operator);
      return;
    }
    const speed = this.setup.movement.walkingSpeed > 0 ? this.setup.movement.walkingSpeed : 1;
    operator.fromX = operator.toX;
    operator.fromY = operator.toY;
    operator.toX = next.x;
    operator.toY = next.y;
    operator.walkProgress = 0;
    operator.walkDurationMin = distanceMeters(operator.fromX, operator.fromY, next.x, next.y, this.setup.movement.pixelsPerMeter) / speed;
  }

  private nextPendingBreak(operatorId: string, clockCursor: number): BreakDef | null {
    const breaks = this.breaksByOperator.get(operatorId) ?? [];
    return breaks.find((b) => !b.done && clockCursor >= b.startAt) ?? null;
  }

  private serviceTaskForCurrentZone(operator: ProductionOperatorRuntimeState): PendingTask | undefined {
    const activityLabel = operator.currentZoneLabel?.split(' — ')[0];
    return activityLabel ? operator.serviceTasks.find((t) => t.label === activityLabel) : undefined;
  }

  private setMachineRunState(machine: ProdMachine, running: boolean, atMin: number) {
    if (running) {
      if (machine.status !== 'running') {
        machine.nextCompletionAt = atMin + (machine.runtimeRemainingMin ?? machine.runtimePerSpool);
        machine.runtimeRemainingMin = null;
        machine.runtimePaused = false;
        machine.status = 'running';
      }
    } else {
      if (machine.status === 'running') {
        machine.runtimeRemainingMin = Math.max(0, machine.nextCompletionAt - atMin);
        machine.runtimePaused = true;
        machine.nextCompletionAt = Number.POSITIVE_INFINITY;
      }
      machine.status = 'being-serviced';
    }
  }

  private isEffectiveStopTask(machine: ProdMachine, index: number, tasks: PendingTask[]): boolean {
    const task = tasks[index];
    if (isStopActivity(machine.activities, task.activity)) return true;
    const next = tasks[index + 1];
    return next ? isStopActivity(machine.activities, next.activity) : false;
  }

  private syncMachineRunStateForCurrentTask(operator: ProductionOperatorRuntimeState, atMin: number) {
    const machine = this.machines.find((m) => m.id === operator.targetMachineId);
    if (!machine) return;
    const task = this.serviceTaskForCurrentZone(operator);
    if (!task) return;
    const index = operator.serviceTasks.indexOf(task);
    const shouldStop = index >= 0 ? this.isEffectiveStopTask(machine, index, operator.serviceTasks) : isStopActivity(machine.activities, task.activity);
    this.setMachineRunState(machine, !shouldStop, atMin);
  }

  private advanceToNextZone(operator: ProductionOperatorRuntimeState, atMin: number) {
    const next = operator.serviceSegments.shift();
    if (!next) {
      this.finishService(operator, atMin);
      return;
    }
    const dist = distanceMeters(operator.x, operator.y, next.x, next.y, this.setup.movement.pixelsPerMeter);
    const speed = this.setup.movement.walkingSpeed > 0 ? this.setup.movement.walkingSpeed : 1;
    operator.zoneMoveFromX = operator.x;
    operator.zoneMoveFromY = operator.y;
    operator.zoneMoveToX = next.x;
    operator.zoneMoveToY = next.y;
    operator.zoneMoveProgress = 0;
    operator.zoneMoveDurationMin = dist / speed;
    operator.zoneDwellRemainingMin = next.dwellMin;
    operator.currentZoneLabel = next.label;
    operator.serviceSubPhase = dist > 0 ? 'moving' : 'dwelling';
    this.syncMachineRunStateForCurrentTask(operator, atMin);
  }

  private finishWalk(operator: ProductionOperatorRuntimeState) {
    operator.phase = 'servicing';
    operator.x = operator.toX;
    operator.y = operator.toY;
    const machine = this.machines.find((m) => m.id === operator.targetMachineId) as ProdMachine | undefined;
    let tasks: PendingTask[] = [];
    if (machine) {
      tasks = this.tasksFor(operator.id, machine);
      machine.pendingTasks = machine.pendingTasks.filter((t) => t.assignedOperatorId !== operator.id);
    }
    operator.serviceTasks = tasks;
    const segments = machine
      ? buildServiceSegments(tasks, machine.x, machine.y, machine.orientation, machine.pairSide, this.setup.movement.walkingSpeed, this.setup.movement.pixelsPerMeter, machine.widthPx, machine.heightPx)
      : [];
    if (segments.length === 0) {
      this.finishService(operator, this.metrics.clockMin);
      return;
    }
    const first = segments.shift()!;
    operator.serviceSegments = segments;
    operator.currentZoneLabel = first.label;
    operator.zoneDwellRemainingMin = first.dwellMin;
    operator.serviceSubPhase = 'dwelling';
    this.syncMachineRunStateForCurrentTask(operator, this.metrics.clockMin);
  }

  private finishService(operator: ProductionOperatorRuntimeState, atMin: number) {
    const machine = this.machines.find((m) => m.id === operator.targetMachineId) as ProdMachine | undefined;
    if (machine) {
      // finishWalk only ever splices THIS operator's own tasks off pendingTasks (see
      // tasksFor/finishWalk) — a different activity due on the same machine, assigned to a
      // DIFFERENT operator (e.g. Loading still pending here while this operator just finished
      // Doffing), is deliberately left behind for that other operator to pick up later. If that
      // leftover task still requires the machine to be stopped, resuming production here would be
      // wrong — the machine has to stay down until whoever owns that task actually shows up.
      // setMachineRunState still does the correct pause/resume bookkeeping either way (capturing
      // or restoring runtimeRemainingMin); only the final status differs from its own default of
      // 'being-serviced', since 'needs-service' is what pickNextTarget looks for so the other
      // operator can actually still find and claim this machine.
      const stillNeedsStop = machine.pendingTasks.some((t) => isStopActivity(machine.activities, t.activity));
      this.setMachineRunState(machine, !stillNeedsStop, atMin);
      if (stillNeedsStop) {
        machine.status = 'needs-service';
        machine.queuedSince = atMin;
      } else {
        machine.queuedSince = null;
      }
      machine.totalServiced += 1;
      operator.serviceTasks.forEach((t, index, tasks) => {
        this.metrics.completedByActivity[t.activity] = (this.metrics.completedByActivity[t.activity] ?? 0) + 1;
        if (t.activity === 'diesChange') this.metrics.diesChanged += t.quantity ?? 0;
        if (t.activity === 'doffing') {
          this.metrics.tonageKg += machine.spoolWeight;
          this.metrics.producedMachineMin += machine.runtimePerSpool;
        }
        if (this.isEffectiveStopTask(machine, index, tasks)) {
          this.metrics.downtimeByReason[t.activity] = (this.metrics.downtimeByReason[t.activity] ?? 0) + t.timeMinutes;
          machine.downtimeByReason[t.activity] = (machine.downtimeByReason[t.activity] ?? 0) + t.timeMinutes;
          machine.downtimeMin += t.timeMinutes;
        }
        if (t.activity === 'loading' || t.activity.startsWith('loading-')) machine.spoolsSinceLoading = 0;
      });
      if (machine.lockedByOperatorId === operator.id) machine.lockedByOperatorId = null;
      this.addLog(atMin, `${operator.label} finished servicing Machine ${machine.label}`);
    }
    operator.phase = 'idle';
    operator.targetMachineId = null;
    operator.targetMachineLabel = null;
    operator.serviceTasks = [];
    operator.serviceSegments = [];
    operator.serviceSubPhase = null;
    operator.currentZoneLabel = null;
  }

  private recordOperatorTime(operator: ProductionOperatorRuntimeState, startMin: number, duration: number, kind: OperatorTimelineKind, label: string) {
    if (duration <= 1e-9) return;
    const timeline = operator.timeline;
    const previous = timeline[timeline.length - 1];
    if (previous && previous.endMin >= startMin - 1e-9 && previous.kind === kind && previous.label === label) {
      previous.endMin = Math.max(previous.endMin, startMin + duration);
      return;
    }
    timeline.push({ startMin, endMin: startMin + duration, kind, label });
  }

  private recordMachineTime(machine: ProdMachine, startMin: number, duration: number) {
    if (duration <= 1e-9 || machine.status === 'unassigned') return;
    const servicingOperator = this.servicingOperatorByMachineId.get(machine.id);
    const currentServiceLabel = servicingOperator?.currentZoneLabel?.split(' — ')[0];
    const currentServiceTask = servicingOperator && currentServiceLabel
      ? servicingOperator.serviceTasks.find((t) => t.label === currentServiceLabel)
      : undefined;
    const includesMovement = currentServiceTask?.activity === 'loading' || currentServiceTask?.activity.startsWith('loading-') ||
      currentServiceTask?.activity === 'fractureRepairing' || currentServiceTask?.activity.startsWith('fractureRepairing-') ||
      currentServiceTask?.activity === 'diesChange' || currentServiceTask?.activity.startsWith('diesChange-') ||
      currentServiceTask?.activity === 'defectRepairing' || currentServiceTask?.activity.startsWith('defectRepairing-');
    const isWorking = !!servicingOperator && (servicingOperator.serviceSubPhase === 'dwelling' || (servicingOperator.serviceSubPhase === 'moving' && includesMovement));
    const activeTask = isWorking ? currentServiceTask ?? servicingOperator!.serviceTasks[0] : undefined;
    const waitingActivity = machine.pendingTasks[0]?.activity;
    const kind: MachineTimelineKind = machine.status === 'running'
      ? (activeTask ? `running:${activeTask.activity}` : 'running')
      : activeTask?.activity ?? (waitingActivity ? `waiting:${waitingActivity}` : 'waiting');
    const label = kind === 'running'
      ? 'Running'
      : activeTask && kind === `running:${activeTask.activity}`
        ? `Running + ${activeTask.label}`
        : activeTask?.label ?? (waitingActivity ? `Waiting ${machine.pendingTasks[0]?.label}` : 'Waiting');
    const timeline = machine.timeline;
    const previous = timeline[timeline.length - 1];
    if (previous && previous.endMin >= startMin - 1e-9 && previous.kind === kind) {
      previous.endMin = Math.max(previous.endMin, startMin + duration);
      return;
    }
    const segment: MachineTimelineSegment = { startMin, endMin: startMin + duration, kind, label };
    timeline.push(segment);
  }

  private advanceOperator(operator: ProductionOperatorRuntimeState, perOpMetrics: ProductionSimMetrics['perOperator'][number], startMin: number, deltaMin: number) {
    let remaining = deltaMin;
    let clockCursor = startMin;
    let guard = 0;
    while (remaining > 1e-9 && guard < 500) {
      guard += 1;

      if (operator.phase === 'idle') {
        const dueBreak = this.nextPendingBreak(operator.id, clockCursor);
        if (dueBreak) {
          dueBreak.done = true;
          operator.phase = 'break';
          operator.breakLabel = dueBreak.label;
          operator.breakRemainingMin = dueBreak.duration;
          continue;
        }
        const target = this.pickNextTarget(operator);
        if (!target) {
          this.recordOperatorTime(operator, clockCursor, remaining, 'idle', 'Idle');
          perOpMetrics.idleMin += remaining;
          remaining = 0;
          break;
        }
        this.startWalkingTo(operator, target);
        continue;
      }

      if (operator.phase === 'break') {
        const step = Math.min(remaining, operator.breakRemainingMin);
        operator.breakRemainingMin -= step;
        this.recordOperatorTime(operator, clockCursor, step, dueBreakKind(operator.breakLabel), operator.breakLabel ?? 'Break');
        remaining -= step;
        clockCursor += step;
        if (operator.breakRemainingMin <= 1e-9) {
          operator.phase = 'idle';
          operator.breakLabel = null;
        }
        continue;
      }

      if (operator.phase === 'walking') {
        const duration = operator.walkDurationMin;
        if (duration <= 1e-9) {
          operator.walkProgress = 1;
          this.advanceWalkOrFinish(operator);
          continue;
        }
        const remainingWalk = (1 - operator.walkProgress) * duration;
        const step = Math.min(remaining, remainingWalk);
        operator.walkProgress += step / duration;
        operator.x = operator.fromX + (operator.toX - operator.fromX) * operator.walkProgress;
        operator.y = operator.fromY + (operator.toY - operator.fromY) * operator.walkProgress;
        perOpMetrics.walkingMin += step;
        this.recordOperatorTime(operator, clockCursor, step, 'walking', `Moving to Machine ${operator.targetMachineLabel ?? ''}`.trim());
        remaining -= step;
        clockCursor += step;
        if (operator.walkProgress >= 1 - 1e-9) this.advanceWalkOrFinish(operator);
        continue;
      }

      if (operator.phase === 'servicing' && operator.serviceSubPhase === 'moving') {
        const duration = operator.zoneMoveDurationMin;
        if (duration <= 1e-9) {
          operator.x = operator.zoneMoveToX;
          operator.y = operator.zoneMoveToY;
          operator.serviceSubPhase = 'dwelling';
          continue;
        }
        const remainingMove = (1 - operator.zoneMoveProgress) * duration;
        const step = Math.min(remaining, remainingMove);
        operator.zoneMoveProgress += step / duration;
        operator.x = operator.zoneMoveFromX + (operator.zoneMoveToX - operator.zoneMoveFromX) * operator.zoneMoveProgress;
        operator.y = operator.zoneMoveFromY + (operator.zoneMoveToY - operator.zoneMoveFromY) * operator.zoneMoveProgress;
        const movingTask = this.serviceTaskForCurrentZone(operator);
        const includesMovement = movingTask?.activity === 'loading' || movingTask?.activity.startsWith('loading-') ||
          movingTask?.activity === 'fractureRepairing' || movingTask?.activity.startsWith('fractureRepairing-') ||
          movingTask?.activity === 'diesChange' || movingTask?.activity.startsWith('diesChange-') ||
          movingTask?.activity === 'defectRepairing' || movingTask?.activity.startsWith('defectRepairing-');
        if (includesMovement && movingTask) {
          perOpMetrics.servicingMin += step;
          this.recordOperatorTime(operator, clockCursor, step, movingTask.activity, movingTask.label);
        } else {
          perOpMetrics.walkingMin += step;
          this.recordOperatorTime(operator, clockCursor, step, 'walking', 'Moving between machine zones');
        }
        remaining -= step;
        clockCursor += step;
        if (operator.zoneMoveProgress >= 1 - 1e-9) {
          operator.x = operator.zoneMoveToX;
          operator.y = operator.zoneMoveToY;
          operator.serviceSubPhase = 'dwelling';
        }
        continue;
      }

      if (operator.phase === 'servicing' && operator.serviceSubPhase === 'dwelling') {
        const step = Math.min(remaining, operator.zoneDwellRemainingMin);
        operator.zoneDwellRemainingMin -= step;
        perOpMetrics.servicingMin += step;
        const task = this.serviceTaskForCurrentZone(operator);
        const activityKey = task?.activity ?? 'service';
        this.recordOperatorTime(operator, clockCursor, step, activityKey, operator.currentZoneLabel ?? 'Handle');
        remaining -= step;
        clockCursor += step;
        if (operator.zoneDwellRemainingMin <= 1e-9) this.advanceToNextZone(operator, clockCursor);
        continue;
      }
    }
  }

  tick(deltaMin: number) {
    if (deltaMin <= 0) return;
    if (this.metrics.clockMin >= this.metrics.shiftTimeMin) {
      this.metrics.clockMin = this.metrics.shiftTimeMin;
      return;
    }
    const capped = Math.min(deltaMin, this.metrics.shiftTimeMin - this.metrics.clockMin);
    let remaining = capped;
    while (remaining > 1e-9) {
      const step = Math.min(remaining, 0.02);
      const startMin = this.metrics.clockMin;
      this.advanceMachines(startMin, startMin + step);
      this.machines.forEach((machine) => this.triggerMidRuntimeLoading(machine, startMin + step));
      this.fractureByConstruction.forEach((_, constructionId) => {
        this.triggerMidRuntimeFractureForConstruction(constructionId, startMin + step);
        this.triggerMidRuntimeGlobalActivityForConstruction(constructionId, 'diesChange', startMin + step);
        this.triggerMidRuntimeGlobalActivityForConstruction(constructionId, 'defectRepairing', startMin + step);
      });
      this.operators.forEach((operator, i) => this.advanceOperator(operator, this.metrics.perOperator[i], startMin, step));
      this.servicingOperatorByMachineId.clear();
      this.operators.forEach((op) => {
        if (op.phase === 'servicing' && op.targetMachineId) this.servicingOperatorByMachineId.set(op.targetMachineId, op);
      });
      this.accumulateDowntime(step);
      this.metrics.clockMin += step;
      this.machines.forEach((machine) => this.recordMachineTime(machine, startMin, step));
      remaining -= step;
    }
  }

  getState(): ProductionSimulationState {
    return {
      machines: this.machines.map((m) => ({
        ...m,
        completedByActivity: { ...m.completedByActivity },
        downtimeByReason: { ...m.downtimeByReason },
        timeline: m.timeline.map((s) => ({ ...s })),
      })),
      operators: this.operators.map((op) => ({ ...op, timeline: op.timeline.map((s) => ({ ...s })) })),
      metrics: {
        ...this.metrics,
        completedByActivity: { ...this.metrics.completedByActivity },
        downtimeByReason: { ...this.metrics.downtimeByReason },
        perOperator: this.metrics.perOperator.map((p) => ({ ...p })),
      },
      log: [...this.log],
      finished: this.metrics.clockMin >= this.metrics.shiftTimeMin,
      warnings: [...this.warnings],
    };
  }
}

export function availableProductionTimeMinutes(setup: ProductionSetup): number {
  return availableTimeMinutes(setup.shiftTime, setup.lunchTime, setup.meetingTime);
}
