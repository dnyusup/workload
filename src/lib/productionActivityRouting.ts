import type { ActivityKey, ProductionMachineAssignment } from '../types';

export type ProductionActivityFamily =
  | 'doffing'
  | 'loading'
  | 'fractureRepairing'
  | 'diesChange'
  | 'defectRepairing';

/** Maps resolved activity keys (including sub-activities) to the setup assignment slot. */
export function activityFamily(key: ActivityKey): ProductionActivityFamily | null {
  if (key === 'doffing' || key.startsWith('doffing-')) return 'doffing';
  if (key === 'loading' || key.startsWith('loading-')) return 'loading';
  if (key === 'fractureRepairing' || key.startsWith('fractureRepairing-')) return 'fractureRepairing';
  if (key === 'diesChange' || key.startsWith('diesChange-')) return 'diesChange';
  if (key === 'defectRepairing' || key.startsWith('defectRepairing-')) return 'defectRepairing';
  return null;
}

export type TaskOperatorField =
  | 'doffingOperatorIds'
  | 'loadingOperatorIds'
  | 'fractureRepairingOperatorIds'
  | 'diesChangeOperatorIds'
  | 'defectRepairingOperatorIds';

/** The Split Task operator list for each activity family. */
export const TASK_OPERATOR_FIELDS: Record<ProductionActivityFamily, TaskOperatorField> = {
  doffing: 'doffingOperatorIds',
  loading: 'loadingOperatorIds',
  fractureRepairing: 'fractureRepairingOperatorIds',
  diesChange: 'diesChangeOperatorIds',
  defectRepairing: 'defectRepairingOperatorIds',
};

/** Split Task operators of one family. Dies Change and Defect Repairing fall back to the Fracture
 * Repairing operators when they have none of their own, as setups made before those columns did. */
export function taskOperatorIds(assignment: ProductionMachineAssignment | undefined, family: ProductionActivityFamily): string[] {
  if (!assignment) return [];
  const own = assignment[TASK_OPERATOR_FIELDS[family]] ?? [];
  if (own.length > 0 || (family !== 'diesChange' && family !== 'defectRepairing')) return own;
  return assignment.fractureRepairingOperatorIds ?? [];
}

/** Everyone who may do this activity on this machine: its Multi Task operators plus that
 * activity's Split Task operators, deduplicated. Keeps planned workload routing identical to the
 * production simulation. */
export function eligibleOperatorIds(assignment: ProductionMachineAssignment | undefined, activity: ActivityKey): string[] {
  if (!assignment) return [];
  const family = activityFamily(activity);
  return [...new Set([...(assignment.assignedOperatorIds ?? []), ...(family ? taskOperatorIds(assignment, family) : [])])];
}

/** Every operator that works on this machine (Multi Task plus every Split Task list), deduplicated. */
export function machineOperatorIds(assignment: ProductionMachineAssignment | undefined): string[] {
  if (!assignment) return [];
  return [
    ...new Set([
      ...(assignment.assignedOperatorIds ?? []),
      ...Object.values(TASK_OPERATOR_FIELDS).flatMap((field) => assignment[field] ?? []),
    ]),
  ];
}

export const TASK_OPERATOR_LABELS: Record<ProductionActivityFamily, string> = {
  doffing: 'Doffing',
  loading: 'Loading',
  fractureRepairing: 'Fracture Repairing',
  diesChange: 'Dies Change',
  defectRepairing: 'Defect Repairing',
};

/** Tooltip lines for a machine's operators: its Multi Task operators, then each Split Task list
 * that has anyone ("—" when the machine has no operator at all). */
export function operatorAssignmentLines(assignment: ProductionMachineAssignment | undefined, labelOf: (id: string) => string): string[] {
  const names = (ids: string[] | undefined) => (ids ?? []).map(labelOf).join(', ');
  const lines = [
    ...(assignment?.assignedOperatorIds?.length ? [`Multi Task: ${names(assignment.assignedOperatorIds)}`] : []),
    ...(Object.keys(TASK_OPERATOR_FIELDS) as ProductionActivityFamily[])
      .filter((family) => assignment?.[TASK_OPERATOR_FIELDS[family]]?.length)
      .map((family) => `${TASK_OPERATOR_LABELS[family]}: ${names(assignment?.[TASK_OPERATOR_FIELDS[family]])}`),
  ];
  return lines.length > 0 ? lines : ['Operators: —'];
}

/** Who carries an activity's workload on this machine, and what fraction each carries — an equal
 * split across everyone who may do it. */
export function operatorSharesForActivity(
  assignment: ProductionMachineAssignment | undefined,
  activity: ActivityKey,
): { operatorId: string; share: number }[] {
  const operatorIds = eligibleOperatorIds(assignment, activity);
  return operatorIds.map((operatorId) => ({ operatorId, share: 1 / operatorIds.length }));
}
