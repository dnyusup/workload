import type { ProductionMachineAssignment } from '../../types';

export const DOFF_PRIORITY_TOOLTIP =
  'Yes: when another machine needs Doffing while the operator still has at least "Min Remain Task" minutes of the current visit left, the operator pauses it, does the waiting Doffings first (by Task Priority), then picks again by Task Priority — the paused work counting only its remaining time.';

/** A machine's own Doff Priority for tables and tooltips; "—" = follows the setup. */
export function doffPriorityText(a: Pick<ProductionMachineAssignment, 'doffPriority' | 'minRemainForDoffPriority'> | undefined): string {
  if (a?.doffPriority === undefined && a?.minRemainForDoffPriority === undefined) return '—';
  const flag = a?.doffPriority === undefined ? 'Setup' : a.doffPriority ? 'Yes' : 'No';
  return a?.minRemainForDoffPriority === undefined ? flag : `${flag} · ${a.minRemainForDoffPriority} min`;
}
