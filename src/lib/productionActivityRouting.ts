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
