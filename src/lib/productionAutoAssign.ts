import type { LayoutMachine, ProductionMachineAssignment, ProductionOperator, ProductionSetup } from '../types';
import { defaultAssignmentOrder, rowsOf } from './defaultAssignment';
import { DEFAULT_PIXELS_PER_METER } from './layoutConstants';
import type { TheoreticalActivityBreakdown, TheoreticalOperatorRow } from './theoreticalOperators';
import type { ResolvedConstruction } from './productionConstructionResolver';
import { estimateMachineServiceMinutes, estimateMachineTaskServiceMinutes } from './productionUtilization';
import { Mpp_wl_productionsetupoperatorsesService } from '../generated/services/Mpp_wl_productionsetupoperatorsesService';
import { fetchAllPages, escapeODataString, runWithConcurrency } from './dataversePaging';
import { updateMachineAssignments } from './productionSetupsStore';

const BULK_CONCURRENCY = 8;

export type AutoAssignMode = 'multi' | 'split';

export type SplitPresetId = 'three_groups_dlr' | 'full_split' | 'two_groups' | 'three_groups' | 'custom';

export type ActivityTaskKey =
  | 'doffing'
  | 'loading'
  | 'fractureRepairing'
  | 'diesChange'
  | 'defectRepairing';

export const ALL_ACTIVITY_TASKS: { key: ActivityTaskKey; label: string; defaultPrefix: string }[] = [
  { key: 'doffing', label: 'Doffing', defaultPrefix: 'Opr' },
  { key: 'loading', label: 'Loading', defaultPrefix: 'Opr' },
  { key: 'fractureRepairing', label: 'Fracture Repairing', defaultPrefix: 'Opr' },
  { key: 'diesChange', label: 'Dies Change', defaultPrefix: 'Opr' },
  { key: 'defectRepairing', label: 'Defect Repairing', defaultPrefix: 'Opr' },
];

export interface TaskGroupConfig {
  id: string;
  name: string;
  prefix: string;
  tasks: ActivityTaskKey[];
  /** Target operator count for this group (calculated or custom) */
  count: number;
}

export interface SplitPreset {
  id: SplitPresetId;
  label: string;
  description: string;
  groups: (breakdown: TheoreticalActivityBreakdown | null | undefined) => TaskGroupConfig[];
}

export const SPLIT_PRESETS: SplitPreset[] = [
  {
    id: 'three_groups_dlr',
    label: '3 Groups: Doffing, Loading, Fracture + Defect (Recommended)',
    description: 'Doffing and Loading are separated. Technical repairs (Fracture, Defect, & Dies Change) are combined into 1 group.',
    groups: (b) => {
      const getReq = (key: ActivityTaskKey) => {
        const item = b?.activities.find((a) => a.key === key);
        return item?.operators ? Math.max(1, Math.round(item.operators)) : 1;
      };
      const getSum = (keys: ActivityTaskKey[]) => {
        const sum = keys.reduce((acc, k) => {
          const item = b?.activities.find((a) => a.key === k);
          return acc + (item?.operators ?? 0);
        }, 0);
        return sum > 0 ? Math.max(1, Math.round(sum)) : 1;
      };
      return [
        { id: 'doffing', name: 'Doffing Operator', prefix: 'Opr', tasks: ['doffing'], count: getReq('doffing') },
        { id: 'loading', name: 'Loading Operator', prefix: 'Opr', tasks: ['loading'], count: getReq('loading') },
        {
          id: 'repairs',
          name: 'Fracture + Defect Repairing',
          prefix: 'Opr',
          tasks: ['fractureRepairing', 'defectRepairing', 'diesChange'],
          count: getSum(['fractureRepairing', 'defectRepairing', 'diesChange']),
        },
      ];
    },
  },
  {
    id: 'full_split',
    label: 'Full Split (5 Dedicated Groups)',
    description: 'Each activity (Doffing, Loading, Fracture, Dies, Defect) is handled by a separate operator pool.',
    groups: (b) => {
      const getReq = (key: ActivityTaskKey) => {
        const item = b?.activities.find((a) => a.key === key);
        return item?.operators ? Math.max(1, Math.round(item.operators)) : 1;
      };
      return [
        { id: 'doffing', name: 'Doffing Operator', prefix: 'Opr', tasks: ['doffing'], count: getReq('doffing') },
        { id: 'loading', name: 'Loading Operator', prefix: 'Opr', tasks: ['loading'], count: getReq('loading') },
        { id: 'fractureRepairing', name: 'Fracture Repairing', prefix: 'Opr', tasks: ['fractureRepairing'], count: getReq('fractureRepairing') },
        { id: 'diesChange', name: 'Dies Change', prefix: 'Opr', tasks: ['diesChange'], count: getReq('diesChange') },
        { id: 'defectRepairing', name: 'Defect Repairing', prefix: 'Opr', tasks: ['defectRepairing'], count: getReq('defectRepairing') },
      ];
    },
  },
  {
    id: 'two_groups',
    label: '2 Groups: Material Handling vs Technical / Quality',
    description: 'Doffing & Loading are combined (physical bobbin/spool handling). Fracture, Defect & Dies are combined (quality & technical repairs).',
    groups: (b) => {
      const getSum = (keys: ActivityTaskKey[]) => {
        const sum = keys.reduce((acc, k) => {
          const item = b?.activities.find((a) => a.key === k);
          return acc + (item?.operators ?? 0);
        }, 0);
        return sum > 0 ? Math.max(1, Math.round(sum)) : 1;
      };
      return [
        {
          id: 'material',
          name: 'Material Handling (Doffing + Loading)',
          prefix: 'Opr',
          tasks: ['doffing', 'loading'],
          count: getSum(['doffing', 'loading']),
        },
        {
          id: 'repairs',
          name: 'Technical Repairs (Fracture + Defect + Dies)',
          prefix: 'Opr',
          tasks: ['fractureRepairing', 'defectRepairing', 'diesChange'],
          count: getSum(['fractureRepairing', 'defectRepairing', 'diesChange']),
        },
      ];
    },
  },
  {
    id: 'three_groups',
    label: '3 Groups: Material, Repairs, Dies Specialist',
    description: 'Doffing + Loading (Material), Fracture + Defect (Breaks & Defects), and Dies Change (Specialist).',
    groups: (b) => {
      const getSum = (keys: ActivityTaskKey[]) => {
        const sum = keys.reduce((acc, k) => {
          const item = b?.activities.find((a) => a.key === k);
          return acc + (item?.operators ?? 0);
        }, 0);
        return sum > 0 ? Math.max(1, Math.round(sum)) : 1;
      };
      const diesReq = b?.activities.find((a) => a.key === 'diesChange')?.operators;
      return [
        {
          id: 'material',
          name: 'Material Handling (Doffing + Loading)',
          prefix: 'Opr',
          tasks: ['doffing', 'loading'],
          count: getSum(['doffing', 'loading']),
        },
        {
          id: 'repairs',
          name: 'Break & Defect (Fracture + Defect)',
          prefix: 'Opr',
          tasks: ['fractureRepairing', 'defectRepairing'],
          count: getSum(['fractureRepairing', 'defectRepairing']),
        },
        {
          id: 'dies',
          name: 'Dies Specialist',
          prefix: 'Opr',
          tasks: ['diesChange'],
          count: diesReq ? Math.max(1, Math.round(diesReq)) : 1,
        },
      ];
    },
  },
];

export interface AutoAssignOptions {
  mode: AutoAssignMode;
  /** Multi task operator count */
  multiCount?: number;
  multiPrefix?: string;
  /** Split task preset and custom groups */
  splitPresetId?: SplitPresetId;
  taskGroups?: TaskGroupConfig[];
  /** When true (default), optimizes total operators to ceil(totalRequired) by balancing fractional remainder */
  balanceFractionalDemand?: boolean;
  /** Total operator count override for split mode when balancing */
  splitTotalCount?: number;
  /** Target machine IDs to assign (if omitted, targets all layout machines) */
  targetMachineIds?: string[];
  /** Only assign machines that have a Construction Detail */
  onlyPlannedMachines?: boolean;
  /** Theoretical operator requirement rows per Construction Detail to balance multi-task workload */
  operatorRequirementRows?: TheoreticalOperatorRow[];
  /** Optional pre-sorted layout machines to bypass repeated defaultAssignmentOrder computation */
  preorderedMachines?: LayoutMachine[];
  /** Resolved Construction Details to compute exact service demand (runtime, doffing, repairs, RPC) */
  resolvedConstructions?: Map<string, ResolvedConstruction>;
}

/** Finds the highest numeric suffix in existing operator labels for a given prefix.
 * e.g. If setup already has Opr_0001, Opr_0003, returns 3.
 * If prefix is not found, returns 0.
 */
export function getHighestOperatorNumber(prefix: string, existingLabels: string[]): number {
  const cleanPrefix = prefix.trim().toLowerCase();
  if (!cleanPrefix) return 0;

  const escaped = cleanPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped}[_\\-\\s]?(\\d+)$`, 'i');

  let maxNum = 0;
  for (const label of existingLabels) {
    const match = label.trim().match(regex);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }
  }
  return maxNum;
}

interface SpatialMachinePosition {
  rIdx: number;
  cIdx: number;
  centerX: number;
  centerY: number;
}

function computeOperatorSpatialCost(
  machines: LayoutMachine[],
  machinePosMap: Map<string, SpatialMachinePosition>,
): number {
  if (!machines || machines.length === 0) return 0;

  const rowGroups = new Map<number, SpatialMachinePosition[]>();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  machines.forEach((m) => {
    const pos = machinePosMap.get(m.id);
    if (!pos) return;
    minX = Math.min(minX, pos.centerX);
    maxX = Math.max(maxX, pos.centerX);
    minY = Math.min(minY, pos.centerY);
    maxY = Math.max(maxY, pos.centerY);

    const group = rowGroups.get(pos.rIdx);
    if (group) {
      group.push(pos);
    } else {
      rowGroups.set(pos.rIdx, [pos]);
    }
  });

  if (rowGroups.size === 0 || minX === Infinity) return 0;

  const presentRows = Array.from(rowGroups.keys()).sort((a, b) => a - b);
  const minRow = presentRows[0];
  const maxRow = presentRows[presentRows.length - 1];
  const rowSpan = maxRow - minRow;

  // 1. Row span penalty
  let cost = rowSpan * 2000;

  // 2. Skipped row penalty (e.g. occupying row 0 and 2 without 1)
  const skippedRows = rowSpan + 1 - presentRows.length;
  if (skippedRows > 0) {
    cost += skippedRows * 10000;
  }

  // 3. Dominant row and fragmentation penalty
  let dominantRow = presentRows[0];
  let maxCountInRow = 0;
  presentRows.forEach((r) => {
    const count = rowGroups.get(r)!.length;
    if (count > maxCountInRow) {
      maxCountInRow = count;
      dominantRow = r;
    }
  });

  presentRows.forEach((r) => {
    const group = rowGroups.get(r)!.sort((a, b) => a.cIdx - b.cIdx);
    const count = group.length;

    // Small row penalty if far from dominant row
    if (r !== dominantRow && count < 3) {
      const dist = Math.abs(r - dominantRow);
      cost += (3 - count) * 2000 * dist;
    }

    // Gap penalty within the row
    for (let i = 0; i < group.length - 1; i++) {
      const gap = group[i + 1].cIdx - group[i].cIdx;
      if (gap > 1) {
        cost += (gap - 1) * 3000;
      }
    }
  });

  // 4. Horizontal alignment penalty between adjacent rows
  for (let i = 0; i < presentRows.length - 1; i++) {
    const r1 = presentRows[i];
    const r2 = presentRows[i + 1];
    if (r2 - r1 === 1) {
      const g1 = rowGroups.get(r1)!;
      const g2 = rowGroups.get(r2)!;
      const minX1 = Math.min(...g1.map((p) => p.centerX));
      const maxX1 = Math.max(...g1.map((p) => p.centerX));
      const minX2 = Math.min(...g2.map((p) => p.centerX));
      const maxX2 = Math.max(...g2.map((p) => p.centerX));

      if (maxX1 < minX2) {
        cost += (minX2 - maxX1) * 2.0;
      } else if (maxX2 < minX1) {
        cost += (minX1 - maxX2) * 2.0;
      }
    }
  }

  // 5. Bounding box penalty
  cost += (maxX - minX) * 0.1 + (maxY - minY) * 1.0;

  return cost;
}

function optimizeMultiOperatorSpatialBoundaries({
  targetMachines,
  machineAssignments,
  machineWeightsMap,
  layout,
  pixelsPerMeter,
  operatorCount,
}: {
  targetMachines: LayoutMachine[];
  machineAssignments: Map<string, Partial<ProductionMachineAssignment>>;
  machineWeightsMap: Map<string, number>;
  layout: LayoutMachine[];
  pixelsPerMeter: number;
  operatorCount: number;
}): void {
  if (operatorCount <= 1 || targetMachines.length === 0) return;

  const rows = rowsOf(layout, pixelsPerMeter);
  if (rows.length === 0) return;

  const machinePosMap = new Map<string, SpatialMachinePosition>();
  rows.forEach((row, rIdx) => {
    row.machines.forEach((item, cIdx) => {
      machinePosMap.set(item.machine.id, {
        rIdx,
        cIdx,
        centerX: item.centerX,
        centerY: row.centerY,
      });
    });
  });

  const totalWeight = Array.from(machineWeightsMap.values()).reduce((a, b) => a + b, 0);
  const avgWeight = totalWeight / (targetMachines.length || 1);
  const maxWeightDiff = Math.max(0.001, avgWeight * 0.05);

  const maxIterations = targetMachines.length > 200 ? 5 : 20;
  const boundaryWindow = targetMachines.length > 200 ? 4 : 6;
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;

    // Group machines by assigned operator
    const opMachines = new Map<string, LayoutMachine[]>();
    targetMachines.forEach((m) => {
      const opLabel = machineAssignments.get(m.id)?.assignedOperatorIds?.[0];
      if (!opLabel) return;
      const list = opMachines.get(opLabel);
      if (list) {
        list.push(m);
      } else {
        opMachines.set(opLabel, [m]);
      }
    });

    const opCosts = new Map<string, number>();
    opMachines.forEach((machs, opLabel) => {
      opCosts.set(opLabel, computeOperatorSpatialCost(machs, machinePosMap));
    });

    let bestDelta = 0;
    let bestSwap: { mA: LayoutMachine; mB: LayoutMachine; opA: string; opB: string } | null = null;

    // Fast boundary check: only evaluate machines near operator boundary transitions along the sorted layout
    for (let k = 0; k < targetMachines.length - 1; k++) {
      const mA = targetMachines[k];
      const opA = machineAssignments.get(mA.id)?.assignedOperatorIds?.[0];
      const nextM = targetMachines[k + 1];
      const opNext = machineAssignments.get(nextM.id)?.assignedOperatorIds?.[0];

      // Found a boundary transition between two operators
      if (opA && opNext && opA !== opNext) {
        const startA = Math.max(0, k - boundaryWindow + 1);
        const endB = Math.min(targetMachines.length - 1, k + boundaryWindow);

        for (let i = startA; i <= k; i++) {
          const candA = targetMachines[i];
          const currOpA = machineAssignments.get(candA.id)?.assignedOperatorIds?.[0];
          if (currOpA !== opA) continue;
          const wA = machineWeightsMap.get(candA.id) ?? 1;

          for (let j = k + 1; j <= endB; j++) {
            const candB = targetMachines[j];
            const currOpB = machineAssignments.get(candB.id)?.assignedOperatorIds?.[0];
            if (currOpB !== opNext) continue;
            const wB = machineWeightsMap.get(candB.id) ?? 1;

            if (Math.abs(wA - wB) > maxWeightDiff) continue;

            const machsA = opMachines.get(opA);
            const machsB = opMachines.get(opNext);
            if (!machsA || !machsB) continue;

            // Safety guard: ensure spatial swap does not degrade workload balance
            const currentWeightA = machsA.reduce((s, m) => s + (machineWeightsMap.get(m.id) ?? 1), 0);
            const currentWeightB = machsB.reduce((s, m) => s + (machineWeightsMap.get(m.id) ?? 1), 0);
            const targetWeight = (totalWeight / (operatorCount || 1));
            const devOld = Math.abs(currentWeightA - targetWeight) + Math.abs(currentWeightB - targetWeight);
            const devNew = Math.abs((currentWeightA - wA + wB) - targetWeight) + Math.abs((currentWeightB - wB + wA) - targetWeight);
            if (devNew > devOld + 0.02) continue;

            const newMachsA = machsA.filter((m) => m.id !== candA.id).concat([candB]);
            const newMachsB = machsB.filter((m) => m.id !== candB.id).concat([candA]);

            const costAOld = opCosts.get(opA) ?? 0;
            const costBOld = opCosts.get(opNext) ?? 0;

            const costANew = computeOperatorSpatialCost(newMachsA, machinePosMap);
            const costBNew = computeOperatorSpatialCost(newMachsB, machinePosMap);

            const delta = (costAOld + costBOld) - (costANew + costBNew);
            if (delta > 50 && delta > bestDelta) {
              bestDelta = delta;
              bestSwap = { mA: candA, mB: candB, opA, opB: opNext };
            }
          }
        }
      }
    }

    if (bestSwap) {
      const patchA = machineAssignments.get(bestSwap.mA.id);
      if (patchA) patchA.assignedOperatorIds = [bestSwap.opB];
      const patchB = machineAssignments.get(bestSwap.mB.id);
      if (patchB) patchB.assignedOperatorIds = [bestSwap.opA];
    } else {
      break;
    }
  }
}

/**
 * Fairly partitions an ordered list of items (machines sorted along layout walk order)
 * into K contiguous partitions such that the workload of each partition is as close
 * to totalWeight / K as possible, minimizing workload variance and eliminating "jomplang" loads.
 *
 * Uses Bounded-Window Dynamic Programming to find the mathematically optimal cut points
 * that globally minimize the sum of squared deviations: sum((W_p - target)^2).
 */
export function partitionOrderedSequenceByWorkload<T>({
  items,
  weights,
  partitionCount,
}: {
  items: T[];
  weights: number[];
  partitionCount: number;
}): Array<{ partitionIndex: number; itemIndices: number[]; totalWeight: number }> {
  const n = items.length;
  const k = Math.max(1, Math.min(partitionCount, n));
  if (n === 0) return [];
  if (k === 1) {
    const sum = weights.reduce((a, b) => a + b, 0);
    return [{ partitionIndex: 0, itemIndices: items.map((_, i) => i), totalWeight: sum }];
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const targetPerPartition = totalWeight / k;

  // Prefix sums for O(1) range sum queries
  const prefixSum: number[] = [0];
  for (let i = 0; i < n; i++) {
    prefixSum.push(prefixSum[i] + weights[i]);
  }

  let partitions: Array<{ partitionIndex: number; itemIndices: number[]; totalWeight: number }> = [];

  // 1. Dynamic Programming partition optimization
  try {
    const avgItems = n / k;
    const minSpan = 1;
    const maxSpan = Math.max(minSpan + 1, Math.min(n, Math.ceil(avgItems * 4.0) + 10));

    const dp = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(Infinity));
    const parent = Array.from({ length: k + 1 }, () => new Int32Array(n + 1).fill(0));

    dp[0][0] = 0;

    for (let p = 1; p <= k; p++) {
      const minI = p;
      const maxI = n - (k - p);
      for (let i = minI; i <= maxI; i++) {
        const jStart = Math.max(p - 1, i - maxSpan);
        const jEnd = Math.min(i - minSpan, i - 1);
        for (let j = jStart; j <= jEnd; j++) {
          if (dp[p - 1][j] === Infinity) continue;
          const w = prefixSum[i] - prefixSum[j];
          const val = dp[p - 1][j] + Math.pow(w - targetPerPartition, 2);
          if (val < dp[p][i]) {
            dp[p][i] = val;
            parent[p][i] = j;
          }
        }
      }
    }

    if (dp[k][n] < Infinity) {
      let curr = n;
      for (let p = k; p >= 1; p--) {
        const prev = parent[p][curr];
        const indices: number[] = [];
        for (let idx = prev; idx < curr; idx++) indices.push(idx);
        partitions.unshift({
          partitionIndex: p - 1,
          itemIndices: indices,
          totalWeight: prefixSum[curr] - prefixSum[prev],
        });
        curr = prev;
      }
    }
  } catch {
    partitions = [];
  }

  // 2. Fallback to greedy cut if DP did not reach end
  if (partitions.length !== k) {
    partitions = [];
    const cutPoints: number[] = [];
    let currentStart = 0;

    for (let p = 0; p < k - 1; p++) {
      const targetCumulative = (p + 1) * targetPerPartition;
      const remainingPartitions = (k - 1) - p;
      const maxEnd = n - remainingPartitions - 1;

      let bestCut = currentStart;
      let minDiff = Infinity;

      for (let i = currentStart; i <= maxEnd; i++) {
        const cum = prefixSum[i + 1];
        const diff = Math.abs(cum - targetCumulative);
        if (diff < minDiff) {
          minDiff = diff;
          bestCut = i;
        } else if (cum > targetCumulative) {
          break;
        }
      }

      cutPoints.push(bestCut);
      currentStart = bestCut + 1;
    }

    let prevCut = -1;
    for (let p = 0; p < k; p++) {
      const endCut = p === k - 1 ? n - 1 : cutPoints[p];
      const indices: number[] = [];
      for (let i = prevCut + 1; i <= endCut; i++) {
        indices.push(i);
      }
      partitions.push({
        partitionIndex: p,
        itemIndices: indices,
        totalWeight: prefixSum[endCut + 1] - prefixSum[prevCut + 1],
      });
      prevCut = endCut;
    }
  }

  // 3. Local boundary refinement pass (safety fine-tuning)
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (let p = 0; p < k - 1; p++) {
      const partA = partitions[p];
      const partB = partitions[p + 1];
      if (partA.itemIndices.length <= 1 || partB.itemIndices.length <= 1) continue;

      const lastIdxA = partA.itemIndices[partA.itemIndices.length - 1];
      const weightA = weights[lastIdxA];

      const errCurrent =
        Math.pow(partA.totalWeight - targetPerPartition, 2) +
        Math.pow(partB.totalWeight - targetPerPartition, 2);

      const errMoveAtoB =
        Math.pow((partA.totalWeight - weightA) - targetPerPartition, 2) +
        Math.pow((partB.totalWeight + weightA) - targetPerPartition, 2);

      if (errMoveAtoB < errCurrent - 0.0001 && partA.itemIndices.length > 1) {
        partA.itemIndices.pop();
        partB.itemIndices.unshift(lastIdxA);
        partA.totalWeight -= weightA;
        partB.totalWeight += weightA;
        improved = true;
        continue;
      }

      const firstIdxB = partB.itemIndices[0];
      const weightB = weights[firstIdxB];
      const errMoveBtoA =
        Math.pow((partA.totalWeight + weightB) - targetPerPartition, 2) +
        Math.pow((partB.totalWeight - weightB) - targetPerPartition, 2);

      if (errMoveBtoA < errCurrent - 0.0001 && partB.itemIndices.length > 1) {
        partB.itemIndices.shift();
        partA.itemIndices.push(firstIdxB);
        partA.totalWeight += weightB;
        partB.totalWeight -= weightB;
        improved = true;
      }
    }
    if (!improved) break;
  }

  return partitions;
}

/**
 * Consolidates operator row sprawl and eliminates outlier/fragment rows.
 * For example, when an operator spans rows 1700, 1600, and 1500, but only holds a small
 * cluster in row 1500 (e.g. 1516-1520), this pass swaps those machines with an adjacent operator's
 * contiguous machines in the intermediate row (1611-1615 in row 1600).
 * This eliminates the 3rd row for Operator Biru (now strictly rows 1700 & 1600) and gives Operator Merah
 * a complete, uninterrupted row 1500.
 */
export function consolidateOperatorRowBoundaries({
  targetMachines,
  machineAssignments,
  machineWeightsMap,
  layout,
  pixelsPerMeter,
  taskKey,
}: {
  targetMachines: LayoutMachine[];
  machineAssignments: Map<string, Partial<ProductionMachineAssignment>>;
  machineWeightsMap: Map<string, number>;
  layout: LayoutMachine[];
  pixelsPerMeter: number;
  taskKey?: ActivityTaskKey;
}): void {
  if (targetMachines.length === 0) return;

  const rows = rowsOf(layout, pixelsPerMeter);
  if (rows.length < 2) return;

  const machinePosMap = new Map<string, { rIdx: number; cIdx: number }>();
  rows.forEach((row, rIdx) => {
    row.machines.forEach((item, cIdx) => {
      machinePosMap.set(item.machine.id, { rIdx, cIdx });
    });
  });

  const getOp = (mId: string): string | undefined => {
    const a = machineAssignments.get(mId);
    if (!a) return undefined;
    if (!taskKey) return a.assignedOperatorIds?.[0];
    if (taskKey === 'doffing') return a.doffingOperatorIds?.[0];
    if (taskKey === 'loading') return a.loadingOperatorIds?.[0];
    if (taskKey === 'fractureRepairing') return a.fractureRepairingOperatorIds?.[0];
    if (taskKey === 'diesChange') return a.diesChangeOperatorIds?.[0];
    if (taskKey === 'defectRepairing') return a.defectRepairingOperatorIds?.[0];
    return undefined;
  };

  const setOp = (mId: string, op: string): void => {
    const a = machineAssignments.get(mId);
    if (!a) return;
    if (!taskKey) { a.assignedOperatorIds = [op]; return; }
    if (taskKey === 'doffing') { a.doffingOperatorIds = [op]; return; }
    if (taskKey === 'loading') { a.loadingOperatorIds = [op]; return; }
    if (taskKey === 'fractureRepairing') { a.fractureRepairingOperatorIds = [op]; return; }
    if (taskKey === 'diesChange') { a.diesChangeOperatorIds = [op]; return; }
    if (taskKey === 'defectRepairing') { a.defectRepairingOperatorIds = [op]; return; }
  };

  const allTargetIds = new Set(targetMachines.map((m) => m.id));
  const targetLayoutMachines = layout.filter((m) => allTargetIds.has(m.id));

  for (let pass = 0; pass < 5; pass++) {
    let anySwap = false;

    // Group target machines by operator
    const opMachines = new Map<string, LayoutMachine[]>();
    targetLayoutMachines.forEach((m) => {
      const op = getOp(m.id);
      if (!op) return;
      const list = opMachines.get(op);
      if (list) list.push(m);
      else opMachines.set(op, [m]);
    });

    for (const [opA, machsA] of opMachines.entries()) {
      const rowBuckets = new Map<number, LayoutMachine[]>();
      machsA.forEach((m) => {
        const pos = machinePosMap.get(m.id);
        if (!pos) return;
        const list = rowBuckets.get(pos.rIdx);
        if (list) list.push(m);
        else rowBuckets.set(pos.rIdx, [m]);
      });

      const presentRows = Array.from(rowBuckets.keys()).sort((a, b) => a - b);
      if (presentRows.length < 2) continue;

      const minRow = presentRows[0];
      const maxRow = presentRows[presentRows.length - 1];
      if (maxRow - minRow < 2) continue; // Spans only 2 rows, already compact

      const extremalCandidates = [
        { rExtremal: maxRow, rAdjacent: maxRow - 1 },
        { rExtremal: minRow, rAdjacent: minRow + 1 },
      ];

      for (const { rExtremal, rAdjacent } of extremalCandidates) {
        const extMachs = (rowBuckets.get(rExtremal) ?? []).sort((a, b) => {
          return (machinePosMap.get(a.id)?.cIdx ?? 0) - (machinePosMap.get(b.id)?.cIdx ?? 0);
        });
        const adjMachs = (rowBuckets.get(rAdjacent) ?? []).sort((a, b) => {
          return (machinePosMap.get(a.id)?.cIdx ?? 0) - (machinePosMap.get(b.id)?.cIdx ?? 0);
        });

        if (extMachs.length === 0 || adjMachs.length === 0) continue;
        if (extMachs.length > machsA.length * 0.45) continue;

        const minAdjCol = machinePosMap.get(adjMachs[0].id)!.cIdx;
        const maxAdjCol = machinePosMap.get(adjMachs[adjMachs.length - 1].id)!.cIdx;

        const rowAdjMachinesAll = rows[rAdjacent].machines
          .map((item) => item.machine)
          .filter((m) => allTargetIds.has(m.id))
          .sort((a, b) => (machinePosMap.get(a.id)?.cIdx ?? 0) - (machinePosMap.get(b.id)?.cIdx ?? 0));

        // Candidates in rAdjacent to the left of opA
        const leftCands = rowAdjMachinesAll.filter((m) => {
          const c = machinePosMap.get(m.id)!.cIdx;
          return c < minAdjCol && getOp(m.id) && getOp(m.id) !== opA;
        });

        // Candidates in rAdjacent to the right of opA
        const rightCands = rowAdjMachinesAll.filter((m) => {
          const c = machinePosMap.get(m.id)!.cIdx;
          return c > maxAdjCol && getOp(m.id) && getOp(m.id) !== opA;
        });

        const targetCands: LayoutMachine[] = [];
        let opB: string | null = null;

        if (
          leftCands.length > 0 &&
          machinePosMap.get(leftCands[leftCands.length - 1].id)!.cIdx === minAdjCol - 1
        ) {
          const candOp = getOp(leftCands[leftCands.length - 1].id)!;
          let idx = leftCands.length - 1;
          while (idx >= 0 && getOp(leftCands[idx].id) === candOp && targetCands.length < extMachs.length) {
            targetCands.unshift(leftCands[idx]);
            idx--;
          }
          opB = candOp;
        } else if (
          rightCands.length > 0 &&
          machinePosMap.get(rightCands[0].id)!.cIdx === maxAdjCol + 1
        ) {
          const candOp = getOp(rightCands[0].id)!;
          let idx = 0;
          while (idx < rightCands.length && getOp(rightCands[idx].id) === candOp && targetCands.length < extMachs.length) {
            targetCands.push(rightCands[idx]);
            idx++;
          }
          opB = candOp;
        }

        if (targetCands.length > 0 && opB) {
          const swapCount = targetCands.length;
          const extToSwap = extMachs.slice(-swapCount);

          const wGive = extToSwap.reduce((s, m) => s + (machineWeightsMap.get(m.id) ?? 1), 0);
          const wTake = targetCands.reduce((s, m) => s + (machineWeightsMap.get(m.id) ?? 1), 0);
          const weightDiff = Math.abs(wGive - wTake);

          if (weightDiff <= Math.max(0.18, (wGive / swapCount) * 0.85)) {
            extToSwap.forEach((m) => setOp(m.id, opB!));
            targetCands.forEach((m) => setOp(m.id, opA));
            anySwap = true;
            break;
          }
        }
      }
      if (anySwap) break;
    }
    if (!anySwap) break;
  }
}

/**
 * Ensures no operator is left with a jomplang underload by rebalancing boundary machines
 * with adjacent operators along the layout order.
 */
function rebalanceUnderloadedOperators({
  targetMachines,
  machineAssignments,
  machineWeightsMap,
  targetWorkloadPerOperator,
}: {
  targetMachines: LayoutMachine[];
  machineAssignments: Map<string, Partial<ProductionMachineAssignment>>;
  machineWeightsMap: Map<string, number>;
  targetWorkloadPerOperator: number;
}): void {
  if (targetWorkloadPerOperator <= 0 || targetMachines.length <= 1) return;

  for (let pass = 0; pass < 3; pass++) {
    const opWeights = new Map<string, number>();
    targetMachines.forEach((m) => {
      const op = machineAssignments.get(m.id)?.assignedOperatorIds?.[0];
      if (!op) return;
      opWeights.set(op, (opWeights.get(op) ?? 0) + (machineWeightsMap.get(m.id) ?? 0.05));
    });

    let rebalanced = false;

    for (let i = 0; i < targetMachines.length - 1; i++) {
      const mA = targetMachines[i];
      const mB = targetMachines[i + 1];
      const opA = machineAssignments.get(mA.id)?.assignedOperatorIds?.[0];
      const opB = machineAssignments.get(mB.id)?.assignedOperatorIds?.[0];

      if (!opA || !opB || opA === opB) continue;

      const wA = opWeights.get(opA) ?? 0;
      const wB = opWeights.get(opB) ?? 0;

      // Transfer mB from opB to opA if opA is underloaded and opB has headroom
      if (wA < targetWorkloadPerOperator * 0.85 && wB > targetWorkloadPerOperator * 0.95) {
        const weightMB = machineWeightsMap.get(mB.id) ?? 0.05;
        const newErr =
          Math.pow(wA + weightMB - targetWorkloadPerOperator, 2) +
          Math.pow(wB - weightMB - targetWorkloadPerOperator, 2);
        const oldErr =
          Math.pow(wA - targetWorkloadPerOperator, 2) +
          Math.pow(wB - targetWorkloadPerOperator, 2);

        if (newErr < oldErr) {
          const patch = machineAssignments.get(mB.id);
          if (patch) patch.assignedOperatorIds = [opA];
          opWeights.set(opA, wA + weightMB);
          opWeights.set(opB, wB - weightMB);
          rebalanced = true;
          break;
        }
      }

      // Transfer mA from opA to opB if opB is underloaded and opA has headroom
      if (wB < targetWorkloadPerOperator * 0.85 && wA > targetWorkloadPerOperator * 0.95) {
        const weightMA = machineWeightsMap.get(mA.id) ?? 0.05;
        const newErr =
          Math.pow(wA - weightMA - targetWorkloadPerOperator, 2) +
          Math.pow(wB + weightMA - targetWorkloadPerOperator, 2);
        const oldErr =
          Math.pow(wA - targetWorkloadPerOperator, 2) +
          Math.pow(wB - targetWorkloadPerOperator, 2);

        if (newErr < oldErr) {
          const patch = machineAssignments.get(mA.id);
          if (patch) patch.assignedOperatorIds = [opB];
          opWeights.set(opA, wA - weightMA);
          opWeights.set(opB, wB + weightMA);
          rebalanced = true;
          break;
        }
      }
    }

    if (!rebalanced) break;
  }
}

/** Previews the assignment plan without saving to Dataverse */
export function computeAutoAssignPlan({
  setup,
  options,
  activityBreakdown,
}: {
  setup: ProductionSetup;
  options: AutoAssignOptions;
  activityBreakdown?: TheoreticalActivityBreakdown | null;
}): {
  operatorsToCreate: { label: string; groupKey?: string; description?: string }[];
  machineAssignments: Map<string, Partial<ProductionMachineAssignment>>;
} {
  // 1. Filter target machines first so spatial ordering is performed directly on the active machines
  const targetIdSet = options.targetMachineIds && options.targetMachineIds.length > 0
    ? new Set(options.targetMachineIds)
    : null;

  const plannedMachineIds = new Set(
    setup.assignments.filter((a) => a.constructionDetailId).map((a) => a.machineId),
  );

  let candidateMachines = setup.layout;
  if (targetIdSet) {
    candidateMachines = candidateMachines.filter((m) => targetIdSet.has(m.id));
  }
  if (options.onlyPlannedMachines !== false) {
    candidateMachines = candidateMachines.filter((m) => plannedMachineIds.has(m.id));
  }

  const targetMachines =
    options.preorderedMachines && options.preorderedMachines.length === candidateMachines.length
      ? options.preorderedMachines
      : defaultAssignmentOrder(candidateMachines, setup.movement?.pixelsPerMeter);

  const operatorsToCreate: { label: string; groupKey?: string; description?: string }[] = [];
  const machineAssignments = new Map<string, Partial<ProductionMachineAssignment>>();

  // Initialize all target machines in map
  targetMachines.forEach((m) => {
    machineAssignments.set(m.id, {});
  });

  if (targetMachines.length === 0) {
    return { operatorsToCreate, machineAssignments };
  }

  // 2. Identify preserved operators that will remain in the setup
  const preservedOperatorLabels = new Set<string>();

  if (targetIdSet) {
    const operatorsUsedInside = new Set<string>();
    const operatorsUsedOutside = new Set<string>();

    setup.assignments.forEach((a) => {
      const isInside = targetIdSet.has(a.machineId);
      const targetSet = isInside ? operatorsUsedInside : operatorsUsedOutside;
      a.assignedOperatorIds?.forEach((id) => targetSet.add(id));
      a.doffingOperatorIds?.forEach((id) => targetSet.add(id));
      a.loadingOperatorIds?.forEach((id) => targetSet.add(id));
      a.fractureRepairingOperatorIds?.forEach((id) => targetSet.add(id));
      a.diesChangeOperatorIds?.forEach((id) => targetSet.add(id));
      a.defectRepairingOperatorIds?.forEach((id) => targetSet.add(id));
    });

    // Operators in setup.operators that are NOT exclusively used on target machines are preserved
    setup.operators.forEach((op) => {
      const isExclusivelyInside = operatorsUsedInside.has(op.id) && !operatorsUsedOutside.has(op.id);
      if (!isExclusivelyInside) {
        preservedOperatorLabels.add(op.label);
      }
    });
  }

  // 3. Counter generator per prefix that continues from the highest existing ID
  const prefixCounters = new Map<string, number>();
  const getNextLabel = (rawPrefix: string) => {
    const cleanPrefix = rawPrefix.trim() || 'Opr';
    if (!prefixCounters.has(cleanPrefix)) {
      const highest = getHighestOperatorNumber(cleanPrefix, Array.from(preservedOperatorLabels));
      prefixCounters.set(cleanPrefix, highest + 1);
    }
    const current = prefixCounters.get(cleanPrefix)!;
    prefixCounters.set(cleanPrefix, current + 1);
    return `${cleanPrefix}_${String(current).padStart(4, '0')}`;
  };

  // 4. Build workload weight per machine to avoid "jomplang" man occupation across operators
  const netShiftMinutes = Math.max(1, setup.shiftTime - (setup.lunchTime ?? 0) - (setup.meetingTime ?? 0));
  // Base walking / patrol transit and interference overhead per machine (~2.5 minutes per machine per shift)
  const WALKING_OVERHEAD_WEIGHT = 0.006;

  const cdWorkloadMap = new Map<string, number>();

  // Priority 1: TheoreticalOperatorRow if provided (from single-operator optimize)
  if (options.operatorRequirementRows && options.operatorRequirementRows.length > 0) {
    options.operatorRequirementRows.forEach((row) => {
      if (row.machines > 0 && row.operators > 0) {
        cdWorkloadMap.set(row.productId, row.operators / row.machines);
      } else if (row.machinesPerOperator > 0) {
        cdWorkloadMap.set(row.productId, 1 / row.machinesPerOperator);
      }
    });
  }

  // Priority 2: Automatically calculate from ResolvedConstruction specs (speed, runtime, doffing, repairs, RPC)
  if (options.resolvedConstructions && options.resolvedConstructions.size > 0) {
    options.resolvedConstructions.forEach((rc, cdId) => {
      if (!cdWorkloadMap.has(cdId)) {
        const serviceMins = estimateMachineServiceMinutes(rc, setup.shiftTime, setup.rpc);
        if (serviceMins > 0) {
          cdWorkloadMap.set(cdId, serviceMins / netShiftMinutes);
        }
      }
    });
  }

  const assignmentByMachine = new Map(setup.assignments.map((a) => [a.machineId, a]));

  if (options.mode === 'multi') {
    const rawReq = activityBreakdown?.allTask.operators;
    const count = options.multiCount ?? (rawReq ? Math.max(1, Math.round(rawReq)) : Math.max(1, setup.operators.length || 10));
    const prefix = options.multiPrefix?.trim() || 'Opr';

    const multiLabels = Array.from({ length: count }, () => getNextLabel(prefix));
    multiLabels.forEach((label) => operatorsToCreate.push({ label, groupKey: 'multi', description: 'Multi Task' }));

    const machineWeights = targetMachines.map((m) => {
      const cdId = assignmentByMachine.get(m.id)?.constructionDetailId;
      const baseWeight = cdId && cdWorkloadMap.has(cdId) ? cdWorkloadMap.get(cdId)! : (1 / Math.max(10, count * 3));
      return Math.max(0.001, baseWeight + WALKING_OVERHEAD_WEIGHT);
    });

    // Fair partition: groups machines into contiguous blocks along layout path with strictly balanced workload
    const partitions = partitionOrderedSequenceByWorkload({
      items: targetMachines,
      weights: machineWeights,
      partitionCount: count,
    });

    partitions.forEach(({ partitionIndex, itemIndices }) => {
      const opLabel = multiLabels[partitionIndex];
      itemIndices.forEach((idx) => {
        const m = targetMachines[idx];
        machineAssignments.set(m.id, {
          assignedOperatorIds: [opLabel],
          doffingOperatorIds: undefined,
          loadingOperatorIds: undefined,
          fractureRepairingOperatorIds: undefined,
          diesChangeOperatorIds: undefined,
          defectRepairingOperatorIds: undefined,
        });
      });
    });

    // Optimize spatial boundaries to eliminate crossover rows and isolated machine outliers
    const machineWeightsMap = new Map<string, number>(
      targetMachines.map((m, idx) => [m.id, machineWeights[idx]]),
    );
    optimizeMultiOperatorSpatialBoundaries({
      targetMachines,
      machineAssignments,
      machineWeightsMap,
      layout: setup.layout,
      pixelsPerMeter: setup.movement?.pixelsPerMeter ?? DEFAULT_PIXELS_PER_METER,
      operatorCount: count,
    });

    // Consolidate row boundaries to eliminate 3-row sprawling and swap outlier row blocks (e.g. 1516-1520 with 1611-1615)
    consolidateOperatorRowBoundaries({
      targetMachines,
      machineAssignments,
      machineWeightsMap,
      layout: setup.layout,
      pixelsPerMeter: setup.movement?.pixelsPerMeter ?? DEFAULT_PIXELS_PER_METER,
    });

    // Guarantee that no operator is left with a jomplang underload
    const targetWorkload = machineWeights.reduce((a, b) => a + b, 0) / count;
    rebalanceUnderloadedOperators({
      targetMachines,
      machineAssignments,
      machineWeightsMap,
      targetWorkloadPerOperator: targetWorkload,
    });
  } else {
    // Split task mode
    const groups = options.taskGroups && options.taskGroups.length > 0
      ? options.taskGroups
      : (SPLIT_PRESETS.find((p) => p.id === options.splitPresetId) ?? SPLIT_PRESETS[0]).groups(activityBreakdown);

    const shouldBalance = options.balanceFractionalDemand !== false;

    // Helper to calculate task-specific machine weights for split task groups
    const getGroupMachineWeights = (grpTasks: ActivityTaskKey[], fallbackRatio: number, machines: LayoutMachine[]) => {
      return machines.map((m) => {
        const cdId = assignmentByMachine.get(m.id)?.constructionDetailId;
        if (cdId && options.resolvedConstructions?.has(cdId)) {
          const rc = options.resolvedConstructions.get(cdId)!;
          const taskMins = estimateMachineTaskServiceMinutes(rc, setup.shiftTime, setup.rpc, grpTasks);
          return Math.max(0.001, (taskMins / netShiftMinutes) + (WALKING_OVERHEAD_WEIGHT * fallbackRatio));
        }
        const baseW = cdId && cdWorkloadMap.has(cdId) ? cdWorkloadMap.get(cdId)! : 0.05;
        return Math.max(0.001, (baseW * fallbackRatio) + (WALKING_OVERHEAD_WEIGHT * fallbackRatio));
      });
    };

    if (!shouldBalance) {
      // Standard strict split (ceil per group, no cross-activity balancing)
      const groupOperatorLabels = new Map<string, string[]>();

      groups.forEach((grp) => {
        const prefix = grp.prefix.trim() || 'Opr';
        const count = Math.max(1, grp.count);
        const labels = Array.from({ length: count }, () => getNextLabel(prefix));
        groupOperatorLabels.set(grp.id, labels);
        labels.forEach((label) => operatorsToCreate.push({ label, groupKey: grp.id, description: grp.name }));

        // Fairly partition machines for this group based on task-specific workload demand
        const grpRatio = 1 / Math.max(1, groups.length);
        const groupWeights = getGroupMachineWeights(grp.tasks, grpRatio, targetMachines);

        const partitions = partitionOrderedSequenceByWorkload({
          items: targetMachines,
          weights: groupWeights,
          partitionCount: count,
        });

        partitions.forEach(({ partitionIndex, itemIndices }) => {
          const opLabel = labels[partitionIndex];
          itemIndices.forEach((idx) => {
            const m = targetMachines[idx];
            const existing = machineAssignments.get(m.id) || {};

            const patch: Partial<ProductionMachineAssignment> = {
              ...existing,
              assignedOperatorIds: undefined,
            };

            grp.tasks.forEach((task) => {
              if (task === 'doffing') patch.doffingOperatorIds = [opLabel];
              if (task === 'loading') patch.loadingOperatorIds = [opLabel];
              if (task === 'fractureRepairing') patch.fractureRepairingOperatorIds = [opLabel];
              if (task === 'diesChange') patch.diesChangeOperatorIds = [opLabel];
              if (task === 'defectRepairing') patch.defectRepairingOperatorIds = [opLabel];
            });

            machineAssignments.set(m.id, patch);
          });
        });
      });
    } else {
      // Balanced Split: distributes workload proportionally across operators
      // to keep man occupation balanced without leaves/spikes ("tidak jomplang"),
      // while prioritizing dedicated primary groups.
      const totalMachines = targetMachines.length;

      // Track assigned machines per operator to compute spatial proximity for overflow assignments
      const assignedMachinesByOp = new Map<string, Set<string>>();
      const layoutMachineMap = new Map(setup.layout.map((m) => [m.id, m]));

      // Helper to assign task to machine
      const assignTask = (machineId: string, task: ActivityTaskKey, label: string) => {
        const existing = machineAssignments.get(machineId) || {};
        const patch: Partial<ProductionMachineAssignment> = {
          ...existing,
          assignedOperatorIds: undefined,
        };
        if (task === 'doffing') patch.doffingOperatorIds = [label];
        if (task === 'loading') patch.loadingOperatorIds = [label];
        if (task === 'fractureRepairing') patch.fractureRepairingOperatorIds = [label];
        if (task === 'diesChange') patch.diesChangeOperatorIds = [label];
        if (task === 'defectRepairing') patch.defectRepairingOperatorIds = [label];
        machineAssignments.set(machineId, patch);

        if (!assignedMachinesByOp.has(label)) {
          assignedMachinesByOp.set(label, new Set());
        }
        assignedMachinesByOp.get(label)!.add(machineId);
      };

      const getMinDistanceToOp = (opLabel: string, targetMachine: LayoutMachine): number => {
        const assignedSet = assignedMachinesByOp.get(opLabel);
        if (!assignedSet || assignedSet.size === 0) return 0;
        let minDist = Infinity;
        for (const mId of assignedSet) {
          const m = layoutMachineMap.get(mId);
          if (m) {
            const dx = m.x - targetMachine.x;
            const dy = m.y - targetMachine.y;
            const dist = Math.hypot(dx, dy);
            if (dist < minDist) minDist = dist;
          }
        }
        return minDist;
      };

      // 1. Calculate demand for each group
      const groupData = groups.map((grp) => {
        const theoreticalReq = grp.tasks.reduce((sum, taskKey) => {
          const act = activityBreakdown?.activities.find((a) => a.key === taskKey);
          return sum + (act?.operators ?? 0);
        }, 0);
        const req = theoreticalReq > 0 ? theoreticalReq : grp.count;
        return {
          grp,
          req,
          prefix: grp.prefix.trim() || 'Opr',
        };
      });

      const totalDemand = groupData.reduce((sum, g) => sum + g.req, 0);
      const targetTotal = options.splitTotalCount ?? Math.max(1, Math.round(totalDemand));
      const targetWorkloadPerOperator = totalDemand / targetTotal;

      // 2. Allocate primary operators to each group
      // Each group gets at least 1 operator if targetTotal >= groups.length,
      // with remaining operators allocated according to Hamilton largest-remainder method.
      const allocatedCounts = new Map<string, number>();
      if (targetTotal >= groupData.length) {
        groupData.forEach((g) => allocatedCounts.set(g.grp.id, 1));
        const remainingToAllocate = targetTotal - groupData.length;

        const remainders = groupData.map((g) => {
          const ideal = (g.req / totalDemand) * targetTotal;
          return {
            id: g.grp.id,
            remainder: ideal - 1,
          };
        });
        remainders.sort((a, b) => b.remainder - a.remainder);

        for (let i = 0; i < remainingToAllocate; i++) {
          const targetId = remainders[i % remainders.length].id;
          allocatedCounts.set(targetId, (allocatedCounts.get(targetId) ?? 1) + 1);
        }
      } else {
        // Fewer operators than groups: give to top groups with largest demand
        const sorted = [...groupData].sort((a, b) => b.req - a.req);
        sorted.forEach((g, idx) => {
          allocatedCounts.set(g.grp.id, idx < targetTotal ? 1 : 0);
        });
      }

      // 3. Create operator instances with sequential IDs
      interface OperatorInstance {
        label: string;
        primaryGroupId: string;
        capacityRemaining: number;
        assignedLoad: number;
      }
      const operatorInstances: OperatorInstance[] = [];

      groupData.forEach((g) => {
        const count = allocatedCounts.get(g.grp.id) ?? 0;
        for (let i = 0; i < count; i++) {
          const label = getNextLabel(g.prefix);
          operatorInstances.push({
            label,
            primaryGroupId: g.grp.id,
            capacityRemaining: targetWorkloadPerOperator,
            assignedLoad: 0,
          });
          operatorsToCreate.push({
            label,
            groupKey: g.grp.id,
            description: `${g.grp.name} (Primary)`,
          });
        }
      });

      // 4. Pass 1: Assign each group's tasks to its primary operators
      interface GroupRemainingMachines {
        grp: TaskGroupConfig;
        tasks: ActivityTaskKey[];
        remainingMachines: LayoutMachine[];
        remainingDemand: number;
      }
      const unassignedSlices: GroupRemainingMachines[] = [];

      groupData.forEach((g) => {
        const primaryOps = operatorInstances.filter((op) => op.primaryGroupId === g.grp.id);
        const totalCapacityOfPrimaries = primaryOps.reduce((sum, op) => sum + op.capacityRemaining, 0);

        const grpRatio = totalDemand > 0 ? g.req / totalDemand : 1 / groups.length;

        if (primaryOps.length > 0 && totalCapacityOfPrimaries >= g.req) {
          // Primary operators can absorb 100% of this group's machines with fair workload partitioning
          const totalOps = primaryOps.length;
          const groupWeights = getGroupMachineWeights(g.grp.tasks, grpRatio, targetMachines);

          const partitions = partitionOrderedSequenceByWorkload({
            items: targetMachines,
            weights: groupWeights,
            partitionCount: totalOps,
          });

          partitions.forEach(({ partitionIndex, itemIndices }) => {
            const op = primaryOps[partitionIndex];
            itemIndices.forEach((idx) => {
              const m = targetMachines[idx];
              g.grp.tasks.forEach((t) => assignTask(m.id, t, op.label));
            });
          });

          const loadPerOp = g.req / totalOps;
          primaryOps.forEach((op) => {
            op.assignedLoad += loadPerOp;
            op.capacityRemaining = Math.max(0, targetWorkloadPerOperator - op.assignedLoad);
          });
        } else if (primaryOps.length > 0) {
          // Primary operators take machines up to their full capacity with fair workload partitioning
          const fraction = Math.min(1.0, totalCapacityOfPrimaries / g.req);
          const coveredMachineCount = Math.min(totalMachines, Math.max(primaryOps.length, Math.round(totalMachines * fraction)));

          const coveredMachines = targetMachines.slice(0, coveredMachineCount);
          const remainingMachines = targetMachines.slice(coveredMachineCount);
          const coveredWeights = getGroupMachineWeights(g.grp.tasks, grpRatio, coveredMachines);

          const totalOps = primaryOps.length;
          const partitions = partitionOrderedSequenceByWorkload({
            items: coveredMachines,
            weights: coveredWeights,
            partitionCount: totalOps,
          });

          partitions.forEach(({ partitionIndex, itemIndices }) => {
            const op = primaryOps[partitionIndex];
            itemIndices.forEach((idx) => {
              const m = coveredMachines[idx];
              g.grp.tasks.forEach((t) => assignTask(m.id, t, op.label));
            });
          });

          primaryOps.forEach((op) => {
            op.assignedLoad += targetWorkloadPerOperator;
            op.capacityRemaining = 0;
          });

          if (remainingMachines.length > 0) {
            unassignedSlices.push({
              grp: g.grp,
              tasks: g.grp.tasks,
              remainingMachines,
              remainingDemand: g.req * (remainingMachines.length / totalMachines),
            });
          }
        } else {
          // No primary operators for this group (e.g. if targetTotal was small)
          unassignedSlices.push({
            grp: g.grp,
            tasks: g.grp.tasks,
            remainingMachines: [...targetMachines],
            remainingDemand: g.req,
          });
        }
      });

      // 5. Pass 2: Distribute remaining machines to operators with capacityRemaining > 0
      unassignedSlices.forEach((slice) => {
        let machinesToAssign = slice.remainingMachines;
        let demandToCover = slice.remainingDemand;

        while (machinesToAssign.length > 0) {
          const firstMachine = machinesToAssign[0];
          // Find operators with remaining capacity, sorted primarily by physical proximity to the machine slice
          const helpers = operatorInstances
            .filter((op) => op.capacityRemaining > 0.001)
            .sort((a, b) => {
              const distA = getMinDistanceToOp(a.label, firstMachine);
              const distB = getMinDistanceToOp(b.label, firstMachine);
              if (Math.abs(distA - distB) > 5) {
                return distA - distB;
              }
              return b.capacityRemaining - a.capacityRemaining;
            });

          if (helpers.length === 0) {
            // All operators full: assign the rest to the operator closest to firstMachine
            const fallbackOp = [...operatorInstances].sort((a, b) => {
              const distA = getMinDistanceToOp(a.label, firstMachine);
              const distB = getMinDistanceToOp(b.label, firstMachine);
              if (Math.abs(distA - distB) > 5) {
                return distA - distB;
              }
              return a.assignedLoad - b.assignedLoad;
            })[0];
            machinesToAssign.forEach((m) => {
              slice.tasks.forEach((t) => assignTask(m.id, t, fallbackOp.label));
            });
            fallbackOp.assignedLoad += demandToCover;
            break;
          }

          const targetOp = helpers[0];
          const takeDemand = Math.min(demandToCover, targetOp.capacityRemaining);
          const machineCount = Math.min(
            machinesToAssign.length,
            Math.max(1, Math.round(machinesToAssign.length * (takeDemand / demandToCover))),
          );

          const assignedSubslice = machinesToAssign.slice(0, machineCount);
          machinesToAssign = machinesToAssign.slice(machineCount);

          assignedSubslice.forEach((m) => {
            slice.tasks.forEach((t) => assignTask(m.id, t, targetOp.label));
          });

          targetOp.capacityRemaining -= takeDemand;
          targetOp.assignedLoad += takeDemand;
          demandToCover -= takeDemand;
        }
      });

      // 6. Pass 3: Safety verification sweep (Guarantees NO machine is left unassigned)
      groupData.forEach((g) => {
        targetMachines.forEach((m) => {
          const assignment = machineAssignments.get(m.id);
          g.grp.tasks.forEach((t) => {
            let isSet = false;
            if (t === 'doffing' && assignment?.doffingOperatorIds?.length) isSet = true;
            if (t === 'loading' && assignment?.loadingOperatorIds?.length) isSet = true;
            if (t === 'fractureRepairing' && assignment?.fractureRepairingOperatorIds?.length) isSet = true;
            if (t === 'diesChange' && assignment?.diesChangeOperatorIds?.length) isSet = true;
            if (t === 'defectRepairing' && assignment?.defectRepairingOperatorIds?.length) isSet = true;

            if (!isSet) {
              const primaries = operatorInstances.filter((op) => op.primaryGroupId === g.grp.id);
              const pool = primaries.length > 0 ? primaries : operatorInstances;
              const closestOp = [...pool].sort(
                (a, b) => getMinDistanceToOp(a.label, m) - getMinDistanceToOp(b.label, m),
              )[0];
              if (closestOp) {
                assignTask(m.id, t, closestOp.label);
              }
            }
          });
        });
      });
    }

    // Consolidate row boundaries across task groups to eliminate 3-row sprawl
    groups.forEach((grp) => {
      if (grp.tasks.length > 0) {
        consolidateOperatorRowBoundaries({
          targetMachines,
          machineAssignments,
          machineWeightsMap: new Map(targetMachines.map((m) => [m.id, 1])),
          layout: setup.layout,
          pixelsPerMeter: setup.movement?.pixelsPerMeter ?? DEFAULT_PIXELS_PER_METER,
          taskKey: grp.tasks[0],
        });
      }
    });
  }

  return { operatorsToCreate, machineAssignments };
}

/** Executes the full Auto Assign flow in Dataverse:
 * 1. Computes plan for target machines
 * 2. Deletes old setup operators (only those exclusively assigned to target machines if subset)
 * 3. Creates newly generated operators
 * 4. Applies the facing TU machine assignments in batch with progress
 */
export async function executeAutoAssign({
  setup,
  options,
  activityBreakdown,
  onProgress,
}: {
  setup: ProductionSetup;
  options: AutoAssignOptions;
  activityBreakdown?: TheoreticalActivityBreakdown | null;
  onProgress?: (phase: string, done: number, total: number) => void;
}): Promise<{
  newOperators: ProductionOperator[];
  updatedAssignments: ProductionMachineAssignment[];
}> {
  // 1. Compute plan
  const plan = computeAutoAssignPlan({ setup, options, activityBreakdown });

  const targetIdSet = options.targetMachineIds && options.targetMachineIds.length > 0
    ? new Set(options.targetMachineIds)
    : null;

  // 2. Fetch existing operators from Dataverse
  onProgress?.('Fetching existing operators…', 0, 1);
  const oldOpRows = await fetchAllPages(Mpp_wl_productionsetupoperatorsesService.getAll, {
    filter: `mpp_productionsetupid eq '${escapeODataString(setup.id)}'`,
    select: ['mpp_wl_productionsetupoperatorsid', 'mpp_name'],
  });

  // Find operators that MUST be preserved vs deleted
  const operatorsUsedOutside = new Set<string>();
  const operatorsUsedInside = new Set<string>();

  if (targetIdSet) {
    setup.assignments.forEach((a) => {
      const isInside = targetIdSet.has(a.machineId);
      const targetSet = isInside ? operatorsUsedInside : operatorsUsedOutside;
      a.assignedOperatorIds?.forEach((id) => targetSet.add(id));
      a.doffingOperatorIds?.forEach((id) => targetSet.add(id));
      a.loadingOperatorIds?.forEach((id) => targetSet.add(id));
      a.fractureRepairingOperatorIds?.forEach((id) => targetSet.add(id));
      a.diesChangeOperatorIds?.forEach((id) => targetSet.add(id));
      a.defectRepairingOperatorIds?.forEach((id) => targetSet.add(id));
    });
  }

  // 3. Operators to delete:
  // If whole setup: delete all old operators.
  // If subset: ONLY delete operators that were used on target machines AND NOT outside target machines.
  const operatorsToDelete = targetIdSet
    ? oldOpRows.filter((row) => {
        const id = row.mpp_wl_productionsetupoperatorsid;
        return operatorsUsedInside.has(id) && !operatorsUsedOutside.has(id);
      })
    : oldOpRows;

  const deletedIdSet = new Set(operatorsToDelete.map((row) => row.mpp_wl_productionsetupoperatorsid));

  const deleteTotal = operatorsToDelete.length;
  if (deleteTotal > 0) {
    onProgress?.('Removing old operators…', 0, deleteTotal);
    let deletedCount = 0;
    await runWithConcurrency(
      operatorsToDelete,
      async (row) => {
        await Mpp_wl_productionsetupoperatorsesService.delete(row.mpp_wl_productionsetupoperatorsid);
        deletedCount += 1;
        onProgress?.('Removing old operators…', deletedCount, deleteTotal);
      },
      BULK_CONCURRENCY,
    );
  }

  // 4. Create new operators
  const createTotal = plan.operatorsToCreate.length;
  onProgress?.('Creating new operators…', 0, createTotal);
  const labelToId = new Map<string, string>();
  const createdOperators: ProductionOperator[] = [];
  let createdCount = 0;

  await runWithConcurrency(
    plan.operatorsToCreate,
    async (item) => {
      const res = await Mpp_wl_productionsetupoperatorsesService.create({
        mpp_productionsetupid: setup.id,
        mpp_name: item.label,
        statecode: 0,
      });
      if (res.success && res.data) {
        const id = res.data.mpp_wl_productionsetupoperatorsid;
        labelToId.set(item.label, id);
        createdOperators.push({ id, label: item.label });
      }
      createdCount += 1;
      onProgress?.('Creating new operators…', createdCount, createTotal);
    },
    BULK_CONCURRENCY,
  );

  // 5. Build preserved operators list
  const preservedOperators: ProductionOperator[] = setup.operators.filter((o) =>
    !deletedIdSet.has(o.id),
  );

  const allOperators = [...preservedOperators, ...createdOperators];
  allOperators.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));

  // 6. Map assignment patches with actual created operator IDs
  const resolveIds = (labels?: string[]) => {
    if (!labels || labels.length === 0) return undefined;
    const ids = labels.map((l) => labelToId.get(l) ?? l).filter(Boolean);
    return ids.length > 0 ? ids : undefined;
  };

  const changes: { machineId: string; patch: Partial<ProductionMachineAssignment> }[] = [];

  plan.machineAssignments.forEach((tempPatch, machineId) => {
    const finalPatch: Partial<ProductionMachineAssignment> = {};
    if ('assignedOperatorIds' in tempPatch) {
      finalPatch.assignedOperatorIds = resolveIds(tempPatch.assignedOperatorIds);
    }
    if ('doffingOperatorIds' in tempPatch) {
      finalPatch.doffingOperatorIds = resolveIds(tempPatch.doffingOperatorIds);
    }
    if ('loadingOperatorIds' in tempPatch) {
      finalPatch.loadingOperatorIds = resolveIds(tempPatch.loadingOperatorIds);
    }
    if ('fractureRepairingOperatorIds' in tempPatch) {
      finalPatch.fractureRepairingOperatorIds = resolveIds(tempPatch.fractureRepairingOperatorIds);
    }
    if ('diesChangeOperatorIds' in tempPatch) {
      finalPatch.diesChangeOperatorIds = resolveIds(tempPatch.diesChangeOperatorIds);
    }
    if ('defectRepairingOperatorIds' in tempPatch) {
      finalPatch.defectRepairingOperatorIds = resolveIds(tempPatch.defectRepairingOperatorIds);
    }
    changes.push({ machineId, patch: finalPatch });
  });

  // 7. Save machine assignments to Dataverse
  onProgress?.('Applying machine assignments…', 0, changes.length);
  await updateMachineAssignments(setup.id, changes, (done, total) => {
    onProgress?.('Applying machine assignments…', done, total);
  });

  // 8. Compute updated local assignments
  const changesByMachine = new Map(changes.map((c) => [c.machineId, c.patch]));
  const updatedAssignments = setup.assignments.map((assignment) => {
    const patch = changesByMachine.get(assignment.machineId);
    if (!patch) return assignment;
    return {
      ...assignment,
      ...patch,
    };
  });

  return {
    newOperators: allOperators,
    updatedAssignments,
  };
}
