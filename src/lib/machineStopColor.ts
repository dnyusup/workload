import type { ActivityKey } from '../types';

/** Color a stopped machine's donut takes on, based on which activities are pending together. */
export function stopColorFor(pendingActivities: ActivityKey[]): string {
  const has = new Set(pendingActivities);
  const doffing = has.has('doffing');
  const loading = has.has('loading');
  const fracture = has.has('fractureRepairing');

  if (doffing && loading && fracture) return '#dc2626'; // red — all three at once
  if (doffing && loading) return '#a855f7'; // purple
  if (doffing && fracture) return '#ec4899'; // pink
  if (loading && fracture) return '#eab308'; // gold
  if (fracture) return '#f97316'; // orange
  if (loading) return '#14b8a6'; // teal
  if (doffing) return '#3b82f6'; // blue
  return '#64748b'; // grey fallback
}

export const STOP_COLOR_LEGEND: { label: string; color: string }[] = [
  { label: 'Doffing', color: '#3b82f6' },
  { label: 'Loading', color: '#14b8a6' },
  { label: 'Fracture Repairing', color: '#f97316' },
  { label: 'Doffing + Loading', color: '#a855f7' },
  { label: 'Doffing + Fracture', color: '#ec4899' },
  { label: 'Loading + Fracture', color: '#eab308' },
  { label: 'Semua aktivitas', color: '#dc2626' },
];
