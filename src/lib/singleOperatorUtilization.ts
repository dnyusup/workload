import type { ActivityConfig, AppConfig, LayoutMachine, WaitingModel } from '../types';
import { activityCycleLength, applyRpc, availableTimeMinutes, deriveMachineSpec, distanceMeters, extraBreakMinutes } from './calculations';
import { forecastCycleLength } from './frequencyTypes';
import { generatePairedGrid, PAIR_GAP } from './gridLayout';
import { machineWidthPx } from './layoutConstants';

const AVERAGE_DIES_PER_CHANGE_EVENT = (7 + 26) / 2;
const GLOBAL_EVENT_ACTIVITIES = new Set(['fractureRepairing', 'diesChange', 'defectRepairing']);
/** Columns of the stand-in grid used for machines the layout doesn't have yet (Generate Grid's default). */
const PLACEHOLDER_GRID_COLS = 10;
/** Upper bound for Optimize's search now that it isn't capped by the layout's machine count. */
const MAX_RECOMMENDED_MACHINES = 300;
/** Optimize stops once this many counts in a row all leave a backlog. */
const OPTIMIZE_BACKLOG_STREAK = 5;

export const DEFAULT_WAITING_MODEL: WaitingModel = 'wright';

export interface ForecastActivityContribution {
  key: string;
  label: string;
  handlingMinutes: number;
  downtimeMinutes: number;
}

/** One activity's line in the forecast breakdown, summed over every assigned machine. */
export interface ForecastActivityStep {
  key: string;
  label: string;
  /** Per machine (from its own spools) or once across the line (Fracture / Dies / Defect). */
  scope: 'machine' | 'line';
  stopsMachine: boolean;
  /** Spools per occurrence (dies per change event for Dies Change: see quantity). */
  cycle: number;
  /** Times it happens in the shift. */
  events: number;
  /** Dies changed (Dies Change only), each taking timeMinutes. */
  quantity?: number;
  timeMinutes: number;
  timeWithRpcMinutes: number;
  /** Ideal demand: occurrences × time with RPC. */
  plannedMinutes: number;
  /** plannedMinutes × the forecast scale. */
  forecastMinutes: number;
}

/** Every intermediate value behind the forecast, for showing how it's calculated. */
export interface ForecastBreakdown {
  shiftMinutes: number;
  lunchMinutes: number;
  meetingMinutes: number;
  otherBreakMinutes: number;
  rpcPercent: number;
  runtimePerSpool: number;
  expectedSpoolsPerMachine: number;
  layoutMachineCount: number;
  placeholderMachineCount: number;
  /** Stop-activity minutes per spool (without RPC), which keep a machine from producing. */
  stopMinutesPerSpool: number;
  /** runtime ÷ (runtime + stop minutes per spool): availability after Stop activities only. */
  stopAvailability: number;
  /** Each machine's waiting for the operator in the shift (see machineWaitingMinutes). */
  waitingPerMachineMinutes: number;
  /** OEE availability: stopAvailability × (shift − waiting per machine) ÷ shift — every spool, event
   * and handling minute of the forecast is based on it. */
  scale: number;
  activities: ForecastActivityStep[];
  walking: {
    walkingSpeed: number;
    stops: number;
    firstPassMeters: number;
    cycleMeters: number;
    totalVisits: number;
    averageRounds: number;
    distanceMeters: number;
  };
}

/** Machines waiting because they need the one operator at the same time. */
export interface ForecastInterference {
  model: WaitingModel;
  machines: number;
  /** Per machine in the shift: running time, and operator time spent on it (handling + walking). */
  runningMinutesPerMachine: number;
  serviceMinutesPerMachine: number;
  /** Running ÷ service time per machine (Wright's X). */
  x: number;
  /** Wright only: 1 + X − N, the term the formula is built on. */
  wrightA?: number;
  /** Finite source only: r = 1 ÷ X, Σ N!/(N−n)! rⁿ, and P0 = 1 ÷ Σ (the operator idle). */
  serviceRatio?: number;
  termSum?: number;
  idleProbability?: number;
  /** Finite source only: chance the operator is busy at any moment (1 − P0). */
  operatorBusyProbability?: number;
  /** Finite source only: average machines down (L), and of those waiting in the queue (Lq). */
  averageDown?: number;
  averageQueue?: number;
  /** Waiting as a share of service time (Wright's I ÷ 100; finite source Lq ÷ (1 − P0)). */
  waitingPerServiceMinute: number;
  /** waitingPerServiceMinute × the operator's handling + walking. */
  minutes: number;
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
  breakdown: ForecastBreakdown;
  interference: ForecastInterference;
  /** Machines' total waiting for the operator: the larger of interference and backlog (the backlog
   * is the part of the same queue beyond what the operator can ever get to). */
  machineWaitingMinutes: number;
  /** machineWaitingMinutes as % of planned production time. */
  interferencePercent: number;
}

/** Wright's formula: interference I (% of service time) = 50 × (√((1 + X − N)² + 2N) − (1 + X − N)). */
function wrightWaitingPerServiceMinute(machines: number, x: number): number {
  const a = 1 + x - machines;
  return (50 * (Math.sqrt(a * a + 2 * machines) - a)) / 100;
}

/** Finite-source queue M/M/1//N with r = service ÷ running time: P0 = 1 ÷ Σ N!/(N−n)! rⁿ, busy = 1 − P0,
 * L = N − busy ÷ r, Lq = L − busy; each service minute comes with Lq ÷ busy minutes of waiting. */
function finiteSourceQueue(
  machines: number,
  x: number,
): { r: number; termSum: number; idle: number; busy: number; down: number; queue: number; waitingPerServiceMinute: number } {
  const r = 1 / x;
  // Σ N!/(N−n)! rⁿ in log space — the terms overflow for big N or r.
  const logTerms = [0];
  for (let k = 1; k <= machines; k += 1) logTerms.push(logTerms[k - 1] + Math.log(machines - k + 1) + Math.log(r));
  const maxLog = Math.max(...logTerms);
  const logSum = maxLog + Math.log(logTerms.reduce((total, term) => total + Math.exp(term - maxLog), 0));
  const idle = Math.exp(-logSum);
  const busy = 1 - idle;
  const down = Math.max(0, machines - busy * x);
  const queue = Math.max(0, down - busy);
  return { r, termSum: Math.exp(logSum), idle, busy, down, queue, waitingPerServiceMinute: busy > 0 ? queue / busy : 0 };
}

/** Machine interference for N machines, each running `runningMinutesPerMachine` and taking a share
 * of `serviceMinutes` (the operator's handling + walking) — exported so the fx calculation can also
 * show the model not chosen, from the same inputs. */
export function machineInterference(
  model: WaitingModel,
  machines: number,
  runningMinutesPerMachine: number,
  serviceMinutes: number,
): ForecastInterference {
  const serviceMinutesPerMachine = machines > 0 ? serviceMinutes / machines : 0;
  const base = { model, machines, runningMinutesPerMachine, serviceMinutesPerMachine, x: 0, waitingPerServiceMinute: 0, minutes: 0 };
  if (model === 'none' || machines <= 0 || serviceMinutesPerMachine <= 0 || runningMinutesPerMachine <= 0) return base;
  const x = runningMinutesPerMachine / serviceMinutesPerMachine;
  if (model === 'finiteSource') {
    const queue = finiteSourceQueue(machines, x);
    return {
      ...base,
      x,
      serviceRatio: queue.r,
      termSum: queue.termSum,
      idleProbability: queue.idle,
      operatorBusyProbability: queue.busy,
      averageDown: queue.down,
      averageQueue: queue.queue,
      waitingPerServiceMinute: queue.waitingPerServiceMinute,
      minutes: queue.waitingPerServiceMinute * serviceMinutes,
    };
  }
  const waitingPerServiceMinute = Math.max(0, wrightWaitingPerServiceMinute(machines, x));
  return { ...base, x, wrightA: 1 + x - machines, waitingPerServiceMinute, minutes: waitingPerServiceMinute * serviceMinutes };
}

function positiveFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function minutesPerSpool(activity: ActivityConfig, activities: ActivityConfig[], spoolsPerShift: number): number {
  const cycle = forecastCycleLength(activity, activities, spoolsPerShift);
  if (!Number.isFinite(cycle) || cycle <= 0) return 0;
  const eventRate = activity.key === 'diesChange'
    ? 1 / (cycle * AVERAGE_DIES_PER_CHANGE_EVENT)
    : 1 / cycle;
  return eventRate * Math.max(0, activity.timeMinutes);
}

/** Minutes per spool a machine is stopped for its Stop activities. RPC isn't included: the
 * allowance is the operator's own time and doesn't keep the machine stopped (same as the
 * production forecast's machineCapacityScale). */
function stopMinutesPerSpoolOf(activities: ActivityConfig[], spoolsPerShift: number): number {
  return activities.reduce(
    (total, activity) => total + (activity.machCondition === 'run' ? 0 : minutesPerSpool(activity, activities, spoolsPerShift)),
    0,
  );
}

/** Theoretical machine availability: runtime ÷ (runtime + stop minutes per spool). */
function forecastScale(activities: ActivityConfig[], runtimePerSpool: number, spoolsPerShift: number): number {
  const stopMinutesPerSpool = stopMinutesPerSpoolOf(activities, spoolsPerShift);
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

/** Waiting converges once an update moves it by less than this (minutes per machine). */
const WAITING_TOLERANCE_MINUTES = 0.001;
const MAX_WAITING_ITERATIONS = 100;

/**
 * Estimates the setup simulator's single operator using the same deterministic model as the
 * production utilization forecast. All assigned machines share one operator and global activities
 * are counted once across the line.
 *
 * Machines waiting for the operator make fewer spools, which leaves the operator less to do, which
 * shortens the waiting — so the waiting is solved for: the forecast is repeated with the waiting it
 * produced (damped, to settle rather than oscillate) until the two agree.
 */
export function calculateSingleOperatorForecast(config: AppConfig): SingleOperatorForecast {
  let waitingPerMachine = 0;
  let forecast = forecastWithWaiting(config, waitingPerMachine);
  for (let i = 0; i < MAX_WAITING_ITERATIONS && forecast.assignedMachineCount > 0; i += 1) {
    const produced = forecast.computedMachineWaitingMinutes / forecast.assignedMachineCount;
    if (Math.abs(produced - waitingPerMachine) < WAITING_TOLERANCE_MINUTES) break;
    waitingPerMachine = (waitingPerMachine + produced) / 2;
    forecast = forecastWithWaiting(config, waitingPerMachine);
  }
  const { computedMachineWaitingMinutes: _computed, ...result } = forecast;
  void _computed;
  return result;
}

/** One pass of the forecast with each machine waiting this long for the operator. */
function forecastWithWaiting(
  config: AppConfig,
  waitingPerMachine: number,
): SingleOperatorForecast & { computedMachineWaitingMinutes: number } {
  const availableMinutes = availableTimeMinutes(
    config.operator.shiftTime,
    config.operator.lunchTime,
    config.operator.meetingTime,
    extraBreakMinutes(config.operator.extraBreaks),
  );
  const handled = Math.max(0, Math.floor(config.operator.machHandled));
  // Use the explicit assignment first, then fill the requested count from the remaining layout
  // machines. This keeps the forecast responsive while the user is changing the count before
  // completing the Assign action in the Machine Layout step.
  const layoutById = new Map(config.layout.map((machine) => [machine.id, machine]));
  const assignedPreviewIds = previewAssignedMachineIds(config, handled);
  const layoutMachines = assignedPreviewIds
    .map((id) => layoutById.get(id))
    .filter((machine): machine is NonNullable<typeof machine> => !!machine);
  // The count is independent of the layout: machines the layout doesn't have (yet) still count,
  // placed on a stand-in paired grid right of the layout so walking can be estimated. The Machine
  // Layout step is where the layout has to match the count before the simulation can start.
  const assignedMachines = [...layoutMachines, ...placeholderMachines(config, handled - layoutMachines.length)];
  const derived = deriveMachineSpec(config.spec);
  const runtimePerSpool = positiveFinite(derived.runtimePerSpool);
  const expectedSpools = runtimePerSpool > 0 ? config.operator.shiftTime / runtimePerSpool : 0;
  const stopAvailability = forecastScale(config.activities, runtimePerSpool, expectedSpools);
  const shiftMinutes = Math.max(0, config.operator.shiftTime);
  const runningShare = shiftMinutes > 0 ? Math.max(0, shiftMinutes - waitingPerMachine) / shiftMinutes : 0;
  const scale = stopAvailability * runningShare;
  const availableMachines = assignedMachines.length;

  let plannedMinutes = 0;
  let forecastServiceMinutes = 0;
  const visitsByMachine = new Map<string, number>();
  const steps = new Map<string, ForecastActivityStep>();
  const addStep = (
    activity: ActivityConfig,
    scope: ForecastActivityStep['scope'],
    cycle: number,
    events: number,
    quantity: number | undefined,
    timeWithRpcMinutes: number,
    minutes: number,
  ) => {
    const step = steps.get(activity.key) ?? {
      key: activity.key,
      label: activity.label,
      scope,
      stopsMachine: activity.machCondition !== 'run',
      cycle,
      events: 0,
      ...(quantity !== undefined ? { quantity: 0 } : {}),
      timeMinutes: Math.max(0, activity.timeMinutes),
      timeWithRpcMinutes,
      plannedMinutes: 0,
      forecastMinutes: 0,
    };
    step.events += events;
    if (quantity !== undefined) step.quantity = (step.quantity ?? 0) + quantity;
    step.plannedMinutes += minutes;
    step.forecastMinutes += minutes * scale;
    steps.set(activity.key, step);
  };
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
  /** RPC allowance time, kept out of each activity's own contribution (handling and downtime
   * alike) and rolled into one "Others (RPC)" row instead — same split the actual simulation shows
   * in its Man Occupation card (see outputModel.ts's sumRpcMinutes/"others" bucket). Never counted
   * as downtime here: this forecast doesn't model task ordering, so it can't tell (like the actual
   * engine does) whether a given RPC stretch really kept a machine stopped. */
  const addRpcMinutes = (handlingMinutes: number) => {
    if (handlingMinutes <= 1e-9) return;
    const existing = activityContributions.get('rpc') ?? {
      key: 'rpc',
      label: 'Others (RPC)',
      handlingMinutes: 0,
      downtimeMinutes: 0,
    };
    existing.handlingMinutes += handlingMinutes;
    activityContributions.set('rpc', existing);
  };

  assignedMachines.forEach((machine) => {
    let machinePlannedMinutes = 0;
    let machineVisits = 0;
    config.activities.forEach((activity) => {
      if (GLOBAL_EVENT_ACTIVITIES.has(activity.key)) return;
      const cycle = forecastCycleLength(activity, config.activities, expectedSpools);
      if (!Number.isFinite(cycle) || cycle <= 0 || expectedSpools <= 0) return;
      const occurrences = expectedSpools / cycle;
      const quantityBased = activity.key === 'diesChange';
      const quantity = quantityBased ? occurrences : 0;
      const eventCount = quantityBased ? quantity / AVERAGE_DIES_PER_CHANGE_EVENT : occurrences;
      const baseTimeMinutes = Math.max(0, activity.timeMinutes);
      const timeMinutes = applyRpc(baseTimeMinutes, config.rpcPercent);
      const baseMinutesTotal = quantityBased ? quantity * baseTimeMinutes : eventCount * baseTimeMinutes;
      const minutes = quantityBased ? quantity * timeMinutes : eventCount * timeMinutes;
      machinePlannedMinutes += minutes;
      machineVisits = Math.max(machineVisits, eventCount);
      addStep(activity, 'machine', cycle, eventCount, quantityBased ? quantity : undefined, timeMinutes, minutes);
      addActivityContribution(activity, baseMinutesTotal * scale);
      addRpcMinutes((minutes - baseMinutesTotal) * scale);
    });
    plannedMinutes += machinePlannedMinutes;
    forecastServiceMinutes += machinePlannedMinutes * scale;
    visitsByMachine.set(machine.id, machineVisits * scale);
  });

  if (availableMachines > 0 && expectedSpools > 0) {
    const totalExpectedSpools = expectedSpools * availableMachines;
    config.activities.forEach((activity) => {
      if (!GLOBAL_EVENT_ACTIVITIES.has(activity.key)) return;
      const cycle = forecastCycleLength(activity, config.activities, expectedSpools);
      if (!Number.isFinite(cycle) || cycle <= 0) return;
      const quantityBased = activity.key === 'diesChange';
      const totalQuantity = quantityBased ? totalExpectedSpools / cycle : 0;
      const totalEvents = quantityBased
        ? totalQuantity / AVERAGE_DIES_PER_CHANGE_EVENT
        : totalExpectedSpools / cycle;
      const baseTimeMinutes = Math.max(0, activity.timeMinutes);
      const timeMinutes = applyRpc(baseTimeMinutes, config.rpcPercent);
      const baseTotal = quantityBased ? totalQuantity * baseTimeMinutes : totalEvents * baseTimeMinutes;
      const minutes = quantityBased ? totalQuantity * timeMinutes : totalEvents * timeMinutes;
      plannedMinutes += minutes;
      forecastServiceMinutes += minutes * scale;
      addStep(activity, 'line', cycle, totalEvents, quantityBased ? totalQuantity : undefined, timeMinutes, minutes);
      addActivityContribution(activity, baseTotal * scale);
      addRpcMinutes((minutes - baseTotal) * scale);
      assignedMachines.forEach((machine) => {
        const machineEvents = totalEvents / availableMachines;
        visitsByMachine.set(machine.id, Math.max(visitsByMachine.get(machine.id) ?? 0, machineEvents * scale));
      });
    });
  }

  let forecastWalkingMinutes = 0;
  const walking: ForecastBreakdown['walking'] = {
    walkingSpeed: 0,
    stops: 0,
    firstPassMeters: 0,
    cycleMeters: 0,
    totalVisits: 0,
    averageRounds: 0,
    distanceMeters: 0,
  };
  const walkingSpeed = positiveFinite(config.movement.walkingSpeed);
  walking.walkingSpeed = walkingSpeed;
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
      Object.assign(walking, {
        stops: route.length,
        firstPassMeters: firstPassDistance,
        cycleMeters: cycleDistance,
        totalVisits,
        averageRounds: totalVisits / route.length,
        distanceMeters: firstPassDistance + Math.max(0, totalVisits / route.length - 1) * cycleDistance,
      });
    }
  }

  const forecastBusyMinutes = forecastServiceMinutes + forecastWalkingMinutes;
  const backlogMinutes = Math.max(0, forecastBusyMinutes - availableMinutes);
  const interference = machineInterference(
    config.operator.waitingModel ?? DEFAULT_WAITING_MODEL,
    availableMachines,
    Math.max(0, config.operator.shiftTime) * scale,
    forecastBusyMinutes,
  );
  const plannedMachineMinutes = availableMachines * shiftMinutes;
  const computedMachineWaitingMinutes = Math.min(plannedMachineMinutes, Math.max(backlogMinutes, interference.minutes));
  // What this pass assumed — the spools, OEE and downtime all add up against it.
  const machineWaitingMinutes = Math.min(plannedMachineMinutes, waitingPerMachine * availableMachines);
  return {
    availableMinutes,
    plannedMinutes,
    forecastServiceMinutes,
    forecastWalkingMinutes,
    forecastWaitingMinutes: backlogMinutes,
    utilizationPercent: availableMinutes > 0 ? (plannedMinutes / availableMinutes) * 100 : 0,
    forecastUtilizationPercent: availableMinutes > 0
      ? Math.min(100, (forecastBusyMinutes / availableMinutes) * 100)
      : 0,
    assignedMachineCount: availableMachines,
    expectedFinishedSpools: expectedSpools * availableMachines * scale,
    activityContributions: [...activityContributions.values()],
    breakdown: {
      shiftMinutes: config.operator.shiftTime,
      lunchMinutes: config.operator.lunchTime,
      meetingMinutes: config.operator.meetingTime,
      otherBreakMinutes: extraBreakMinutes(config.operator.extraBreaks),
      rpcPercent: config.rpcPercent ?? 0,
      runtimePerSpool,
      expectedSpoolsPerMachine: expectedSpools,
      layoutMachineCount: layoutMachines.length,
      placeholderMachineCount: assignedMachines.length - layoutMachines.length,
      stopMinutesPerSpool: stopMinutesPerSpoolOf(config.activities, expectedSpools),
      stopAvailability,
      waitingPerMachineMinutes: availableMachines > 0 ? machineWaitingMinutes / availableMachines : 0,
      scale,
      activities: [...steps.values()],
      walking,
    },
    interference,
    machineWaitingMinutes,
    interferencePercent: plannedMachineMinutes > 0 ? (machineWaitingMinutes / plannedMachineMinutes) * 100 : 0,
    computedMachineWaitingMinutes,
  };
}

/** Machine-side result of a forecast — what Output Estimate's Output and OEE cards show. Machines
 * stop for Stop activities and wait for the operator; the forecast's spools already leave both out. */
export interface ForecastDowntime {
  plannedMachineMinutes: number;
  /** Stop-activity downtime per activity (handling time, without RPC), largest first. */
  activityDowntime: { key: string; label: string; minutes: number }[];
  waitingMinutes: number;
  totalDowntimeMinutes: number;
  availabilityPercent: number;
  producedMachineMinutes: number;
  estimatedSpools: number;
}

export function calculateForecastDowntime(config: AppConfig, forecast: SingleOperatorForecast): ForecastDowntime {
  const runtimePerSpool = deriveMachineSpec(config.spec).runtimePerSpool;
  const plannedMachineMinutes = forecast.assignedMachineCount * Math.max(0, config.operator.shiftTime);
  const waitingMinutes = Math.min(plannedMachineMinutes, forecast.machineWaitingMinutes);
  const producedMachineMinutes = Math.max(0, forecast.expectedFinishedSpools * runtimePerSpool);
  const activityDowntime = forecast.activityContributions
    .filter((contribution) => contribution.downtimeMinutes > 0)
    .map((contribution) => ({ key: contribution.key, label: contribution.label, minutes: contribution.downtimeMinutes }));
  const totalDowntimeMinutes = Math.min(
    plannedMachineMinutes,
    activityDowntime.reduce((total, row) => total + row.minutes, 0) + waitingMinutes,
  );
  return {
    plannedMachineMinutes,
    activityDowntime,
    waitingMinutes,
    totalDowntimeMinutes,
    availabilityPercent: plannedMachineMinutes > 0
      ? Math.max(0, ((plannedMachineMinutes - totalDowntimeMinutes) / plannedMachineMinutes) * 100)
      : 100,
    producedMachineMinutes,
    estimatedSpools: runtimePerSpool > 0 ? producedMachineMinutes / runtimePerSpool : 0,
  };
}

/** Everything Output Estimate shows for a forecast, in the same terms as the simulation's result
 * cards — so the two can be compared line by line. */
export interface ForecastOutputSummary {
  downtime: ForecastDowntime;
  spools: number;
  tonage: number;
  /** Produced machine time ÷ planned production (the Output cards' OEE). */
  outputOeePercent: number;
  manHourPerTon: number;
  machHoursPerTon: number;
  fracturePerTon: number;
  diesPerTon: number;
  defectPerTon: number;
  idleMinutes: number;
}

export function forecastOutputSummary(config: AppConfig, forecast: SingleOperatorForecast): ForecastOutputSummary {
  const derived = deriveMachineSpec(config.spec);
  const downtime = calculateForecastDowntime(config, forecast);
  const spools = downtime.estimatedSpools;
  const tonage = (spools * derived.spoolWeight) / 1000;
  const shiftHours = Math.max(0, config.operator.shiftTime) / 60;
  const ratePerTon = (key: string) => {
    const quantity = config.activities
      .filter((activity) => activity.key === key)
      .reduce((total, activity) => {
        const cycle = activityCycleLength(activity);
        return total + (Number.isFinite(cycle) && cycle > 0 ? spools / cycle : 0);
      }, 0);
    return tonage > 0 ? quantity / tonage : 0;
  };
  return {
    downtime,
    spools,
    tonage,
    outputOeePercent: downtime.plannedMachineMinutes > 0 ? (downtime.producedMachineMinutes / downtime.plannedMachineMinutes) * 100 : 0,
    manHourPerTon: tonage > 0 ? shiftHours / tonage : 0,
    machHoursPerTon: tonage > 0 ? (forecast.assignedMachineCount * shiftHours) / tonage : 0,
    fracturePerTon: ratePerTon('fractureRepairing'),
    diesPerTon: ratePerTon('diesChange'),
    defectPerTon: ratePerTon('defectRepairing'),
    idleMinutes: Math.max(0, forecast.availableMinutes - forecast.forecastServiceMinutes - forecast.forecastWalkingMinutes),
  };
}

/** Stand-in machines for the part of the count the layout can't supply: a paired grid (default
 * machine size) starting just right of the layout, so their walking distances stay realistic. */
function placeholderMachines(config: AppConfig, count: number): LayoutMachine[] {
  if (count <= 0) return [];
  const pixelsPerMeter = config.movement.pixelsPerMeter || 20;
  const layoutRight = config.layout.reduce((max, m) => Math.max(max, m.x + machineWidthPx(m, pixelsPerMeter)), -Infinity);
  const startX = Number.isFinite(layoutRight) ? layoutRight + PAIR_GAP : 40;
  const startY = config.layout.length > 0 ? Math.min(...config.layout.map((m) => m.y)) : 40;
  const cols = Math.min(PLACEHOLDER_GRID_COLS, count);
  return generatePairedGrid(Math.ceil(count / cols), cols, startX, startY)
    .slice(0, count)
    .map((machine) => ({ ...machine, id: `placeholder-${machine.id}` }));
}

/** Finds the largest machine count the operator can still keep up with — Forecast Man Occupation
 * up to 100%, no backlog — not limited to the machines in the layout (the Machine Layout step
 * enforces that the layout matches the count). Machine interference doesn't limit it: it's still
 * forecast, lowering OEE and #Spool. */
export function recommendedMachineCountForForecast(config: AppConfig): number {
  let recommended = 0;
  let backlogStreak = 0;
  for (let machineCount = 1; machineCount <= MAX_RECOMMENDED_MACHINES; machineCount += 1) {
    const forecast = calculateSingleOperatorForecast({
      ...config,
      operator: { ...config.operator, machHandled: machineCount },
    });
    // No handling work at all (spec/activities not filled in yet) would never produce a backlog.
    if (machineCount === 1 && forecast.plannedMinutes <= 0) return 0;
    if (forecast.forecastWaitingMinutes <= 0.0001) {
      recommended = machineCount;
      backlogStreak = 0;
    } else if (++backlogStreak >= OPTIMIZE_BACKLOG_STREAK) {
      break;
    }
  }

  return recommended;
}
