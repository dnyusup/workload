import type { LayoutMachine, OperatorStartPoint, ProductionMachineAssignment, ProductionOperator, ProductionSetup, TaskPriorityMode } from '../types';
import { Mpp_wl_productionsetupsesService } from '../generated/services/Mpp_wl_productionsetupsesService';
import { Mpp_wl_productionsetupoperatorsesService } from '../generated/services/Mpp_wl_productionsetupoperatorsesService';
import { Mpp_wl_productionsetupmachinesesService } from '../generated/services/Mpp_wl_productionsetupmachinesesService';
import type { Mpp_wl_productionsetupmachineses } from '../generated/models/Mpp_wl_productionsetupmachinesesModel';
import { fetchAllPages, escapeODataString, runWithConcurrency } from './dataversePaging';
import { parseLayoutBlob, serializeLayoutBlob } from './savedLayoutsStore';

/** How many Dataverse requests to keep in flight at once for bulk create/update/delete loops
 * (one row per machine) — high enough to meaningfully cut wall-clock time versus fully
 * sequential, conservative enough to avoid tripping Dataverse's per-connection throttling. */
const BULK_CONCURRENCY = 8;

export interface ProductionSetupSummary {
  id: string;
  name: string;
  operatorCount: number;
  machineCount: number;
  updatedAt: number;
  createdAt: number;
  /** Who created this setup, by email — stamped from the signed-in user at creation time
   * (mpp_creator_email). Primary ownership key (Contribute only sees/deletes their own); falls
   * back to `createdByName` for setups created before this column existed. */
  createdByEmail: string;
  /** Dataverse's own `createdbyname` — always populated, used for display and as the ownership
   * fallback when `createdByEmail` is empty (pre-existing setups). */
  createdByName: string;
}

/** machineId (LayoutMachine.id, plain text on the row) → that row's own Dataverse id — needed
 * because every assignment update/delete has to address the WL_ProductionSetupMachines row by
 * ITS id, not the machineId text field. Populated on load/create and kept in sync locally so
 * routine assignment edits never have to re-query Dataverse just to find the row to update. */
const machineRowIdCache = new Map<string, Map<string, string>>();

function machineRowToAssignment(row: Mpp_wl_productionsetupmachineses, constructionLabelById: Map<string, string>): ProductionMachineAssignment {
  return {
    machineId: row.mpp_machineid,
    constructionDetailId: row.mpp_constructiondetailid ?? undefined,
    constructionDetailLabel: row.mpp_constructiondetailid ? constructionLabelById.get(row.mpp_constructiondetailid) : undefined,
    doffingOperatorId: row.mpp_doffingoperatorid ?? undefined,
    loadingOperatorId: row.mpp_loadingoperatorid ?? undefined,
    fractureRepairingOperatorId: row.mpp_fracturerepairingoperatorid ?? undefined,
  };
}

/** Lightweight list for the setup picker — two queries total (all operator rows, all machine rows
 * with only the columns needed to count/group), regardless of how many setups exist, instead of
 * querying per-setup counts (which would be N+1 requests). */
export async function listProductionSetupSummaries(): Promise<ProductionSetupSummary[]> {
  const [headers, operatorRows, machineRows] = await Promise.all([
    fetchAllPages(Mpp_wl_productionsetupsesService.getAll, { orderBy: ['mpp_name asc'] }),
    fetchAllPages(Mpp_wl_productionsetupoperatorsesService.getAll, {
      select: ['mpp_wl_productionsetupoperatorsid', 'mpp_productionsetupid'],
    }),
    fetchAllPages(Mpp_wl_productionsetupmachinesesService.getAll, {
      select: ['mpp_wl_productionsetupmachinesid', 'mpp_productionsetupid'],
    }),
  ]);
  const operatorCounts = new Map<string, number>();
  operatorRows.forEach((row) => {
    if (!row.mpp_productionsetupid) return;
    operatorCounts.set(row.mpp_productionsetupid, (operatorCounts.get(row.mpp_productionsetupid) ?? 0) + 1);
  });
  const machineCounts = new Map<string, number>();
  machineRows.forEach((row) => {
    if (!row.mpp_productionsetupid) return;
    machineCounts.set(row.mpp_productionsetupid, (machineCounts.get(row.mpp_productionsetupid) ?? 0) + 1);
  });
  return headers.map((row) => ({
    id: row.mpp_wl_productionsetupsid,
    name: row.mpp_name,
    operatorCount: operatorCounts.get(row.mpp_wl_productionsetupsid) ?? 0,
    machineCount: machineCounts.get(row.mpp_wl_productionsetupsid) ?? 0,
    updatedAt: row.modifiedon ? new Date(row.modifiedon).getTime() : Date.now(),
    createdAt: row.createdon ? new Date(row.createdon).getTime() : Date.now(),
    createdByEmail: row.mpp_creator_email ?? '',
    createdByName: row.createdbyname ?? '',
  }));
}

/** Full load of one setup (header + every operator + every machine assignment row) — used once a
 * setup is actually selected for editing, never for the list view (see listProductionSetupSummaries). */
export async function loadProductionSetup(id: string, constructionLabelById: Map<string, string>): Promise<ProductionSetup> {
  const [headerResult, operatorRows, machineRows] = await Promise.all([
    Mpp_wl_productionsetupsesService.get(id),
    fetchAllPages(Mpp_wl_productionsetupoperatorsesService.getAll, {
      filter: `mpp_productionsetupid eq '${escapeODataString(id)}'`,
      orderBy: ['mpp_name asc'],
    }),
    fetchAllPages(Mpp_wl_productionsetupmachinesesService.getAll, {
      filter: `mpp_productionsetupid eq '${escapeODataString(id)}'`,
    }),
  ]);
  if (!headerResult.success || !headerResult.data) throw new Error(headerResult.error?.message ?? 'Production Setup not found.');
  const header = headerResult.data;

  const rowIdByMachineId = new Map<string, string>();
  machineRows.forEach((row) => rowIdByMachineId.set(row.mpp_machineid, row.mpp_wl_productionsetupmachinesid));
  machineRowIdCache.set(id, rowIdByMachineId);

  const { machines: layout, operatorStart } = parseLayoutBlob(header.mpp_layoutsnapshotjson);
  const operators: ProductionOperator[] = operatorRows.map((row) => ({ id: row.mpp_wl_productionsetupoperatorsid, label: row.mpp_name }));
  const assignmentByMachineId = new Map(machineRows.map((row) => [row.mpp_machineid, machineRowToAssignment(row, constructionLabelById)]));
  // Every machine in the layout snapshot gets an assignment entry even if its Dataverse row
  // somehow went missing, so the UI never has to null-check `assignments.find(...)`.
  const assignments: ProductionMachineAssignment[] = layout.map((m) => assignmentByMachineId.get(m.id) ?? { machineId: m.id });

  return {
    id,
    name: header.mpp_name,
    layout,
    operatorStart,
    operators,
    assignments,
    shiftTime: header.mpp_shifttime ?? 480,
    lunchTime: header.mpp_lunchtime ?? 30,
    lunchStartAt: header.mpp_lunchstartat ?? 240,
    meetingTime: header.mpp_meetingtime ?? 15,
    meetingStartAt: header.mpp_meetingstartat ?? 420,
    taskPriority: (header.mpp_taskpriority as TaskPriorityMode) ?? 'quickest',
    movement: { walkingSpeed: header.mpp_walkingspeed ?? 60, pixelsPerMeter: header.mpp_pixelspermeter ?? 20 },
    updatedAt: header.modifiedon ? new Date(header.modifiedon).getTime() : Date.now(),
  };
}

/** Creates the header row, then one WL_ProductionSetupMachines row per machine in the source
 * Layout — the generated Dataverse client has no batch-create endpoint, so this is one HTTP call
 * per machine (run with limited concurrency, see BULK_CONCURRENCY) rather than a single request;
 * still takes a while for a large layout (~1500 machines), hence `onProgress`. */
export async function createProductionSetup(
  name: string,
  layout: LayoutMachine[],
  onProgress?: (done: number, total: number) => void,
  creatorEmail = '',
  operatorStart?: OperatorStartPoint,
): Promise<ProductionSetup> {
  const headerResult = await Mpp_wl_productionsetupsesService.create({
    mpp_name: name,
    mpp_layoutsnapshotjson: serializeLayoutBlob(layout, operatorStart),
    mpp_creator_email: creatorEmail,
    mpp_shifttime: 480,
    mpp_lunchtime: 30,
    mpp_lunchstartat: 240,
    mpp_meetingtime: 15,
    mpp_meetingstartat: 420,
    mpp_taskpriority: 'quickest',
    mpp_walkingspeed: 60,
    mpp_pixelspermeter: 20,
    // Active state, matching WL_Layouts' `0 | 1` statecode enum.
    statecode: 0,
  });
  if (!headerResult.success || !headerResult.data) throw new Error(headerResult.error?.message ?? 'Failed to create Production Setup.');
  const setupId = headerResult.data.mpp_wl_productionsetupsid;

  const rowIdByMachineId = new Map<string, string>();
  await runWithConcurrency(
    layout,
    async (machine) => {
      const result = await Mpp_wl_productionsetupmachinesesService.create({
        mpp_productionsetupid: setupId,
        mpp_machineid: machine.id,
        mpp_machinelabel: machine.label,
        statecode: 0,
      });
      if (result.success && result.data) rowIdByMachineId.set(machine.id, result.data.mpp_wl_productionsetupmachinesid);
    },
    BULK_CONCURRENCY,
    onProgress,
  );
  machineRowIdCache.set(setupId, rowIdByMachineId);

  return {
    id: setupId,
    name,
    layout,
    operatorStart,
    operators: [],
    assignments: layout.map((m) => ({ machineId: m.id })),
    shiftTime: 480,
    lunchTime: 30,
    lunchStartAt: 240,
    meetingTime: 15,
    meetingStartAt: 420,
    taskPriority: 'quickest',
    movement: { walkingSpeed: 60, pixelsPerMeter: 20 },
    updatedAt: Date.now(),
  };
}

export async function updateProductionSetupHeader(
  id: string,
  patch: Partial<
    Pick<
      ProductionSetup,
      'name' | 'shiftTime' | 'lunchTime' | 'lunchStartAt' | 'meetingTime' | 'meetingStartAt' | 'taskPriority' | 'movement'
    >
  >,
): Promise<void> {
  const fields: Record<string, string | number> = {};
  if (patch.name !== undefined) fields.mpp_name = patch.name;
  if (patch.shiftTime !== undefined) fields.mpp_shifttime = patch.shiftTime;
  if (patch.lunchTime !== undefined) fields.mpp_lunchtime = patch.lunchTime;
  if (patch.lunchStartAt !== undefined) fields.mpp_lunchstartat = patch.lunchStartAt;
  if (patch.meetingTime !== undefined) fields.mpp_meetingtime = patch.meetingTime;
  if (patch.meetingStartAt !== undefined) fields.mpp_meetingstartat = patch.meetingStartAt;
  if (patch.taskPriority !== undefined) fields.mpp_taskpriority = patch.taskPriority;
  if (patch.movement !== undefined) {
    fields.mpp_walkingspeed = patch.movement.walkingSpeed;
    fields.mpp_pixelspermeter = patch.movement.pixelsPerMeter;
  }
  if (Object.keys(fields).length === 0) return;
  const result = await Mpp_wl_productionsetupsesService.update(id, fields);
  if (!result.success) throw new Error(result.error?.message ?? 'Failed to update Production Setup.');
}

export async function deleteProductionSetup(id: string, onProgress?: (done: number, total: number) => void): Promise<void> {
  const [operatorRows, machineRows] = await Promise.all([
    fetchAllPages(Mpp_wl_productionsetupoperatorsesService.getAll, {
      filter: `mpp_productionsetupid eq '${escapeODataString(id)}'`,
      select: ['mpp_wl_productionsetupoperatorsid'],
    }),
    fetchAllPages(Mpp_wl_productionsetupmachinesesService.getAll, {
      filter: `mpp_productionsetupid eq '${escapeODataString(id)}'`,
      select: ['mpp_wl_productionsetupmachinesid'],
    }),
  ]);
  // Children first — deleting the header while rows still point at it would either fail (a
  // restrict-delete relationship) or leave orphaned rows behind. Machine rows are almost always
  // the bulk of the work (one per machine), so they drive the progress total; operator rows are
  // few and just folded in afterwards without their own progress step.
  const total = machineRows.length;
  await runWithConcurrency(
    machineRows,
    async (row) => {
      await Mpp_wl_productionsetupmachinesesService.delete(row.mpp_wl_productionsetupmachinesid);
    },
    BULK_CONCURRENCY,
    onProgress ? (done) => onProgress(done, total) : undefined,
  );
  await runWithConcurrency(
    operatorRows,
    async (row) => {
      await Mpp_wl_productionsetupoperatorsesService.delete(row.mpp_wl_productionsetupoperatorsid);
    },
    BULK_CONCURRENCY,
  );
  await Mpp_wl_productionsetupsesService.delete(id);
  machineRowIdCache.delete(id);
}

export async function addProductionOperator(setupId: string, label: string): Promise<ProductionOperator> {
  const result = await Mpp_wl_productionsetupoperatorsesService.create({
    mpp_productionsetupid: setupId,
    mpp_name: label,
    statecode: 0,
  });
  if (!result.success || !result.data) throw new Error(result.error?.message ?? 'Failed to add operator.');
  return { id: result.data.mpp_wl_productionsetupoperatorsid, label };
}

export async function renameProductionOperator(operatorId: string, label: string): Promise<void> {
  const result = await Mpp_wl_productionsetupoperatorsesService.update(operatorId, { mpp_name: label });
  if (!result.success) throw new Error(result.error?.message ?? 'Failed to rename operator.');
}

/** Removing an operator also has to clear it out of every machine row that still references it —
 * a lookup left pointing at a deleted record is exactly the kind of dangling reference Dataverse
 * relationships are meant to prevent, so this clears first and deletes the operator row second. */
export async function removeProductionOperator(setupId: string, operatorId: string): Promise<void> {
  const machineRows = await fetchAllPages(Mpp_wl_productionsetupmachinesesService.getAll, {
    filter: `mpp_productionsetupid eq '${escapeODataString(setupId)}' and (mpp_doffingoperatorid eq '${escapeODataString(operatorId)}' or mpp_loadingoperatorid eq '${escapeODataString(operatorId)}' or mpp_fracturerepairingoperatorid eq '${escapeODataString(operatorId)}')`,
  });
  await runWithConcurrency(
    machineRows,
    async (row) => {
      const fields: Record<string, null> = {};
      if (row.mpp_doffingoperatorid === operatorId) fields.mpp_doffingoperatorid = null;
      if (row.mpp_loadingoperatorid === operatorId) fields.mpp_loadingoperatorid = null;
      if (row.mpp_fracturerepairingoperatorid === operatorId) fields.mpp_fracturerepairingoperatorid = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await Mpp_wl_productionsetupmachinesesService.update(row.mpp_wl_productionsetupmachinesid, fields as any);
    },
    BULK_CONCURRENCY,
  );
  await Mpp_wl_productionsetupoperatorsesService.delete(operatorId);
}

/** Applies a bulk "Assign Selection" action (Construction / Doffing / Loading / Fracture
 * Repairing / Unplan) or a CSV re-import — one Dataverse call per changed machine row, run with
 * limited concurrency (see BULK_CONCURRENCY) rather than fully sequential. */
export async function updateMachineAssignments(
  setupId: string,
  changes: { machineId: string; patch: Partial<ProductionMachineAssignment> }[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const rowIdByMachineId = machineRowIdCache.get(setupId);
  await runWithConcurrency(
    changes,
    async ({ machineId, patch }) => {
      const rowId = rowIdByMachineId?.get(machineId);
      if (!rowId) return;
      const fields: Record<string, string | null> = {};
      if ('constructionDetailId' in patch) fields.mpp_constructiondetailid = patch.constructionDetailId ?? null;
      if ('doffingOperatorId' in patch) fields.mpp_doffingoperatorid = patch.doffingOperatorId ?? null;
      if ('loadingOperatorId' in patch) fields.mpp_loadingoperatorid = patch.loadingOperatorId ?? null;
      if ('fractureRepairingOperatorId' in patch) fields.mpp_fracturerepairingoperatorid = patch.fractureRepairingOperatorId ?? null;
      if (Object.keys(fields).length === 0) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await Mpp_wl_productionsetupmachinesesService.update(rowId, fields as any);
    },
    BULK_CONCURRENCY,
    onProgress,
  );
}
