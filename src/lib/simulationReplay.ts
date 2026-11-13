import type {
  ActivityKey,
  DowntimeReason,
  MachineStatus,
  PendingTask,
  ProductionMachineRuntimeState,
  ProductionOperatorRuntimeState,
  ProductionSimMetrics,
  ProductionSimulationState,
  OperatorKeyframe,
  OperatorKeyframeItem,
} from '../types';
import { Mpp_wl_productionsetupsesService } from '../generated/services/Mpp_wl_productionsetupsesService';

export interface SimulationReplayRecord {
  setupId: string;
  setupName: string;
  savedAt: number;
  shiftTimeMin: number;
  source: 'local' | 'cloud';
  state: ProductionSimulationState;
  keyframes: OperatorKeyframe[];
}

const DB_NAME = 'WL_SimulationReplayDB';
const DB_VERSION = 1;
const STORE_NAME = 'replays';

function openReplayDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported in this environment'));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'setupId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Saves the simulation replay record into local browser IndexedDB. */
export async function saveLocalReplay(record: SimulationReplayRecord): Promise<void> {
  try {
    const db = await openReplayDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put({ ...record, source: 'local' });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('Failed to save local simulation replay to IndexedDB:', err);
  }
}

/** Loads the simulation replay record for a setup from local IndexedDB. */
export async function loadLocalReplay(setupId: string): Promise<SimulationReplayRecord | null> {
  try {
    const db = await openReplayDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(setupId);
      req.onsuccess = () => resolve((req.result as SimulationReplayRecord) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Deletes a saved local simulation replay from IndexedDB. */
export async function deleteLocalReplay(setupId: string): Promise<void> {
  try {
    const db = await openReplayDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(setupId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore error
  }
}

/** Compresses a SimulationReplayRecord into a GZIP blob using the standard CompressionStream Web API. */
export async function compressReplay(record: SimulationReplayRecord): Promise<Blob> {
  const jsonStr = JSON.stringify(record);
  const stream = new Blob([jsonStr]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(stream).blob();
}

/** Decompresses a GZIP-compressed binary stream back into a SimulationReplayRecord using DecompressionStream. */
export async function decompressReplay(data: Uint8Array | ArrayBuffer | Blob): Promise<SimulationReplayRecord> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return JSON.parse(text) as SimulationReplayRecord;
}

/** Uploads the simulation replay to Dataverse as a compressed File attachment. */
export async function uploadReplayToCloud(setupId: string, record: SimulationReplayRecord): Promise<void> {
  const compressedBlob = await compressReplay({ ...record, source: 'cloud' });
  const file = new File([compressedBlob], `replay-${setupId}.json.gz`, { type: 'application/gzip' });
  const result = await Mpp_wl_productionsetupsesService.upload(setupId, 'mpp_simulationresult', file);
  if (!result.success) {
    throw new Error(result.error?.message ?? 'Failed to upload simulation replay to Dataverse.');
  }
}

/** Downloads and decompresses the simulation replay from Dataverse. */
export async function downloadReplayFromCloud(setupId: string): Promise<SimulationReplayRecord | null> {
  const result = await Mpp_wl_productionsetupsesService.downloadFile(setupId, 'mpp_simulationresult');
  if (!result.success || !result.data || result.data.length === 0) {
    return null;
  }
  const record = await decompressReplay(result.data);
  record.source = 'cloud';
  return record;
}

/** Finds or interpolates operator positions at the exact given minute. */
function interpolateOperatorsAtMinute(
  keyframes: OperatorKeyframe[],
  fallbackOperators: ProductionOperatorRuntimeState[],
  minute: number,
  machineCoordsById?: Map<string, { x: number; y: number }>,
): ProductionOperatorRuntimeState[] {
  if (!keyframes || keyframes.length === 0) {
    return fallbackOperators;
  }

  // Exact or boundary match
  if (minute <= keyframes[0].t) {
    return mergeKeyframeOps(fallbackOperators, keyframes[0].ops, minute, machineCoordsById);
  }
  const lastKf = keyframes[keyframes.length - 1];
  if (minute >= lastKf.t) {
    return mergeKeyframeOps(fallbackOperators, lastKf.ops, minute, machineCoordsById);
  }

  // Binary search for bracket: kf1.t <= minute <= kf2.t
  let low = 0;
  let high = keyframes.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (keyframes[mid].t <= minute) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const idx1 = Math.max(0, high);
  const idx2 = Math.min(keyframes.length - 1, idx1 + 1);
  const kf1 = keyframes[idx1];
  const kf2 = keyframes[idx2];

  const span = kf2.t - kf1.t;
  const alpha = span > 1e-6 ? Math.max(0, Math.min(1, (minute - kf1.t) / span)) : 0;

  const opsMap2 = new Map(kf2.ops.map((o) => [o.id, o]));
  const interpolatedOps: OperatorKeyframeItem[] = kf1.ops.map((op1) => {
    const op2 = opsMap2.get(op1.id) ?? op1;
    const phase = alpha >= 0.5 ? op2.phase : op1.phase;
    const plannedRoute = op1.plannedRoute ?? op2.plannedRoute;
    return {
      id: op1.id,
      x: Math.round((op1.x + (op2.x - op1.x) * alpha) * 10) / 10,
      y: Math.round((op1.y + (op2.y - op1.y) * alpha) * 10) / 10,
      phase,
      targetMachineId: alpha >= 0.5 ? op2.targetMachineId : op1.targetMachineId,
      targetMachineLabel: alpha >= 0.5 ? op2.targetMachineLabel : op1.targetMachineLabel,
      currentZoneLabel: alpha >= 0.5 ? op2.currentZoneLabel : op1.currentZoneLabel,
      breakLabel: alpha >= 0.5 ? op2.breakLabel : op1.breakLabel,
      breakRemainingMin: Math.max(0, op1.breakRemainingMin - alpha * span),
      plannedRoute,
    };
  });

  return mergeKeyframeOps(fallbackOperators, interpolatedOps, minute, machineCoordsById);
}

function mergeKeyframeOps(
  baseOperators: ProductionOperatorRuntimeState[],
  keyframeOps: OperatorKeyframeItem[],
  minute?: number,
  machineCoordsById?: Map<string, { x: number; y: number }>,
): ProductionOperatorRuntimeState[] {
  const kfMap = new Map(keyframeOps.map((o) => [o.id, o]));
  return baseOperators.map((base) => {
    const kf = kfMap.get(base.id);
    const clampedTimeline = minute != null
      ? base.timeline
          .filter((seg) => seg.startMin < minute)
          .map((seg) => ({ ...seg, endMin: Math.min(minute, seg.endMin) }))
      : base.timeline;

    if (!kf) return { ...base, timeline: clampedTimeline };

    // Determine route: use keyframe route or fallback line to target machine if walking
    let route = kf.plannedRoute;
    if ((!route || route.length < 2) && kf.phase === 'walking' && kf.targetMachineId && machineCoordsById) {
      const targetM = machineCoordsById.get(kf.targetMachineId);
      if (targetM) {
        route = [{ x: kf.x, y: kf.y }, { x: targetM.x, y: targetM.y }];
      }
    }

    return {
      ...base,
      x: kf.x,
      y: kf.y,
      phase: kf.phase,
      targetMachineId: kf.targetMachineId,
      targetMachineLabel: kf.targetMachineLabel,
      currentZoneLabel: kf.currentZoneLabel,
      breakLabel: kf.breakLabel,
      breakRemainingMin: kf.breakRemainingMin,
      plannedRoute: route ?? [],
      timeline: clampedTimeline,
    };
  });
}

/** Reconstructs a full ProductionSimulationState snapshot at any target minute from a recorded replay. */
export function interpolateReplaySnapshot(
  replay: SimulationReplayRecord,
  targetMinute: number,
): ProductionSimulationState {
  const minute = Math.max(0, Math.min(replay.shiftTimeMin, targetMinute));
  const fullState = replay.state;

  const allKeyframes = replay.keyframes && replay.keyframes.length > 0
    ? replay.keyframes
    : (fullState.keyframes ?? []);

  // Find nearest keyframe at or before minute for exact metrics snapshot
  let nearestKf: OperatorKeyframe | undefined;
  for (let i = allKeyframes.length - 1; i >= 0; i--) {
    if (allKeyframes[i].t <= minute + 1e-4) {
      nearestKf = allKeyframes[i];
      break;
    }
  }
  if (!nearestKf && allKeyframes.length > 0) {
    nearestKf = allKeyframes[0];
  }

  const machineCoordsById = new Map(fullState.machines.map((m) => [m.id, { x: m.x, y: m.y }]));

  // 1. Interpolate operators
  const activeOperators = interpolateOperatorsAtMinute(
    allKeyframes,
    fullState.operators,
    minute,
    machineCoordsById,
  );

  const servicingMachineIds = new Set(
    activeOperators
      .filter((op) => op.phase === 'servicing' && op.targetMachineId)
      .map((op) => op.targetMachineId!),
  );

  // 2. Reconstruct machines
  let totalProducedMinutes = 0;
  let totalTonnageKg = 0;
  const fallbackCompletedByActivity: Record<ActivityKey, number> = {};
  const fallbackDowntimeByReason: Record<DowntimeReason, number> = { waiting: 0 };

  const activeMachines: ProductionMachineRuntimeState[] = fullState.machines.map((m) => {
    // Find active segment at `minute`
    const activeSeg = m.timeline.find((seg) => seg.startMin <= minute && seg.endMin > minute)
      ?? (m.timeline.length > 0 ? m.timeline[m.timeline.length - 1] : undefined);

    let status: MachineStatus = 'unassigned';
    let runtimePaused = false;
    let runtimeRemainingMin: number | null = null;
    let nextCompletionAt = Number.POSITIVE_INFINITY;
    let pendingTasks: PendingTask[] = [];
    const runtime = m.runtimePerSpool > 0 ? m.runtimePerSpool : 0;

    if (activeSeg) {
      const isRunning = activeSeg.kind === 'running' || activeSeg.kind.startsWith('running:');
      if (isRunning) {
        status = 'running';
        runtimePaused = false;
        runtimeRemainingMin = null;
        pendingTasks = []; // Running machines have NO pending stop tasks (PO will not be red)

        // Spool progress: find next doffing segment to calculate exact remaining spool time
        const nextDoff = m.timeline.find(
          (seg) => seg.startMin >= minute && (seg.kind === 'doffing' || seg.kind === 'waiting:doffing'),
        );
        if (nextDoff) {
          let runRem = 0;
          for (const s of m.timeline) {
            if (s.startMin >= nextDoff.startMin) break;
            if (s.endMin <= minute) continue;
            if (s.kind === 'running' || s.kind.startsWith('running:')) {
              const sStart = Math.max(minute, s.startMin);
              const sEnd = Math.min(nextDoff.startMin, s.endMin);
              if (sEnd > sStart) runRem += sEnd - sStart;
            }
          }
          nextCompletionAt = minute + runRem;
        } else {
          // If no later doffing, count running time since last completed doffing
          const lastDoff = [...m.timeline]
            .reverse()
            .find((seg) => seg.endMin <= minute && (seg.kind === 'doffing' || seg.kind === 'waiting:doffing'));
          const lastDoffEnd = lastDoff ? lastDoff.endMin : 0;
          let runSince = 0;
          for (const s of m.timeline) {
            if (s.startMin >= minute) break;
            if (s.endMin <= lastDoffEnd) continue;
            if (s.kind === 'running' || s.kind.startsWith('running:')) {
              const sStart = Math.max(lastDoffEnd, s.startMin);
              const sEnd = Math.min(minute, s.endMin);
              if (sEnd > sStart) runSince += sEnd - sStart;
            }
          }
          const remOnSpool = runtime > 0 ? Math.max(0, runtime - (runSince % runtime)) : 0;
          nextCompletionAt = minute + remOnSpool;
        }
      } else if (activeSeg.kind === 'idle') {
        status = 'unassigned';
        runtimePaused = false;
        runtimeRemainingMin = null;
        pendingTasks = [];
      } else {
        // Machine is stopped (either waiting for operator or being serviced)
        const isWaiting = activeSeg.kind === 'waiting' || activeSeg.kind.startsWith('waiting:');
        const isBeingServiced = servicingMachineIds.has(m.id) || (!isWaiting && activeSeg.kind !== 'idle');
        status = isBeingServiced ? 'being-serviced' : 'needs-service';
        runtimePaused = true;

        // Find the downtime stop boundaries around activeSeg
        let stopStartMin = 0;
        let stopEndMin = replay.shiftTimeMin;
        for (const seg of m.timeline) {
          const isRun = seg.kind === 'running' || seg.kind.startsWith('running:');
          if (isRun && seg.endMin <= activeSeg.startMin) {
            stopStartMin = Math.max(stopStartMin, seg.endMin);
          }
          if (isRun && seg.startMin >= activeSeg.endMin) {
            stopEndMin = Math.min(stopEndMin, seg.startMin);
            break;
          }
        }

        // Collect all distinct activities occurring in this contiguous downtime stop.
        // A stop can require multiple activities (e.g. Doffing on TU and Loading on PO).
        // Any activity whose servicing has not completed before `minute` is still pending/active.
        const stopTasksMap = new Map<ActivityKey, string>();
        let hasDoffingInStop = false;
        let doffingEndMin = 0;

        for (const seg of m.timeline) {
          if (seg.startMin >= stopEndMin || seg.endMin <= stopStartMin) continue;
          const isRun = seg.kind === 'running' || seg.kind.startsWith('running:') || seg.kind === 'idle';
          if (isRun) continue;

          const actKey = seg.kind.replace(/^waiting:/, '').replace(/^rpc:/, '') as ActivityKey;
          const actLabel = seg.label.replace(/^Waiting for\s*/i, '') || actKey;

          if (actKey === 'doffing' || actKey.startsWith('doffing')) {
            hasDoffingInStop = true;
            doffingEndMin = Math.max(doffingEndMin, seg.endMin);
          }

          if (seg.endMin > minute && !stopTasksMap.has(actKey)) {
            stopTasksMap.set(actKey, actLabel);
          }
        }

        pendingTasks = Array.from(stopTasksMap.entries()).map(([activity, label]) => ({
          activity,
          label,
          timeMinutes: 0,
        }));

        // Spool progress regulation:
        // If doffing was scheduled for this stop and has not completed before `minute`,
        // the spool is 100% full (full spool donut).
        // Once doffing completes, the new spool is mounted (0% progress) while subsequent tasks (like loading) proceed.
        if (hasDoffingInStop) {
          if (minute <= doffingEndMin) {
            runtimeRemainingMin = null;
            nextCompletionAt = minute;
          } else {
            runtimeRemainingMin = runtime;
            nextCompletionAt = minute + runtime;
          }
        } else {
          // Mid-spool interrupt (fracture or mid-runtime loading): compute running time on this spool
          const lastDoff = [...m.timeline]
            .reverse()
            .find((seg) => seg.endMin <= stopStartMin && (seg.kind === 'doffing' || seg.kind === 'waiting:doffing'));
          const lastDoffEnd = lastDoff ? lastDoff.endMin : 0;
          let runSince = 0;
          for (const s of m.timeline) {
            if (s.startMin >= stopStartMin) break;
            if (s.endMin <= lastDoffEnd) continue;
            if (s.kind === 'running' || s.kind.startsWith('running:')) {
              const sStart = Math.max(lastDoffEnd, s.startMin);
              const sEnd = Math.min(stopStartMin, s.endMin);
              if (sEnd > sStart) runSince += sEnd - sStart;
            }
          }
          runtimeRemainingMin = runtime > 0 ? Math.max(0, runtime - (runSince % runtime)) : null;
          nextCompletionAt = minute + (runtimeRemainingMin ?? 0);
        }
      }
    } else {
      status = m.status;
      pendingTasks = [];
    }

    // Cumulative running & downtime up to `minute`
    let runningMinutes = 0;
    let downtimeMin = 0;
    const machineDowntimeByReason: Record<DowntimeReason, number> = { waiting: 0 };

    m.timeline.forEach((seg) => {
      if (seg.startMin >= minute) return;
      const effectiveEnd = Math.min(minute, seg.endMin);
      const dur = Math.max(0, effectiveEnd - seg.startMin);

      const isRunning = seg.kind === 'running' || seg.kind.startsWith('running:');
      if (isRunning) {
        runningMinutes += dur;
      } else if (seg.kind !== 'idle') {
        downtimeMin += dur;
        const reason: DowntimeReason = (seg.kind === 'waiting' || seg.kind.startsWith('waiting:'))
          ? 'waiting'
          : (seg.kind.replace(/^rpc:/, '') as DowntimeReason);
        machineDowntimeByReason[reason] = (machineDowntimeByReason[reason] ?? 0) + dur;
        fallbackDowntimeByReason[reason] = (fallbackDowntimeByReason[reason] ?? 0) + dur;
      }
    });

    const runtimePerSpool = m.runtimePerSpool > 0 ? m.runtimePerSpool : 0;
    const spoolsCompleted = runtimePerSpool > 0 ? runningMinutes / runtimePerSpool : 0;
    const machineTonageKg = spoolsCompleted * Math.max(0, m.spoolWeight);

    totalProducedMinutes += runningMinutes;
    totalTonnageKg += machineTonageKg;

    // Clamped timeline
    const clampedTimeline = m.timeline
      .filter((seg) => seg.startMin < minute)
      .map((seg) => ({ ...seg, endMin: Math.min(minute, seg.endMin) }));

    return {
      ...m,
      status,
      runtimePaused,
      runtimeRemainingMin,
      nextCompletionAt,
      pendingTasks,
      spoolsCompleted,
      shiftSpoolsCompleted: Math.floor(spoolsCompleted),
      downtimeMin,
      downtimeByReason: machineDowntimeByReason,
      timeline: clampedTimeline,
    };
  });

  // Ensure servicing operators have the task matching what they are actively servicing
  const machineMap = new Map(activeMachines.map((mach) => [mach.id, mach]));
  activeOperators.forEach((op) => {
    if (op.phase === 'servicing' && op.targetMachineId) {
      const targetM = machineMap.get(op.targetMachineId);
      const opSeg = op.timeline.find((s) => s.startMin <= minute && s.endMin > minute);
      if (opSeg && opSeg.kind !== 'walking' && opSeg.kind !== 'idle' && opSeg.kind !== 'lunch' && opSeg.kind !== 'meeting' && opSeg.kind !== 'otherBreak') {
        const actKey = opSeg.kind.replace(/^rpc:/, '') as ActivityKey;
        const actLabel = opSeg.label || actKey;
        op.serviceTasks = [{ activity: actKey, label: actLabel, timeMinutes: 0 }];
      } else if (targetM && targetM.pendingTasks.length > 0) {
        op.serviceTasks = [...targetM.pendingTasks];
      }
    } else if (op.phase !== 'servicing') {
      op.serviceTasks = [];
    }
  });

  // 3. Per operator metrics up to minute
  const perOperator = activeOperators.map((op) => {
    let walkingMin = 0;
    let servicingMin = 0;
    let idleMin = 0;

    op.timeline.forEach((seg) => {
      const dur = Math.max(0, seg.endMin - seg.startMin);
      if (seg.kind === 'walking') walkingMin += dur;
      else if (seg.kind === 'idle') idleMin += dur;
      else if (seg.kind !== 'lunch' && seg.kind !== 'meeting' && seg.kind !== 'otherBreak') {
        servicingMin += dur;
      }
    });

    return {
      id: op.id,
      label: op.label,
      walkingMin,
      servicingMin,
      idleMin,
    };
  });

  if (!nearestKf?.metrics) {
    fullState.operators.forEach((op) => {
      op.timeline.forEach((seg) => {
        if (seg.endMin <= minute && seg.kind !== 'walking' && seg.kind !== 'idle' && seg.kind !== 'lunch' && seg.kind !== 'meeting' && seg.kind !== 'otherBreak') {
          const act = seg.kind.replace(/^rpc:/, '') as ActivityKey;
          fallbackCompletedByActivity[act] = (fallbackCompletedByActivity[act] ?? 0) + 1;
        }
      });
    });
  }

  const completedByActivity = nearestKf?.metrics?.completedByActivity
    ? { ...nearestKf.metrics.completedByActivity }
    : fallbackCompletedByActivity;

  const downtimeByReason = nearestKf?.metrics?.downtimeByReason
    ? { ...nearestKf.metrics.downtimeByReason }
    : fallbackDowntimeByReason;

  const tonageKg = nearestKf?.metrics?.tonageKg ?? totalTonnageKg;
  const tonageKgByConstruction = nearestKf?.metrics?.tonageKgByConstruction
    ? { ...nearestKf.metrics.tonageKgByConstruction }
    : fullState.metrics.tonageKgByConstruction;
  const diesChanged = nearestKf?.metrics?.diesChanged ?? fullState.metrics.diesChanged;
  const producedMachineMin = nearestKf?.metrics?.producedMachineMin ?? totalProducedMinutes;

  const metrics: ProductionSimMetrics = {
    ...fullState.metrics,
    clockMin: minute,
    shiftTimeMin: replay.shiftTimeMin,
    producedMachineMin,
    tonageKg,
    tonageKgByConstruction,
    diesChanged,
    downtimeByReason,
    completedByActivity,
    perOperator,
  };

  return {
    machines: activeMachines,
    operators: activeOperators,
    metrics,
    log: fullState.log.filter((entry) => entry.timeMin <= minute),
    finished: minute >= replay.shiftTimeMin,
    warnings: fullState.warnings,
    keyframes: replay.keyframes,
  };
}
