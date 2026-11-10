import type { LayoutMachine, ProductionMachineAssignment, ProductionOperator, ProductionSetup } from '../types';
import { defaultAssignmentOrder } from './defaultAssignment';
import type { TheoreticalActivityBreakdown } from './theoreticalOperators';
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
  { key: 'doffing', label: 'Doffing', defaultPrefix: 'Doff' },
  { key: 'loading', label: 'Loading', defaultPrefix: 'Load' },
  { key: 'fractureRepairing', label: 'Fracture Repairing', defaultPrefix: 'Frac' },
  { key: 'diesChange', label: 'Dies Change', defaultPrefix: 'Dies' },
  { key: 'defectRepairing', label: 'Defect Repairing', defaultPrefix: 'Defect' },
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
    label: '3 Kelompok: Doffing, Loading, Fracture + Defect (Rekomendasi)',
    description: 'Doffing dan Loading dipisah masing-masing. Tugas teknis/perbaikan (Fracture, Defect, & Dies Change) digabung dalam 1 kelompok.',
    groups: (b) => {
      const getReq = (key: ActivityTaskKey) => {
        const item = b?.activities.find((a) => a.key === key);
        return item?.operators ? Math.max(1, Math.ceil(item.operators)) : 1;
      };
      const getSum = (keys: ActivityTaskKey[]) => {
        const sum = keys.reduce((acc, k) => {
          const item = b?.activities.find((a) => a.key === k);
          return acc + (item?.operators ?? 0);
        }, 0);
        return sum > 0 ? Math.max(1, Math.ceil(sum)) : 1;
      };
      return [
        { id: 'doffing', name: 'Doffing Operator', prefix: 'Doff', tasks: ['doffing'], count: getReq('doffing') },
        { id: 'loading', name: 'Loading Operator', prefix: 'Load', tasks: ['loading'], count: getReq('loading') },
        {
          id: 'repairs',
          name: 'Fracture + Defect Repairing',
          prefix: 'Repair',
          tasks: ['fractureRepairing', 'defectRepairing', 'diesChange'],
          count: getSum(['fractureRepairing', 'defectRepairing', 'diesChange']),
        },
      ];
    },
  },
  {
    id: 'full_split',
    label: 'Full Split (5 Kelompok Terpisah)',
    description: 'Setiap aktivitas (Doffing, Loading, Fracture, Dies, Defect) ditangani oleh pool operator terpisah.',
    groups: (b) => {
      const getReq = (key: ActivityTaskKey) => {
        const item = b?.activities.find((a) => a.key === key);
        return item?.operators ? Math.max(1, Math.ceil(item.operators)) : 1;
      };
      return [
        { id: 'doffing', name: 'Doffing Operator', prefix: 'Doff', tasks: ['doffing'], count: getReq('doffing') },
        { id: 'loading', name: 'Loading Operator', prefix: 'Load', tasks: ['loading'], count: getReq('loading') },
        { id: 'fractureRepairing', name: 'Fracture Repairing', prefix: 'Frac', tasks: ['fractureRepairing'], count: getReq('fractureRepairing') },
        { id: 'diesChange', name: 'Dies Change', prefix: 'Dies', tasks: ['diesChange'], count: getReq('diesChange') },
        { id: 'defectRepairing', name: 'Defect Repairing', prefix: 'Defect', tasks: ['defectRepairing'], count: getReq('defectRepairing') },
      ];
    },
  },
  {
    id: 'two_groups',
    label: '2 Kelompok: Material Handling vs Technical / Quality',
    description: 'Doffing & Loading digabung (penanganan bobbin/spool fisik). Fracture, Defect & Dies digabung (penanganan mutu & teknis).',
    groups: (b) => {
      const getSum = (keys: ActivityTaskKey[]) => {
        const sum = keys.reduce((acc, k) => {
          const item = b?.activities.find((a) => a.key === k);
          return acc + (item?.operators ?? 0);
        }, 0);
        return sum > 0 ? Math.max(1, Math.ceil(sum)) : 1;
      };
      return [
        {
          id: 'material',
          name: 'Material Handling (Doffing + Loading)',
          prefix: 'Mat',
          tasks: ['doffing', 'loading'],
          count: getSum(['doffing', 'loading']),
        },
        {
          id: 'repairs',
          name: 'Technical Repairs (Fracture + Defect + Dies)',
          prefix: 'Rep',
          tasks: ['fractureRepairing', 'defectRepairing', 'diesChange'],
          count: getSum(['fractureRepairing', 'defectRepairing', 'diesChange']),
        },
      ];
    },
  },
  {
    id: 'three_groups',
    label: '3 Kelompok: Material, Repairs, Dies Specialist',
    description: 'Doffing + Loading (Material), Fracture + Defect (Breaks/Defects), dan Dies Change (Tooling mandiri).',
    groups: (b) => {
      const getSum = (keys: ActivityTaskKey[]) => {
        const sum = keys.reduce((acc, k) => {
          const item = b?.activities.find((a) => a.key === k);
          return acc + (item?.operators ?? 0);
        }, 0);
        return sum > 0 ? Math.max(1, Math.ceil(sum)) : 1;
      };
      const diesReq = b?.activities.find((a) => a.key === 'diesChange')?.operators;
      return [
        {
          id: 'material',
          name: 'Material Handling (Doffing + Loading)',
          prefix: 'Mat',
          tasks: ['doffing', 'loading'],
          count: getSum(['doffing', 'loading']),
        },
        {
          id: 'repairs',
          name: 'Break & Defect (Fracture + Defect)',
          prefix: 'Rep',
          tasks: ['fractureRepairing', 'defectRepairing'],
          count: getSum(['fractureRepairing', 'defectRepairing']),
        },
        {
          id: 'dies',
          name: 'Dies Specialist',
          prefix: 'Dies',
          tasks: ['diesChange'],
          count: diesReq ? Math.max(1, Math.ceil(diesReq)) : 1,
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
  // 1. Order machines using facing Take-Up pairs order
  const orderedLayout = defaultAssignmentOrder(setup.layout, setup.movement?.pixelsPerMeter);
  const targetIdSet = options.targetMachineIds && options.targetMachineIds.length > 0
    ? new Set(options.targetMachineIds)
    : null;

  const plannedMachineIds = new Set(
    setup.assignments.filter((a) => a.constructionDetailId).map((a) => a.machineId),
  );

  let targetMachines: LayoutMachine[] = orderedLayout;
  if (targetIdSet) {
    targetMachines = targetMachines.filter((m) => targetIdSet.has(m.id));
  }
  if (options.onlyPlannedMachines !== false) {
    targetMachines = targetMachines.filter((m) => plannedMachineIds.has(m.id));
  }

  const operatorsToCreate: { label: string; groupKey?: string; description?: string }[] = [];
  const machineAssignments = new Map<string, Partial<ProductionMachineAssignment>>();

  // Initialize all target machines in map
  targetMachines.forEach((m) => {
    machineAssignments.set(m.id, {});
  });

  if (targetMachines.length === 0) {
    return { operatorsToCreate, machineAssignments };
  }

  if (options.mode === 'multi') {
    const rawReq = activityBreakdown?.allTask.operators;
    const count = options.multiCount ?? (rawReq ? Math.max(1, Math.ceil(rawReq)) : Math.max(1, setup.operators.length || 10));
    const prefix = options.multiPrefix?.trim() || 'Opr';

    const multiLabels = Array.from({ length: count }, (_, i) => `${prefix}_${String(i + 1).padStart(4, '0')}`);
    multiLabels.forEach((label) => operatorsToCreate.push({ label, groupKey: 'multi', description: 'Multi Task' }));

    // Distribute machines evenly in facing TU order
    const total = targetMachines.length;
    targetMachines.forEach((m, index) => {
      const opIndex = Math.min(count - 1, Math.floor((index * count) / total));
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
        const labels = Array.from({ length: count }, (_, i) => `${prefix}_${String(i + 1).padStart(4, '0')}`);
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
      const targetTotal = options.splitTotalCount ?? Math.max(1, Math.ceil(totalDemand));
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

      // 3. Create operator instances
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
          const label = `${g.prefix}_${String(i + 1).padStart(4, '0')}`;
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
          // Find operators with remaining capacity
          const helpers = operatorInstances
            .filter((op) => op.capacityRemaining > 0.001)
            .sort((a, b) => b.capacityRemaining - a.capacityRemaining);

          if (helpers.length === 0) {
            // All operators full: assign the rest to the operator with the lowest assigned load
            const fallbackOp = [...operatorInstances].sort((a, b) => a.assignedLoad - b.assignedLoad)[0];
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
        const defaultOpLabel = operatorInstances.find((op) => op.primaryGroupId === g.grp.id)?.label
          ?? operatorInstances[0]?.label;

        if (defaultOpLabel) {
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
                assignTask(m.id, t, defaultOpLabel);
              }
            });
          });
        }
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
  onProgress?.('Mengambil operator lama…', 0, 1);
  const oldOpRows = await fetchAllPages(Mpp_wl_productionsetupoperatorsesService.getAll, {
    filter: `mpp_productionsetupid eq '${escapeODataString(setup.id)}'`,
    select: ['mpp_wl_productionsetupoperatorsid', 'mpp_name'],
  });

  // Find operators that MUST be preserved because they are used on machines OUTSIDE targetMachineIds
  const preservedOperatorIds = new Set<string>();
  if (targetIdSet) {
    setup.assignments.forEach((a) => {
      if (!targetIdSet.has(a.machineId)) {
        a.assignedOperatorIds?.forEach((id) => preservedOperatorIds.add(id));
        a.doffingOperatorIds?.forEach((id) => preservedOperatorIds.add(id));
        a.loadingOperatorIds?.forEach((id) => preservedOperatorIds.add(id));
        a.fractureRepairingOperatorIds?.forEach((id) => preservedOperatorIds.add(id));
        a.diesChangeOperatorIds?.forEach((id) => preservedOperatorIds.add(id));
        a.defectRepairingOperatorIds?.forEach((id) => preservedOperatorIds.add(id));
      }
    });
  }

  // 3. Operators to delete:
  // If whole setup: delete all old operators.
  // If subset: only delete operators that are NOT used on other machines.
  const operatorsToDelete = targetIdSet
    ? oldOpRows.filter((row) => !preservedOperatorIds.has(row.mpp_wl_productionsetupoperatorsid))
    : oldOpRows;

  const deleteTotal = operatorsToDelete.length;
  if (deleteTotal > 0) {
    onProgress?.('Menghapus operator lama…', 0, deleteTotal);
    let deletedCount = 0;
    await runWithConcurrency(
      operatorsToDelete,
      async (row) => {
        await Mpp_wl_productionsetupoperatorsesService.delete(row.mpp_wl_productionsetupoperatorsid);
        deletedCount += 1;
        onProgress?.('Menghapus operator lama…', deletedCount, deleteTotal);
      },
      BULK_CONCURRENCY,
    );
  }

  // 4. Create new operators
  const createTotal = plan.operatorsToCreate.length;
  onProgress?.('Membuat operator baru…', 0, createTotal);
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
      onProgress?.('Membuat operator baru…', createdCount, createTotal);
    },
    BULK_CONCURRENCY,
  );

  // 5. Build preserved operators list
  const preservedOperators: ProductionOperator[] = setup.operators.filter((o) =>
    preservedOperatorIds.has(o.id),
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
  onProgress?.('Menerapkan assignment mesin…', 0, changes.length);
  await updateMachineAssignments(setup.id, changes, (done, total) => {
    onProgress?.('Menerapkan assignment mesin…', done, total);
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
