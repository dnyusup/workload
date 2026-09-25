import type {
  ActivityConfig,
  ActivityKey,
  AppConfig,
  DowntimeReason,
  EventLogEntry,
  MachineRuntimeState,
  MachineStartCondition,
  MachineTimelineKind,
  MachineTimelineSegment,
  OperatorRuntimeState,
  PendingTask,
  OperatorTimelineKind,
  OperatorTimelineSegment,
  SimMetrics,
  SimulationState,
} from '../types';
import { activityCycleLength, availableTimeMinutes, deriveMachineSpec, distanceMeters, extraBreakMinutes } from './calculations';
import { machineWidthPx, machineHeightPx } from './layoutConstants';
import { buildServiceSegments } from './machineZones';
import { computeWalkingWaypoints } from './operatorRouting';

function emptyCounts(activities: ActivityConfig[] = []): Record<ActivityKey, number> {
  return Object.fromEntries(activities.map((activity) => [activity.key, 0]));
}

function emptyDowntime(activities: ActivityConfig[] = []): Record<DowntimeReason, number> {
  return { ...Object.fromEntries(activities.map((activity) => [activity.key, 0])), waiting: 0 };
}

const GLOBAL_EVENT_ACTIVITIES = new Set(['fractureRepairing', 'diesChange', 'defectRepairing']);
const AVERAGE_DIES_PER_CHANGE_EVENT = (7 + 26) / 2;

function dueBreakKind(label: string | null): 'lunch' | 'meeting' {
  return label?.toLowerCase().includes('meeting') ? 'meeting' : 'lunch';
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right > 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function leastCommonMultiple(a: number, b: number): number {
  const divisor = greatestCommonDivisor(a, b);
  return divisor > 0 ? (a / divisor) * b : 0;
}

/** Fraction of assigned machines that start the shift already stopped, waiting on unfinished
 * work from before shift start — rather than every machine beginning fresh mid-run. */
const INITIAL_BACKLOG_CHANCE = 0.3;

interface BreakDef {
  key: string;
  label: string;
  startAt: number;
  duration: number;
  done: boolean;
}

export class SimulationEngine {
  private config: AppConfig;
  private machines: MachineRuntimeState[];
  private operator: OperatorRuntimeState;
  private metrics: SimMetrics;
  private log: EventLogEntry[] = [];
  private runtimePerSpool: number;
  private cycleLengths: Record<ActivityKey, number>;
  private logIdCounter = 0;
  private assignedIds: Set<string>;
  private initialMachineConditions: MachineStartCondition[];
  private breaks: BreakDef[];
  /** Timeline kind each break is recorded as (Lunch / Meeting / Other break). */
  private breakKindByLabel = new Map<string, 'lunch' | 'meeting' | 'otherBreak'>();
  /** Fracture Repairing isn't tracked per machine — it fires once the SUM of spools completed
   * across the whole line reaches its cycle length, then lands on a random currently-running
   * machine (applied once that machine's current spool finishes, never interrupting it mid-run). */
  private globalSpoolsCompleted = 0;
  private globalEventCounts = new Map<ActivityKey, number>();
  private plannedDies = 0;
  private scheduledDies = 0;

  constructor(config: AppConfig) {
    this.config = config;
    const derived = deriveMachineSpec(config.spec);
    this.runtimePerSpool = derived.runtimePerSpool > 0 ? derived.runtimePerSpool : 1;

    this.cycleLengths = Object.fromEntries(
      config.activities.map((activity) => [activity.key, activityCycleLength(activity)]),
    );

    const handled = Math.max(0, Math.floor(config.operator.machHandled));
    const layoutIds = new Set(config.layout.map((m) => m.id));
    const explicitAssigned = (config.assignedMachineIds ?? []).filter((id) => layoutIds.has(id));
    this.assignedIds = new Set(
      explicitAssigned.length > 0 ? explicitAssigned.slice(0, handled) : config.layout.slice(0, handled).map((m) => m.id),
    );
    const savedStartConditions = new Map(
      (config.initialMachineConditions ?? []).map((condition) => [condition.machineId, condition]),
    );

    // Theoretical spools one machine would complete across a full shift, used to randomize
    // each machine's starting phase so the shift doesn't begin with every machine freshly at 0.
    const theoreticalSpoolsPerShift = Math.max(1, Math.floor(config.operator.shiftTime / this.runtimePerSpool));
    // Starting phase must span the LONGEST per-machine cycle, not just one shift's worth of
    // spools: a count-based Loading (POlength ÷ SpoolLength, e.g. CB/BU/SP) can have a cycle
    // longer than the ~7 spools a machine makes per shift. Drawing the phase only from
    // [0, spoolsPerShift) then under-samples machines that start close to their next Loading, so
    // fewer than the expected number come due in the shift (WW's weight-based Loading already
    // randomizes over its full cycle, which is why it didn't drift).
    const longestCycle = config.activities
      .filter((activity) => !GLOBAL_EVENT_ACTIVITIES.has(activity.key) && !activity.loadingInterrupt)
      .reduce((max, activity) => {
        const cycle = this.cycleLengths[activity.key];
        return Number.isFinite(cycle) && cycle > max ? cycle : max;
      }, 0);
    const startPhaseRange = Math.max(theoreticalSpoolsPerShift, Math.ceil(longestCycle));
    const diesActivity = config.activities.find((activity) => activity.key === 'diesChange');
    this.plannedDies =
      diesActivity && diesActivity.numerator > 0
        ? (theoreticalSpoolsPerShift * this.assignedIds.size * derived.spoolWeight * diesActivity.numerator) / 1000
        : 0;

    this.machines = config.layout.map((m) => {
      const assigned = this.assignedIds.has(m.id);
      const savedCondition = savedStartConditions.get(m.id);
      const startSpools = assigned
        ? savedCondition
          ? Math.max(0, Math.floor(savedCondition.spoolsCompleted))
          : Math.floor(Math.random() * startPhaseRange)
        : 0;
      // Per-machine cycle catch-up only applies to Doffing/Loading — Fracture Repairing is global.
      const completedByActivity = savedCondition
        ? { ...emptyCounts(config.activities), ...savedCondition.completedByActivity }
        : emptyCounts(config.activities);
      config.activities.filter((activity) => !GLOBAL_EVENT_ACTIVITIES.has(activity.key)).forEach(({ key }) => {
        if (savedCondition) return;
        const cycle = this.cycleLengths[key];
        completedByActivity[key] = Number.isFinite(cycle) && cycle > 0 ? Math.floor(startSpools / cycle) : 0;
      });
      const widthPx = machineWidthPx(m, config.movement.pixelsPerMeter);
      const heightPx = machineHeightPx(m, config.movement.pixelsPerMeter);
      const machine: MachineRuntimeState = {
        id: m.id,
        label: m.label,
        x: m.x + widthPx / 2,
        y: m.y + heightPx / 2,
        type: m.type,
        orientation: m.orientation,
        pairSide: m.pairSide,
        widthPx,
        heightPx,
        status: assigned
          ? savedCondition?.status === 'needs-service'
            ? 'needs-service'
            : 'running'
          : 'unassigned',
        spoolsCompleted: startSpools,
        shiftSpoolsCompleted: 0,
        spoolsSinceLoading: savedCondition?.spoolsSinceLoading ?? (() => {
          const loading = config.activities.find((activity) => activity.key === 'loading');
          const loadingCycle = this.cycleLengths.loading;
          if (loading?.loadingInterrupt && Number.isFinite(loadingCycle) && loadingCycle > 0) {
            // Weight-based Loading has its own production phase. Randomize it across the full
            // cycle instead of deriving it from startSpools, which is capped at one shift.
            return Math.random() * loadingCycle;
          }
          return Number.isFinite(loadingCycle) && loadingCycle > 0 ? startSpools % loadingCycle : startSpools;
        })(),
        nextCompletionAt: savedCondition?.nextCompletionAt ?? (assigned ? Math.random() * this.runtimePerSpool : this.runtimePerSpool),
        pendingTasks: savedCondition?.pendingTasks.map((task) => ({ ...task })) ?? [],
        queuedSince: savedCondition?.queuedSince ?? null,
        totalServiced: 0,
        completedByActivity,
        downtimeMin: 0,
        downtimeByReason: emptyDowntime(config.activities),
        timeline: [],
        runtimePaused: false,
        runtimeRemainingMin: null,
      };

      // Simulate a realistic shift start: some machines are already stopped waiting on
      // unfinished work (e.g. left over from the previous operator), so the new operator
      // has something to do immediately instead of everyone idling for the first completion.
      if (assigned && !savedCondition && Math.random() < INITIAL_BACKLOG_CHANCE) {
        machine.spoolsCompleted += 1;
        this.queueTasksForMachine(machine, 0);
        machine.nextCompletionAt = this.runtimePerSpool;
      }

      return machine;
    });

    this.initialMachineConditions = this.machines.map((machine) => ({
      machineId: machine.id,
      machineLabel: machine.label,
      status: machine.status,
      spoolsCompleted: machine.spoolsCompleted,
      spoolsSinceLoading: machine.spoolsSinceLoading,
      nextCompletionAt: machine.nextCompletionAt,
      queuedSince: machine.queuedSince,
      pendingTasks: machine.pendingTasks.map((task) => ({ ...task })),
      completedByActivity: { ...machine.completedByActivity },
    }));

    this.globalSpoolsCompleted = this.machines.reduce((sum, m) => sum + m.spoolsCompleted, 0);
    config.activities.filter((activity) => GLOBAL_EVENT_ACTIVITIES.has(activity.key)).forEach((activity) => {
      const cycle = this.cycleLengths[activity.key];
      const expectedDiesEvents =
        activity.key === 'diesChange' && this.plannedDies > 0
          ? Math.ceil(this.plannedDies / AVERAGE_DIES_PER_CHANGE_EVENT)
          : 0;
      const totalTheoreticalSpools = theoreticalSpoolsPerShift * this.assignedIds.size;
      const eventCycle =
        activity.key === 'diesChange' && expectedDiesEvents > 0
          ? totalTheoreticalSpools / expectedDiesEvents
          : cycle;
      this.globalEventCounts.set(
        activity.key,
        Number.isFinite(eventCycle) && eventCycle > 0 ? Math.floor(this.globalSpoolsCompleted / eventCycle) : 0,
      );
    });

    const start = this.config.operatorStart ?? this.machines[0] ?? { x: 0, y: 0 };
    this.operator = {
      x: start.x,
      y: start.y,
      phase: 'idle',
      targetMachineId: null,
      targetMachineLabel: null,
      fromX: start.x,
      fromY: start.y,
      toX: start.x,
      toY: start.y,
      walkProgress: 0,
      walkDurationMin: 0,
      pendingWaypoints: [],
      plannedRoute: [],
      serviceTasks: [],
      serviceSegments: [],
      serviceSubPhase: null,
      currentZoneLabel: null,
      zoneMoveFromX: start.x,
      zoneMoveFromY: start.y,
      zoneMoveToX: start.x,
      zoneMoveToY: start.y,
      zoneMoveProgress: 0,
      zoneMoveDurationMin: 0,
      zoneDwellRemainingMin: 0,
      breakLabel: null,
      breakRemainingMin: 0,
      timeline: [],
    };

    this.breaks = [
      {
        key: 'lunch',
        label: 'Lunch Time',
        startAt: Math.max(0, config.operator.lunchStartAt),
        duration: Math.max(0, config.operator.lunchTime),
        done: config.operator.lunchTime <= 0,
      },
      {
        key: 'meeting',
        label: 'Meeting Time',
        startAt: Math.max(0, config.operator.meetingStartAt),
        duration: Math.max(0, config.operator.meetingTime),
        done: config.operator.meetingTime <= 0,
      },
      ...(config.operator.extraBreaks ?? []).map((extra, index) => ({
        key: `other-${extra.id}`,
        label: `Other${index + 1}`,
        startAt: Math.max(0, extra.startAt || 0),
        duration: Math.max(0, extra.time || 0),
        done: !(extra.time > 0),
      })),
    ].sort((a, b) => a.startAt - b.startAt);
    this.breakKindByLabel = new Map(
      this.breaks.map((b) => [b.label, b.key === 'lunch' ? 'lunch' : b.key === 'meeting' ? 'meeting' : 'otherBreak'] as const),
    );

    this.metrics = {
      clockMin: 0,
      shiftTimeMin: config.operator.shiftTime,
      runtimePerSpoolMin: this.runtimePerSpool,
      availableTimeMin: availableTimeMinutes(
        config.operator.shiftTime,
        config.operator.lunchTime,
        config.operator.meetingTime,
        extraBreakMinutes(config.operator.extraBreaks),
      ),
      breakElapsedMin: 0,
      walkingMin: 0,
      servicingMin: 0,
      servicingByActivity: emptyCounts(config.activities),
      idleMin: 0,
      completedByActivity: emptyCounts(config.activities),
      diesChanged: 0,
      plannedDies: this.plannedDies,
      totalWaitMin: 0,
      totalWaitCount: 0,
      queueLength: 0,
      assignedMachineCount: this.assignedIds.size,
      downtimeByReason: emptyDowntime(config.activities),
      theoreticalSpoolsPerShift,
      expectedEventsByActivity: Object.fromEntries(
        config.activities.map((activity) => [activity.key, this.expectedEvents(theoreticalSpoolsPerShift, activity.key)]),
      ),
    };
  }

  /** Expected occurrences of an activity per finished spool on one machine (0 if it never comes due). */
  private eventsPerSpool(key: ActivityKey): number {
    const cycle = this.cycleLengths[key];
    if (!Number.isFinite(cycle) || cycle <= 0) return 0;
    let rate = 1 / cycle;
    const activity = this.config.activities.find((item) => item.key === key);
    if (activity?.parentKey) {
      const parentCycle = this.cycleLengths[activity.parentKey];
      if (Number.isFinite(parentCycle) && parentCycle > 0) {
        const overlapCycle = leastCommonMultiple(cycle, parentCycle);
        // Parent activity covers the child at shared spool boundaries.
        if (overlapCycle > 0) rate -= 1 / overlapCycle;
      }
    }
    return Math.max(0, rate);
  }

  /** Spools one machine can realistically finish in a shift: a machine is not producing while it
   * is stopped for Doffing/Loading/Fracture etc., so each spool really costs runtime PLUS the
   * average stop time those activities add per spool (Run-condition tasks don't stop it). The old
   * estimate used runtime alone (shift ÷ runtimePerSpool), which overstated spool count — and every
   * per-spool activity forecast built on it, Loading most visibly. Operator queueing/walking isn't
   * knowable up front, so this is still a best case, just a much tighter one. */
  private expectedSpoolsPerMachine(): number {
    const stopMinPerSpool = this.config.activities
      .filter((activity) => activity.key !== 'diesChange' && activity.machCondition === 'stop')
      .reduce((sum, activity) => sum + this.eventsPerSpool(activity.key) * activity.timeMinutes, 0);
    const minutesPerSpool = this.runtimePerSpool + stopMinPerSpool;
    return minutesPerSpool > 0 ? this.config.operator.shiftTime / minutesPerSpool : 0;
  }

  private expectedEvents(_theoreticalSpoolsPerShift: number, key: ActivityKey): number {
    const cycle = this.cycleLengths[key];
    if (!Number.isFinite(cycle) || cycle <= 0) return 0;
    if (key === 'diesChange') {
      return this.plannedDies > 0 ? Math.ceil(this.plannedDies / AVERAGE_DIES_PER_CHANGE_EVENT) : 0;
    }
    const totalSpools = this.expectedSpoolsPerMachine() * this.assignedIds.size;
    return Math.max(0, Math.round(totalSpools * this.eventsPerSpool(key)));
  }

  private findActivity(key: ActivityKey): ActivityConfig {
    const found = this.config.activities.find((a) => a.key === key);
    if (found) return found;
    return {
      key,
      label: key,
      timeMinutes: 0,
      numerator: 1,
      numeratorAuto: false,
      denominator: Infinity,
      denominatorAuto: false,
      machCondition: 'stop',
    };
  }

  /** Run-condition activities are serviced without freezing the machine's production clock. */
  private isStopActivity(key: ActivityKey): boolean {
    return (this.findActivity(key).machCondition ?? 'stop') !== 'run';
  }

  private addLog(atMin: number, message: string) {
    this.logIdCounter += 1;
    this.log.push({ id: `log-${this.logIdCounter}`, timeMin: atMin, message });
    if (this.log.length > 200) this.log.shift();
  }

  /** If both Loading Partial1 and Partial2 just came due together on the same machine, the
   * regulation is a single combined "Loading Partial3" task instead of doing both back to back —
   * its Time/MachCondition come from Partial3's own WL_Activities row (see loadingPartialSlot).
   * Partial1/Partial2 stay marked as handled either way (done in the caller), so this only changes
   * what actually gets queued for the operator, not the per-machine due-cycle bookkeeping. */
  private combineLoadingPartials(newTasks: PendingTask[]) {
    const partial1 = this.config.activities.find((a) => a.loadingPartialSlot === 1);
    const partial2 = this.config.activities.find((a) => a.loadingPartialSlot === 2);
    const partial3 = this.config.activities.find((a) => a.loadingPartialSlot === 3);
    if (!partial1 || !partial2 || !partial3) return;
    const index1 = newTasks.findIndex((t) => t.activity === partial1.key);
    const index2 = newTasks.findIndex((t) => t.activity === partial2.key);
    if (index1 === -1 || index2 === -1) return;
    const insertAt = Math.min(index1, index2);
    const combined: PendingTask = { activity: partial3.key, label: partial3.label, timeMinutes: partial3.timeMinutes };
    const remaining = newTasks.filter((t) => t.activity !== partial1.key && t.activity !== partial2.key);
    remaining.splice(insertAt, 0, combined);
    newTasks.length = 0;
    newTasks.push(...remaining);
  }

  /** Doffing/Loading are per-machine: each machine tracks its own spool count against its own
   * cycle. Fracture Repairing is handled separately, globally — see triggerGlobalFractureIfDue. */
  private queueTasksForMachine(machine: MachineRuntimeState, atMin: number) {
    const newTasks: PendingTask[] = [];
    const dueCounts = new Map<ActivityKey, number>();
    const handledCounts = new Map<ActivityKey, number>();
    this.config.activities.forEach(({ key }) => {
      const cycle = this.cycleLengths[key];
      dueCounts.set(key, Number.isFinite(cycle) && cycle > 0 ? Math.floor(machine.spoolsCompleted / cycle) : 0);
      handledCounts.set(key, machine.completedByActivity[key] ?? 0);
    });
    this.config.activities.filter((activity) => !GLOBAL_EVENT_ACTIVITIES.has(activity.key)).forEach((activity) => {
      const { key } = activity;
      if (activity.loadingInterrupt) return;
      const cycle = this.cycleLengths[key];
      if (!Number.isFinite(cycle) || cycle <= 0) return;
      const dueCount = dueCounts.get(key) ?? 0;
      const alreadyHandled = handledCounts.get(key) ?? 0;
      if (dueCount > alreadyHandled) {
        const parent = activity.parentKey ? this.config.activities.find((item) => item.key === activity.parentKey) : null;
        const parentDue = parent
          ? (dueCounts.get(parent.key) ?? 0) > (handledCounts.get(parent.key) ?? 0)
          : false;

        // Loading's sub-activity is an alternative to its parent at the same spool boundary —
        // only schedule it in the intervals where full Loading is not due. Other parents (e.g.
        // Doffing) schedule their sub every time it's due, running right after the parent task —
        // config.activities keeps parents ordered before their subs, so it lands after in pendingTasks.
        const altersWithParent = parent?.key === 'loading';
        if (!altersWithParent || !parentDue) {
          newTasks.push({
            activity: key,
            label: activity.label,
            timeMinutes: activity.timeMinutes,
            loadingPayoffOnly: activity.loadingInterrupt,
            defectTakeupOnly: activity.defectTakeupOnly,
          });
        }
        machine.completedByActivity[key] = dueCount;
      }
    });

    this.combineLoadingPartials(newTasks);

    if (newTasks.length > 0) {
      const existingKeys = new Set(machine.pendingTasks.map((t) => t.activity));
      newTasks.forEach((t) => {
        if (!existingKeys.has(t.activity)) machine.pendingTasks.push(t);
      });
      this.addLog(atMin, `${machine.label} butuh ${newTasks.map((t) => t.label).join(', ')}`);
    }

    // Flip to needs-service whenever a Stop-condition task is pending — including a fracture task
    // that was injected earlier while this machine was still mid-run. A machine whose only pending
    // work is Run-condition activities keeps producing; the operator services it without stopping it.
    if (machine.status === 'running' && machine.pendingTasks.some((t) => this.isStopActivity(t.activity))) {
      machine.status = 'needs-service';
      machine.queuedSince = atMin;
    }
  }

  /** Picks a random currently-running machine for a line-level event. It only takes effect once
   * that machine's own spool naturally completes — never interrupts a run in progress. */
  private injectGlobalActivityTask(activityKey: ActivityKey, atMin: number): boolean {
    const candidates = this.machines.filter((m) => m.status === 'running');
    if (candidates.length === 0) return false;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (target.pendingTasks.some((t) => t.activity === activityKey)) return false;
    const activity = this.findActivity(activityKey);
    const remainingDies = Math.max(0, Math.ceil(this.plannedDies - this.scheduledDies));
    const requestedQuantity = Math.random() < 0.5 ? 7 : 26;
    const quantity =
      activityKey === 'diesChange'
        ? requestedQuantity <= remainingDies
          ? requestedQuantity
          : remainingDies >= 7
            ? 7
            : 0
        : undefined;
    if (activityKey === 'diesChange' && (!quantity || quantity <= 0)) return false;
    const timeMinutes = activity.timeMinutes * (quantity ?? 1);
    const label = quantity ? `${activity.label} (${quantity} dies)` : activity.label;
    target.pendingTasks.push({
      activity: activityKey,
      label,
      timeMinutes,
      quantity,
      defectTakeupOnly: activity.defectTakeupOnly,
    });
    if (activityKey === 'diesChange') this.scheduledDies += quantity ?? 0;
    if (this.isStopActivity(activityKey)) {
      target.runtimeRemainingMin = Math.max(0, target.nextCompletionAt - atMin);
      target.runtimePaused = true;
      target.status = 'needs-service';
      target.queuedSince = atMin;
      target.nextCompletionAt = Number.POSITIVE_INFINITY;
      this.addLog(atMin, `${label} scheduled on Machine ${target.label} after the current runtime`);
    } else {
      this.addLog(atMin, `${label} scheduled on Machine ${target.label} while running`);
    }
    return true;
  }

  /** Processes spool completions using an absolute clock cursor so events log at the right time.
   * Only 'running' machines produce — once a machine is stopped for Doffing/Loading/Fracture
   * Repairing (or just queued waiting for the operator), its production clock is frozen, since
   * that time is downtime, not more spools completing unattended. */
  private advanceMachines(fromMin: number, toMin: number) {
    for (const machine of this.machines) {
      if (machine.status !== 'running') continue;
      let guard = 0;
      while (machine.nextCompletionAt <= toMin && guard < 200) {
        guard += 1;
        machine.spoolsCompleted += 1;
        this.globalSpoolsCompleted += 1;
        machine.shiftSpoolsCompleted += 1;
        machine.spoolsSinceLoading += 1;
        const completedAt = Math.max(fromMin, machine.nextCompletionAt);
        machine.nextCompletionAt += this.runtimePerSpool;
        this.queueTasksForMachine(machine, completedAt);
      }
    }
  }

  private triggerMidRuntimeGlobalActivity(activityKey: ActivityKey, atMin: number) {
    const cycle = this.cycleLengths[activityKey];
    if (!Number.isFinite(cycle) || cycle <= 0) return;
    const totalTheoreticalSpools =
      Math.max(1, Math.floor(this.config.operator.shiftTime / this.runtimePerSpool)) * this.assignedIds.size;
    const expectedDiesEvents =
      this.plannedDies > 0 ? Math.ceil(this.plannedDies / AVERAGE_DIES_PER_CHANGE_EVENT) : 0;
    const eventCycle =
      activityKey === 'diesChange' && expectedDiesEvents > 0
        ? totalTheoreticalSpools / expectedDiesEvents
        : cycle;
    const fractionalSpools = this.machines.reduce((total, machine) => {
      if (machine.status !== 'running') return total;
      const elapsed = this.runtimePerSpool - (machine.nextCompletionAt - atMin);
      return total + Math.max(0, Math.min(1, elapsed / this.runtimePerSpool));
    }, this.globalSpoolsCompleted);
    let eventsTriggered = this.globalEventCounts.get(activityKey) ?? 0;
    while (fractionalSpools >= (eventsTriggered + 1) * eventCycle) {
      if (!this.injectGlobalActivityTask(activityKey, atMin)) break;
      eventsTriggered += 1;
    }
    this.globalEventCounts.set(activityKey, eventsTriggered);

  }

  private triggerMidRuntimeLoading(machine: MachineRuntimeState, atMin: number) {
      const activity = this.config.activities.find((item) => item.key === 'loading');
      if (!activity?.loadingInterrupt || machine.status !== 'running') return;
      const cycle = this.cycleLengths.loading;
      if (!Number.isFinite(cycle) || cycle <= 0) return;
      const fractionalProgress = Math.max(
        0,
        Math.min(1, (this.runtimePerSpool - (machine.nextCompletionAt - atMin)) / this.runtimePerSpool),
      );
      if (machine.spoolsSinceLoading + fractionalProgress < cycle ||
        machine.pendingTasks.some((task) => task.activity === 'loading')) return;
      machine.pendingTasks.push({
        activity: 'loading',
        label: activity.label,
        timeMinutes: activity.timeMinutes,
        loadingPayoffOnly: true,
      });
      machine.runtimeRemainingMin = Math.max(0, machine.nextCompletionAt - atMin);
      machine.runtimePaused = true;
      machine.status = 'needs-service';
      machine.queuedSince = atMin;
      machine.nextCompletionAt = Number.POSITIVE_INFINITY;
      this.addLog(atMin, `${machine.label} needs ${activity.label} (weight threshold reached)`);
  }

  private accumulateDowntime(deltaMin: number) {
    for (const machine of this.machines) {
      if (machine.status === 'unassigned' || machine.status === 'running') continue;
      const beingServicedNow = this.operator.phase === 'servicing' && this.operator.targetMachineId === machine.id;
      if (beingServicedNow) continue; // exact amount attributed at finishService
      machine.downtimeMin += deltaMin;
      machine.downtimeByReason.waiting += deltaMin;
      this.metrics.downtimeByReason.waiting += deltaMin;
    }
  }

  private pickNextTarget(): MachineRuntimeState | null {
    // Machines still 'running' can be candidates too — that's a Run-condition task pending,
    // which the operator services without stopping the machine's production.
    const candidates = this.machines.filter(
      (m) => (m.status === 'needs-service' || m.status === 'running') && m.pendingTasks.length > 0,
    );
    if (candidates.length === 0) return null;
    const score =
      this.config.operator.taskPriority === 'quickest'
        ? (m: MachineRuntimeState) => this.estimateServiceEtaMin(m)
        : (m: MachineRuntimeState) => this.walkingDistanceMeters(this.operator.x, this.operator.y, m.x, m.y);
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

  /** Real walking distance (meters) between two points, following the same corridor route the
   * operator will actually walk — used for target-picking so 'nearest'/'quickest' aren't fooled by
   * straight-line distance when the corridor detour makes another machine genuinely faster to reach. */
  private walkingDistanceMeters(fromX: number, fromY: number, toX: number, toY: number): number {
    const route = computeWalkingWaypoints({ x: fromX, y: fromY }, { x: toX, y: toY }, this.machines, this.config.movement.pixelsPerMeter);
    let total = 0;
    for (let i = 1; i < route.length; i += 1) {
      total += distanceMeters(route[i - 1].x, route[i - 1].y, route[i].x, route[i].y, this.config.movement.pixelsPerMeter);
    }
    return total;
  }

  /** Total time (walking + all zone dwells/moves) from the operator's current position until every
   * pending task on this machine would be finished — used to rank machines under 'quickest' priority. */
  private estimateServiceEtaMin(machine: MachineRuntimeState): number {
    const speed = this.config.movement.walkingSpeed > 0 ? this.config.movement.walkingSpeed : 1;
    const pxPerM = this.config.movement.pixelsPerMeter;
    const segments = buildServiceSegments(
      machine.pendingTasks,
      machine.x,
      machine.y,
      machine.orientation,
      machine.pairSide,
      this.config.movement.walkingSpeed,
      pxPerM,
      machine.widthPx,
      machine.heightPx,
    );
    if (segments.length === 0) {
      return this.walkingDistanceMeters(this.operator.x, this.operator.y, machine.x, machine.y) / speed;
    }
    let total = this.walkingDistanceMeters(this.operator.x, this.operator.y, segments[0].x, segments[0].y) / speed;
    total += segments[0].dwellMin;
    for (let i = 1; i < segments.length; i += 1) {
      total += distanceMeters(segments[i - 1].x, segments[i - 1].y, segments[i].x, segments[i].y, pxPerM) / speed;
      total += segments[i].dwellMin;
    }
    return total;
  }

  private startWalkingTo(machine: MachineRuntimeState) {
    const segments = buildServiceSegments(
      machine.pendingTasks,
      machine.x,
      machine.y,
      machine.orientation,
      machine.pairSide,
      this.config.movement.walkingSpeed,
      this.config.movement.pixelsPerMeter,
      machine.widthPx,
      machine.heightPx,
    );
    const firstStop = segments[0] ?? { x: machine.x, y: machine.y };
    // Route the hop through inter-row aisles rather than a straight line, so it doesn't visually
    // cut through whatever machine row sits between the operator and its target (heuristic, not
    // real pathfinding — see computeWalkingWaypoints).
    const route = computeWalkingWaypoints(
      { x: this.operator.x, y: this.operator.y },
      { x: firstStop.x, y: firstStop.y },
      this.machines,
      this.config.movement.pixelsPerMeter,
    );
    const [firstHop, ...remainingHops] = route.slice(1);
    const speed = this.config.movement.walkingSpeed > 0 ? this.config.movement.walkingSpeed : 1;
    this.operator.phase = 'walking';
    this.operator.targetMachineId = machine.id;
    this.operator.targetMachineLabel = machine.label;
    this.operator.fromX = this.operator.x;
    this.operator.fromY = this.operator.y;
    this.operator.toX = firstHop.x;
    this.operator.toY = firstHop.y;
    this.operator.walkProgress = 0;
    this.operator.walkDurationMin =
      distanceMeters(this.operator.fromX, this.operator.fromY, firstHop.x, firstHop.y, this.config.movement.pixelsPerMeter) / speed;
    this.operator.pendingWaypoints = remainingHops;
    this.operator.plannedRoute = route;
    // Machine keeps whatever run/stop state queueTasksForMachine already gave it while queued —
    // the per-task state (stop vs keep running) is applied task-by-task once servicing starts,
    // since a single visit can mix Stop and Run activities back to back.
  }

  /** Advances to the next queued corridor waypoint, or arrives at the target machine if none remain. */
  private advanceWalkOrFinish() {
    const next = this.operator.pendingWaypoints.shift();
    if (!next) {
      this.finishWalk();
      return;
    }
    const speed = this.config.movement.walkingSpeed > 0 ? this.config.movement.walkingSpeed : 1;
    this.operator.fromX = this.operator.toX;
    this.operator.fromY = this.operator.toY;
    this.operator.toX = next.x;
    this.operator.toY = next.y;
    this.operator.walkProgress = 0;
    this.operator.walkDurationMin =
      distanceMeters(this.operator.fromX, this.operator.fromY, next.x, next.y, this.config.movement.pixelsPerMeter) / speed;
  }

  private nextPendingBreak(clockCursor: number): BreakDef | null {
    return this.breaks.find((b) => !b.done && clockCursor >= b.startAt) ?? null;
  }

  private recordOperatorTime(startMin: number, duration: number, kind: OperatorTimelineKind, label: string) {
    if (duration <= 1e-9) return;
    const timeline = this.operator.timeline;
    const previous = timeline[timeline.length - 1];
    if (previous && previous.endMin >= startMin - 1e-9 && previous.kind === kind && previous.label === label) {
      previous.endMin = Math.max(previous.endMin, startMin + duration);
      return;
    }
    const segment: OperatorTimelineSegment = { startMin, endMin: startMin + duration, kind, label };
    timeline.push(segment);
  }

  private serviceTaskForCurrentZone(): PendingTask | undefined {
    const activityLabel = this.operator.currentZoneLabel?.split(' — ')[0];
    return activityLabel
      ? this.operator.serviceTasks.find((task) => task.label === activityLabel)
      : undefined;
  }

  private recordMachineTime(machine: MachineRuntimeState, startMin: number, duration: number) {
    if (duration <= 1e-9 || machine.status === 'unassigned') return;
    // A Run-condition visit never flips the machine out of 'running', so operator presence can't be
    // gated on machine.status === 'being-serviced' — it must be checked directly against the operator.
    const isOperatorAtMachine = this.operator.phase === 'servicing' && this.operator.targetMachineId === machine.id;
    const currentServiceLabel = this.operator.currentZoneLabel?.split(' — ')[0];
    const currentServiceTask =
      isOperatorAtMachine && currentServiceLabel
        ? this.operator.serviceTasks.find((task) => task.label === currentServiceLabel)
        : undefined;
    const includesMovement = currentServiceTask?.activity === 'loading' ||
      currentServiceTask?.activity.startsWith('loading-') ||
      currentServiceTask?.activity === 'fractureRepairing' ||
      currentServiceTask?.activity.startsWith('fractureRepairing-') ||
      currentServiceTask?.activity === 'diesChange' ||
      currentServiceTask?.activity.startsWith('diesChange-') ||
      currentServiceTask?.activity === 'defectRepairing' ||
      currentServiceTask?.activity.startsWith('defectRepairing-');
    const isOperatorWorking =
      isOperatorAtMachine &&
      (this.operator.serviceSubPhase === 'dwelling' || (this.operator.serviceSubPhase === 'moving' && includesMovement));
    const activeTask = isOperatorWorking ? currentServiceTask ?? this.operator.serviceTasks[0] : undefined;
    const waitingActivity = machine.pendingTasks[0]?.activity;
    // Still 'running' + an active task means a Run-condition activity: the machine never stopped,
    // so the timeline records both facts together (rendered as a split running/activity bar).
    const kind: MachineTimelineKind = machine.status === 'running'
      ? (activeTask ? `running:${activeTask.activity}` : 'running')
      : activeTask?.activity ?? (waitingActivity ? `waiting:${waitingActivity}` : 'waiting');
    const label = kind === 'running'
      ? 'Running'
      : activeTask && kind === `running:${activeTask.activity}`
        ? `Running + ${activeTask.label}`
        : activeTask?.label ?? (waitingActivity ? `Waiting ${machine.pendingTasks[0]?.label}` : 'Waiting servis');
    const timeline = machine.timeline;
    const previous = timeline[timeline.length - 1];
    if (previous && previous.endMin >= startMin - 1e-9 && previous.kind === kind) {
      previous.endMin = Math.max(previous.endMin, startMin + duration);
      return;
    }
    const segment: MachineTimelineSegment = { startMin, endMin: startMin + duration, kind, label };
    timeline.push(segment);
  }

  /** Advances the operator FSM across [startMin, startMin+deltaMin], using a local clock cursor
   * so breaks/log entries triggered mid-tick get the correct timestamp. */
  private advanceOperator(startMin: number, deltaMin: number) {
    let remaining = deltaMin;
    let clockCursor = startMin;
    let guard = 0;
    while (remaining > 1e-9 && guard < 500) {
      guard += 1;

      if (this.operator.phase === 'idle') {
        const dueBreak = this.nextPendingBreak(clockCursor);
        if (dueBreak) {
          dueBreak.done = true;
          this.operator.phase = 'break';
          this.operator.breakLabel = dueBreak.label;
          this.operator.breakRemainingMin = dueBreak.duration;
          this.addLog(clockCursor, `Started ${dueBreak.label} (${dueBreak.duration} minutes)`);
          continue;
        }

        const target = this.pickNextTarget();
        if (!target) {
          this.recordOperatorTime(clockCursor, remaining, 'idle', 'Idle');
          this.metrics.idleMin += remaining;
          remaining = 0;
          break;
        }
        if (target.queuedSince != null) {
          this.metrics.totalWaitMin += clockCursor - target.queuedSince;
          this.metrics.totalWaitCount += 1;
        }
        this.startWalkingTo(target);
        continue;
      }

      if (this.operator.phase === 'break') {
        const step = Math.min(remaining, this.operator.breakRemainingMin);
        this.operator.breakRemainingMin -= step;
        this.metrics.breakElapsedMin += step;
        this.recordOperatorTime(
          clockCursor,
          step,
          this.breakKindByLabel.get(this.operator.breakLabel ?? '') ?? dueBreakKind(this.operator.breakLabel),
          this.operator.breakLabel ?? 'Break',
        );
        remaining -= step;
        clockCursor += step;
        if (this.operator.breakRemainingMin <= 1e-9) {
          this.addLog(clockCursor, `Finished ${this.operator.breakLabel}; operator resumed work`);
          this.operator.phase = 'idle';
          this.operator.breakLabel = null;
        }
        continue;
      }

      if (this.operator.phase === 'walking') {
        const duration = this.operator.walkDurationMin;
        if (duration <= 1e-9) {
          this.operator.walkProgress = 1;
          this.advanceWalkOrFinish();
          continue;
        }
        const remainingWalk = (1 - this.operator.walkProgress) * duration;
        const step = Math.min(remaining, remainingWalk);
        this.operator.walkProgress += step / duration;
        this.operator.x = this.operator.fromX + (this.operator.toX - this.operator.fromX) * this.operator.walkProgress;
        this.operator.y = this.operator.fromY + (this.operator.toY - this.operator.fromY) * this.operator.walkProgress;
        this.metrics.walkingMin += step;
        this.recordOperatorTime(clockCursor, step, 'walking', `Moving to Machine ${this.operator.targetMachineLabel ?? ''}`.trim());
        remaining -= step;
        clockCursor += step;
        if (this.operator.walkProgress >= 1 - 1e-9) {
          this.advanceWalkOrFinish();
        }
        continue;
      }

      if (this.operator.phase === 'servicing' && this.operator.serviceSubPhase === 'moving') {
        const duration = this.operator.zoneMoveDurationMin;
        if (duration <= 1e-9) {
          this.operator.x = this.operator.zoneMoveToX;
          this.operator.y = this.operator.zoneMoveToY;
          this.operator.serviceSubPhase = 'dwelling';
          continue;
        }
        const remainingMove = (1 - this.operator.zoneMoveProgress) * duration;
        const step = Math.min(remaining, remainingMove);
        this.operator.zoneMoveProgress += step / duration;
        this.operator.x =
          this.operator.zoneMoveFromX + (this.operator.zoneMoveToX - this.operator.zoneMoveFromX) * this.operator.zoneMoveProgress;
        this.operator.y =
          this.operator.zoneMoveFromY + (this.operator.zoneMoveToY - this.operator.zoneMoveFromY) * this.operator.zoneMoveProgress;
        const movingTask = this.serviceTaskForCurrentZone();
        const includesMovement = movingTask?.activity === 'loading' || movingTask?.activity.startsWith('loading-') ||
          movingTask?.activity === 'fractureRepairing' || movingTask?.activity.startsWith('fractureRepairing-') ||
          movingTask?.activity === 'diesChange' || movingTask?.activity.startsWith('diesChange-') ||
          movingTask?.activity === 'defectRepairing' || movingTask?.activity.startsWith('defectRepairing-');
        if (includesMovement && movingTask) {
          this.metrics.servicingMin += step;
          this.metrics.servicingByActivity[movingTask.activity] =
            (this.metrics.servicingByActivity[movingTask.activity] ?? 0) + step;
          this.recordOperatorTime(clockCursor, step, movingTask.activity, movingTask.label);
        } else {
          this.metrics.walkingMin += step;
          this.recordOperatorTime(clockCursor, step, 'walking', 'Moving between machine zones');
        }
        remaining -= step;
        clockCursor += step;
        if (this.operator.zoneMoveProgress >= 1 - 1e-9) {
          this.operator.x = this.operator.zoneMoveToX;
          this.operator.y = this.operator.zoneMoveToY;
          this.operator.serviceSubPhase = 'dwelling';
        }
        continue;
      }

      if (this.operator.phase === 'servicing' && this.operator.serviceSubPhase === 'dwelling') {
        const step = Math.min(remaining, this.operator.zoneDwellRemainingMin);
        this.operator.zoneDwellRemainingMin -= step;
        this.metrics.servicingMin += step;
        const task = this.serviceTaskForCurrentZone();
        const activityKey = task?.activity ?? 'service';
        this.metrics.servicingByActivity[activityKey] = (this.metrics.servicingByActivity[activityKey] ?? 0) + step;
        this.recordOperatorTime(clockCursor, step, activityKey, this.operator.currentZoneLabel ?? 'Handle');
        remaining -= step;
        clockCursor += step;
        if (this.operator.zoneDwellRemainingMin <= 1e-9) {
          this.advanceToNextZone(clockCursor);
        }
        continue;
      }
    }
  }

  /** Flips a machine between actually producing and actually stopped, capturing/restoring the
   * in-progress spool's remaining time across the transition — the same trick injectFractureTask
   * uses. Called per-task during a visit so a single trip can mix Stop and Run activities: the
   * machine only stops for the portions that require it. */
  private setMachineRunState(machine: MachineRuntimeState, running: boolean, atMin: number) {
    if (running) {
      if (machine.status !== 'running') {
        machine.nextCompletionAt = atMin + (machine.runtimeRemainingMin ?? this.runtimePerSpool);
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

  /** A Run task immediately followed by a Stop task in the same visit stops the machine for its
   * own duration too — there's no point letting it produce for a few more minutes only to halt
   * right after, so that time is also counted as downtime. */
  private isEffectiveStopTask(index: number, tasks: PendingTask[]): boolean {
    const task = tasks[index];
    if (this.isStopActivity(task.activity)) return true;
    const next = tasks[index + 1];
    return next ? this.isStopActivity(next.activity) : false;
  }

  /** Applies the currently-active service task's own Mach Condition to its machine, right as the
   * operator starts working on it (not for the whole visit — later tasks in the same visit can
   * have a different condition) — except a Run task right before a Stop task, which stops too. */
  private syncMachineRunStateForCurrentTask(atMin: number) {
    const machine = this.machines.find((m) => m.id === this.operator.targetMachineId);
    if (!machine) return;
    const task = this.serviceTaskForCurrentZone();
    if (!task) return;
    const index = this.operator.serviceTasks.indexOf(task);
    const shouldStop = index >= 0 ? this.isEffectiveStopTask(index, this.operator.serviceTasks) : this.isStopActivity(task.activity);
    this.setMachineRunState(machine, !shouldStop, atMin);
  }

  private advanceToNextZone(atMin: number) {
    const next = this.operator.serviceSegments.shift();
    if (!next) {
      this.finishService(atMin);
      return;
    }
    const dist = distanceMeters(this.operator.x, this.operator.y, next.x, next.y, this.config.movement.pixelsPerMeter);
    const speed = this.config.movement.walkingSpeed > 0 ? this.config.movement.walkingSpeed : 1;
    this.operator.zoneMoveFromX = this.operator.x;
    this.operator.zoneMoveFromY = this.operator.y;
    this.operator.zoneMoveToX = next.x;
    this.operator.zoneMoveToY = next.y;
    this.operator.zoneMoveProgress = 0;
    this.operator.zoneMoveDurationMin = dist / speed;
    this.operator.zoneDwellRemainingMin = next.dwellMin;
    this.operator.currentZoneLabel = next.label;
    this.operator.serviceSubPhase = dist > 0 ? 'moving' : 'dwelling';
    this.syncMachineRunStateForCurrentTask(atMin);
  }

  private finishWalk() {
    this.operator.phase = 'servicing';
    this.operator.x = this.operator.toX;
    this.operator.y = this.operator.toY;
    const machine = this.machines.find((m) => m.id === this.operator.targetMachineId);
    const tasks = machine ? machine.pendingTasks.splice(0, machine.pendingTasks.length) : [];
    this.operator.serviceTasks = tasks;
    const segments = machine
      ? buildServiceSegments(
          tasks,
          machine.x,
          machine.y,
          machine.orientation,
          machine.pairSide,
          this.config.movement.walkingSpeed,
          this.config.movement.pixelsPerMeter,
          machine.widthPx,
          machine.heightPx,
        )
      : [];
    if (segments.length === 0) {
      this.finishService(this.metrics.clockMin);
      return;
    }
    const first = segments.shift()!;
    this.operator.serviceSegments = segments;
    this.operator.currentZoneLabel = first.label;
    this.operator.zoneDwellRemainingMin = first.dwellMin;
    this.operator.serviceSubPhase = 'dwelling';
    this.syncMachineRunStateForCurrentTask(this.metrics.clockMin);
  }

  private finishService(atMin: number) {
    const machine = this.machines.find((m) => m.id === this.operator.targetMachineId);
    if (machine) {
      // If the machine never left 'running' (a purely Run-condition visit), its production clock
      // was never frozen and must be left alone — only a stopped machine needs restarting.
      const wasStopped = machine.status !== 'running';
      machine.status = 'running';
      machine.queuedSince = null;
      machine.totalServiced += 1;
      if (wasStopped) {
        machine.nextCompletionAt = atMin + (machine.runtimeRemainingMin ?? this.runtimePerSpool);
        machine.runtimePaused = false;
        machine.runtimeRemainingMin = null;
      }
      this.operator.serviceTasks.forEach((t, index, tasks) => {
        this.metrics.completedByActivity[t.activity] += 1;
        if (t.activity === 'diesChange') this.metrics.diesChanged += t.quantity ?? 0;
        if (this.isEffectiveStopTask(index, tasks)) {
          this.metrics.downtimeByReason[t.activity] += t.timeMinutes;
          machine.downtimeByReason[t.activity] += t.timeMinutes;
          machine.downtimeMin += t.timeMinutes;
        }
        if (t.activity === 'loading' || t.activity.startsWith('loading-')) {
          machine.spoolsSinceLoading = 0;
        }
      });
      this.addLog(atMin, `Finished servicing Machine ${machine.label}`);
    }
    this.operator.phase = 'idle';
    this.operator.targetMachineId = null;
    this.operator.targetMachineLabel = null;
    this.operator.serviceTasks = [];
    this.operator.serviceSegments = [];
    this.operator.serviceSubPhase = null;
    this.operator.currentZoneLabel = null;
  }

  tick(deltaMin: number) {
    if (deltaMin <= 0) return;
    if (this.metrics.clockMin >= this.metrics.shiftTimeMin) {
      this.metrics.clockMin = this.metrics.shiftTimeMin;
      return;
    }
    const capped = Math.min(deltaMin, this.metrics.shiftTimeMin - this.metrics.clockMin);
    let remaining = capped;
    // Keep timeline boundaries close to the actual FSM transitions, especially when a
    // fast simulation tick crosses the end of a short activity such as Doffing.
    while (remaining > 1e-9) {
      const step = Math.min(remaining, 0.01);
      const startMin = this.metrics.clockMin;
      this.advanceMachines(startMin, startMin + step);
      this.machines.forEach((machine) => this.triggerMidRuntimeLoading(machine, startMin + step));
      GLOBAL_EVENT_ACTIVITIES.forEach((activityKey) => this.triggerMidRuntimeGlobalActivity(activityKey, startMin + step));
      this.advanceOperator(startMin, step);
      this.accumulateDowntime(step);
      this.metrics.clockMin += step;
      this.machines.forEach((machine) => this.recordMachineTime(machine, startMin, step));
      remaining -= step;
    }
    if (this.metrics.clockMin >= this.metrics.shiftTimeMin - 1e-9) {
      this.metrics.clockMin = this.metrics.shiftTimeMin;
    }
    this.metrics.queueLength = this.machines.filter((m) => m.status === 'needs-service').length;
  }

  getState(): SimulationState {
    return {
      machines: this.machines.map((m) => ({
        ...m,
        completedByActivity: { ...m.completedByActivity },
        downtimeByReason: { ...m.downtimeByReason },
        timeline: m.timeline.map((segment) => ({ ...segment })),
      })),
      initialMachineConditions: this.initialMachineConditions.map((condition) => ({
        ...condition,
        pendingTasks: condition.pendingTasks.map((task) => ({ ...task })),
        completedByActivity: { ...condition.completedByActivity },
      })),
      operator: { ...this.operator, timeline: this.operator.timeline.map((segment) => ({ ...segment })) },
      metrics: {
        ...this.metrics,
        completedByActivity: { ...this.metrics.completedByActivity },
        downtimeByReason: { ...this.metrics.downtimeByReason },
      },
      log: [...this.log],
      finished: this.metrics.clockMin >= this.metrics.shiftTimeMin - 1e-9,
    };
  }
}
