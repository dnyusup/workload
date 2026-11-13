import type {
  ActivityKey,
  DowntimeReason,
  MachineStatus,
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
): ProductionOperatorRuntimeState[] {
  if (!keyframes || keyframes.length === 0) {
    return fallbackOperators;
  }

  // Exact or boundary match
  if (minute <= keyframes[0].t) {
    return mergeKeyframeOps(fallbackOperators, keyframes[0].ops);
  }
  const lastKf = keyframes[keyframes.length - 1];
  if (minute >= lastKf.t) {
    return mergeKeyframeOps(fallbackOperators, lastKf.ops);
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
    return {
      id: op1.id,
      x: Math.round((op1.x + (op2.x - op1.x) * alpha) * 10) / 10,
      y: Math.round((op1.y + (op2.y - op1.y) * alpha) * 10) / 10,
      phase: alpha >= 0.5 ? op2.phase : op1.phase,
      targetMachineId: alpha >= 0.5 ? op2.targetMachineId : op1.targetMachineId,
      targetMachineLabel: alpha >= 0.5 ? op2.targetMachineLabel : op1.targetMachineLabel,
      currentZoneLabel: alpha >= 0.5 ? op2.currentZoneLabel : op1.currentZoneLabel,
      breakLabel: alpha >= 0.5 ? op2.breakLabel : op1.breakLabel,
      breakRemainingMin: Math.max(0, op1.breakRemainingMin - alpha * span),
    };
  });

  return mergeKeyframeOps(fallbackOperators, interpolatedOps, minute);
}

function mergeKeyframeOps(
  baseOperators: ProductionOperatorRuntimeState[],
  keyframeOps: OperatorKeyframeItem[],
  minute?: number,
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

  // 1. Interpolate operators
  const activeOperators = interpolateOperatorsAtMinute(
    allKeyframes,
    fullState.operators,
    minute,
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

    if (activeSeg) {
      const isRunning = activeSeg.kind === 'running' || activeSeg.kind.startsWith('running:');
      if (isRunning) {
        status = 'running';
        const rem = Math.max(0, activeSeg.endMin - minute);
        nextCompletionAt = minute + rem;
        runtimeRemainingMin = null;
        runtimePaused = false;
      } else {
        const isWaiting = activeSeg.kind === 'waiting' || activeSeg.kind.startsWith('waiting:');
        const isBeingServiced = servicingMachineIds.has(m.id) || (!isWaiting && activeSeg.kind !== 'idle');
        status = isBeingServiced ? 'being-serviced' : 'needs-service';
        runtimePaused = true;
        runtimeRemainingMin = Math.max(0, activeSeg.endMin - minute);
      }
    } else {
      status = m.status;
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
      spoolsCompleted,
      shiftSpoolsCompleted: Math.floor(spoolsCompleted),
      downtimeMin,
      downtimeByReason: machineDowntimeByReason,
      timeline: clampedTimeline,
    };
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
