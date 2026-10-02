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

/** Keeps planned workload routing identical to the production simulation. */
export function assignedOperatorIdForActivity(
  assignment: ProductionMachineAssignment | undefined,
  activity: ActivityKey,
): string | undefined {
  const family = activityFamily(activity);
  if (!family || !assignment) return undefined;
  if (family === 'doffing') return assignment.doffingOperatorId;
  if (family === 'loading') return assignment.loadingOperatorId;
  if (family === 'diesChange') return assignment.diesChangeOperatorId ?? assignment.fractureRepairingOperatorId;
  if (family === 'defectRepairing') return assignment.defectRepairingOperatorId ?? assignment.fractureRepairingOperatorId;
  return assignment.fractureRepairingOperatorId;
}

/** Every operator that works on this machine in either planning type (per-activity slots plus the
 * MachinesGroup pool), deduplicated. */
export function machineOperatorIds(assignment: ProductionMachineAssignment | undefined): string[] {
  if (!assignment) return [];
  return [
    ...new Set(
      [
        assignment.doffingOperatorId,
        assignment.loadingOperatorId,
        assignment.fractureRepairingOperatorId,
        assignment.diesChangeOperatorId,
        assignment.defectRepairingOperatorId,
        ...(assignment.assignedOperatorIds ?? []),
      ].filter((id): id is string => !!id),
    ),
  ];
}

export function isGroupMachine(assignment: ProductionMachineAssignment | undefined): boolean {
  return assignment?.planningType === 'MachinesGroup';
}

/** Who carries an activity's workload on this machine, and what fraction each carries — the whole
 * of it for the one dedicated operator, or an equal split across a MachinesGroup machine's pool. */
export function operatorSharesForActivity(
  assignment: ProductionMachineAssignment | undefined,
  activity: ActivityKey,
): { operatorId: string; share: number }[] {
  if (isGroupMachine(assignment)) {
    const pool = [...new Set(assignment?.assignedOperatorIds ?? [])];
    return pool.map((operatorId) => ({ operatorId, share: 1 / pool.length }));
  }
  const operatorId = assignedOperatorIdForActivity(assignment, activity);
  return operatorId ? [{ operatorId, share: 1 }] : [];
}
