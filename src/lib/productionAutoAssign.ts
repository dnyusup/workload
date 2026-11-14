import type { LayoutMachine, ProductionMachineAssignment, ProductionOperator, ProductionSetup } from '../types';
import { defaultAssignmentOrder, rowsOf } from './defaultAssignment';
import { DEFAULT_PIXELS_PER_METER } from './layoutConstants';
import type { TheoreticalActivityBreakdown, TheoreticalOperatorRow } from './theoreticalOperators';
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

  const maxIterations = 30;
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

    for (let i = 0; i < targetMachines.length; i++) {
      const mA = targetMachines[i];
      const opA = machineAssignments.get(mA.id)?.assignedOperatorIds?.[0];
      if (!opA) continue;
      const wA = machineWeightsMap.get(mA.id) ?? 1;

      for (let j = i + 1; j < targetMachines.length; j++) {
        const mB = targetMachines[j];
        const opB = machineAssignments.get(mB.id)?.assignedOperatorIds?.[0];
        if (!opB || opA === opB) continue;
        const wB = machineWeightsMap.get(mB.id) ?? 1;

        if (Math.abs(wA - wB) > maxWeightDiff) continue;

        const machsA = opMachines.get(opA);
        const machsB = opMachines.get(opB);
        if (!machsA || !machsB) continue;

        const newMachsA = machsA.filter((m) => m.id !== mA.id).concat([mB]);
        const newMachsB = machsB.filter((m) => m.id !== mB.id).concat([mA]);

        const costAOld = opCosts.get(opA) ?? 0;
        const costBOld = opCosts.get(opB) ?? 0;

        const costANew = computeOperatorSpatialCost(newMachsA, machinePosMap);
        const costBNew = computeOperatorSpatialCost(newMachsB, machinePosMap);

        const delta = (costAOld + costBOld) - (costANew + costBNew);
        if (delta > 50 && delta > bestDelta) {
          bestDelta = delta;
          bestSwap = { mA, mB, opA, opB };
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

  if (options.mode === 'multi') {
    const rawReq = activityBreakdown?.allTask.operators;
    const count = options.multiCount ?? (rawReq ? Math.max(1, Math.round(rawReq)) : Math.max(1, setup.operators.length || 10));
    const prefix = options.multiPrefix?.trim() || 'Opr';

    const multiLabels = Array.from({ length: count }, () => getNextLabel(prefix));
    multiLabels.forEach((label) => operatorsToCreate.push({ label, groupKey: 'multi', description: 'Multi Task' }));

    // 1. Build workload weight per machine to avoid "jomplang" man occupation across operators
    const cdWorkloadMap = new Map<string, number>();
    if (options.operatorRequirementRows && options.operatorRequirementRows.length > 0) {
      options.operatorRequirementRows.forEach((row) => {
        if (row.machines > 0 && row.operators > 0) {
          cdWorkloadMap.set(row.productId, row.operators / row.machines);
        } else if (row.machinesPerOperator > 0) {
          cdWorkloadMap.set(row.productId, 1 / row.machinesPerOperator);
        }
      });
    }

    const assignmentByMachine = new Map(setup.assignments.map((a) => [a.machineId, a]));

    const machineWeights = targetMachines.map((m) => {
      const cdId = assignmentByMachine.get(m.id)?.constructionDetailId;
      if (cdId && cdWorkloadMap.has(cdId)) {
        return Math.max(0.001, cdWorkloadMap.get(cdId)!);
      }
      return 1;
    });

    const totalWeight = machineWeights.reduce((sum, w) => sum + w, 0);

    // Distribute machines along the facing TU sequence proportionally by cumulative workload
    let cumulative = 0;
    targetMachines.forEach((m, index) => {
      const w = machineWeights[index];
      const midpoint = cumulative + w / 2;
      cumulative += w;

      const opIndex = Math.min(count - 1, Math.floor((midpoint / (totalWeight || 1)) * count));
      const opLabel = multiLabels[opIndex];
      machineAssignments.set(m.id, {
        assignedOperatorIds: [opLabel], // Temporary label, resolved to ID after creation
        doffingOperatorIds: undefined,
        loadingOperatorIds: undefined,
        fractureRepairingOperatorIds: undefined,
        diesChangeOperatorIds: undefined,
        defectRepairingOperatorIds: undefined,
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
  } else {
    // Split task mode
    const groups = options.taskGroups && options.taskGroups.length > 0
      ? options.taskGroups
      : (SPLIT_PRESETS.find((p) => p.id === options.splitPresetId) ?? SPLIT_PRESETS[0]).groups(activityBreakdown);

    const shouldBalance = options.balanceFractionalDemand !== false;

    if (!shouldBalance) {
      // Standard strict split (ceil per group, no cross-activity balancing)
      const groupOperatorLabels = new Map<string, string[]>();

      groups.forEach((grp) => {
        const prefix = grp.prefix.trim() || 'Opr';
        const count = Math.max(1, grp.count);
        const labels = Array.from({ length: count }, () => getNextLabel(prefix));
        groupOperatorLabels.set(grp.id, labels);
        labels.forEach((label) => operatorsToCreate.push({ label, groupKey: grp.id, description: grp.name }));

        // Partition machines for this group
        const total = targetMachines.length;
        targetMachines.forEach((m, index) => {
          const opIndex = Math.min(count - 1, Math.floor((index * count) / total));
          const opLabel = labels[opIndex];
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

        if (primaryOps.length > 0 && totalCapacityOfPrimaries >= g.req) {
          // Primary operators can absorb 100% of this group's machines
          const totalOps = primaryOps.length;
          targetMachines.forEach((m, idx) => {
            const opIdx = Math.min(totalOps - 1, Math.floor((idx * totalOps) / totalMachines));
            const op = primaryOps[opIdx];
            g.grp.tasks.forEach((t) => assignTask(m.id, t, op.label));
          });

          const loadPerOp = g.req / totalOps;
          primaryOps.forEach((op) => {
            op.assignedLoad += loadPerOp;
            op.capacityRemaining = Math.max(0, targetWorkloadPerOperator - op.assignedLoad);
          });
        } else if (primaryOps.length > 0) {
          // Primary operators take machines up to their full capacity
          const fraction = Math.min(1.0, totalCapacityOfPrimaries / g.req);
          const coveredMachineCount = Math.min(totalMachines, Math.max(primaryOps.length, Math.round(totalMachines * fraction)));

          const coveredMachines = targetMachines.slice(0, coveredMachineCount);
          const remainingMachines = targetMachines.slice(coveredMachineCount);

          const totalOps = primaryOps.length;
          coveredMachines.forEach((m, idx) => {
            const opIdx = Math.min(totalOps - 1, Math.floor((idx * totalOps) / coveredMachines.length));
            const op = primaryOps[opIdx];
            g.grp.tasks.forEach((t) => assignTask(m.id, t, op.label));
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
