import type { LayoutMachine, ProductionMachineAssignment, ProductionOperator, ProductionSetup } from '../types';
import { defaultAssignmentOrder } from './defaultAssignment';
import type { TheoreticalActivityBreakdown } from './theoreticalOperators';
import { Mpp_wl_productionsetupoperatorsesService } from '../generated/services/Mpp_wl_productionsetupoperatorsesService';
import { fetchAllPages, escapeODataString, runWithConcurrency } from './dataversePaging';
import { updateMachineAssignments } from './productionSetupsStore';

const BULK_CONCURRENCY = 8;

export type AutoAssignMode = 'multi' | 'split';

export type SplitPresetId = 'full_split' | 'two_groups' | 'three_groups' | 'custom';

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
    id: 'full_split',
    label: 'Full Split (5 Kelompok Terpisah - Rekomendasi)',
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
  operatorsToCreate: { label: string; groupKey?: string }[];
  machineAssignments: Map<string, Partial<ProductionMachineAssignment>>;
} {
  // 1. Order machines using facing Take-Up pairs order
  const orderedLayout = defaultAssignmentOrder(setup.layout, setup.movement?.pixelsPerMeter);
  const plannedMachineIds = new Set(
    setup.assignments.filter((a) => a.constructionDetailId).map((a) => a.machineId),
  );

  const targetMachines: LayoutMachine[] = options.onlyPlannedMachines !== false
    ? orderedLayout.filter((m) => plannedMachineIds.has(m.id))
    : orderedLayout;

  const operatorsToCreate: { label: string; groupKey?: string }[] = [];
  const machineAssignments = new Map<string, Partial<ProductionMachineAssignment>>();

  // Initialize all target machines in map
  targetMachines.forEach((m) => {
    machineAssignments.set(m.id, {});
  });

  if (options.mode === 'multi') {
    const rawReq = activityBreakdown?.allTask.operators;
    const count = options.multiCount ?? (rawReq ? Math.max(1, Math.ceil(rawReq)) : Math.max(1, setup.operators.length || 10));
    const prefix = options.multiPrefix?.trim() || 'Opr';

    const multiLabels = Array.from({ length: count }, (_, i) => `${prefix}_${String(i + 1).padStart(4, '0')}`);
    multiLabels.forEach((label) => operatorsToCreate.push({ label, groupKey: 'multi' }));

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
      : SPLIT_PRESETS[0].groups(activityBreakdown);

    // Build operators for each group
    const groupOperatorLabels = new Map<string, string[]>();

    groups.forEach((grp) => {
      const prefix = grp.prefix.trim() || 'Opr';
      const count = Math.max(1, grp.count);
      const labels = Array.from({ length: count }, (_, i) => `${prefix}_${String(i + 1).padStart(4, '0')}`);
      groupOperatorLabels.set(grp.id, labels);
      labels.forEach((label) => operatorsToCreate.push({ label, groupKey: grp.id }));

      // Partition machines for this group
      const total = targetMachines.length;
      targetMachines.forEach((m, index) => {
        const opIndex = Math.min(count - 1, Math.floor((index * count) / total));
        const opLabel = labels[opIndex];
        const existing = machineAssignments.get(m.id) || {};

        const patch: Partial<ProductionMachineAssignment> = {
          ...existing,
          assignedOperatorIds: undefined, // Clear multi task when doing split task
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
  }

  return { operatorsToCreate, machineAssignments };
}

/** Executes the full Auto Assign flow in Dataverse:
 * 1. Deletes old setup operators
 * 2. Creates newly generated operators
 * 3. Applies the facing TU machine assignments in batch with progress
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

  // 2. Fetch existing operators from Dataverse to delete them
  onProgress?.('Mengambil operator lama…', 0, 1);
  const oldOpRows = await fetchAllPages(Mpp_wl_productionsetupoperatorsesService.getAll, {
    filter: `mpp_productionsetupid eq '${escapeODataString(setup.id)}'`,
    select: ['mpp_wl_productionsetupoperatorsid'],
  });

  // 3. Delete old operators
  const deleteTotal = oldOpRows.length;
  if (deleteTotal > 0) {
    onProgress?.('Menghapus operator lama…', 0, deleteTotal);
    let deletedCount = 0;
    await runWithConcurrency(
      oldOpRows,
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

  // Sort created operators by label
  createdOperators.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));

  // 5. Map assignment patches with actual created operator IDs
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

  // 6. Save machine assignments to Dataverse
  onProgress?.('Menerapkan assignment mesin…', 0, changes.length);
  await updateMachineAssignments(setup.id, changes, (done, total) => {
    onProgress?.('Menerapkan assignment mesin…', done, total);
  });

  // 7. Compute updated local assignments
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
    newOperators: createdOperators,
    updatedAssignments,
  };
}
