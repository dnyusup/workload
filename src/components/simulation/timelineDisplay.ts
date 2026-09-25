import type { MachineOrientation, MachineRuntimeState, MachineTimelineKind, OperatorTimelineKind, PendingTask } from '../../types';

export const ZONE_COLORS = {
  blue: '#2563eb',
  red: '#dc2626',
  orange: '#f97316',
  diesChange: '#e879f9',
  defectRepairing: '#facc15',
} as const;

/** Colors a machine's Pay Off / Take Up zone rectangles based on which activities are pending on
 * it — `activeTasks` are extra tasks currently being serviced (only relevant for the one machine
 * an operator is actively at, identified by `activeMachineId`), since those get spliced off
 * `pendingTasks` the moment servicing starts but should still show as "in progress" color. */
export function machineZoneColors(
  machine: Pick<MachineRuntimeState, 'id' | 'pendingTasks'>,
  activeTasks: PendingTask[],
  activeMachineId: string | null,
) {
  const tasks = machine.id === activeMachineId ? [...machine.pendingTasks, ...activeTasks] : machine.pendingTasks;
  const pending = new Set(tasks.map((task) => task.activity));
  const hasFracture = pending.has('fractureRepairing');
  const hasDiesChange = pending.has('diesChange');
  const hasDefectRepairing = pending.has('defectRepairing');
  const hasDoffing = pending.has('doffing');
  const hasLoading = pending.has('loading');
  const hasSubLoading = [...pending].some((key) => key.startsWith('loading-'));
  const colors = { payoff: null as string | null, takeup: null as string | null };

  if (hasFracture) {
    colors.takeup = ZONE_COLORS.orange;
  } else if (hasDiesChange) {
    colors.takeup = ZONE_COLORS.diesChange;
  } else if (hasDefectRepairing) {
    colors.takeup = ZONE_COLORS.defectRepairing;
  } else if (hasDoffing) {
    colors.takeup = ZONE_COLORS.blue;
  }
  if (hasLoading) {
    colors.payoff = ZONE_COLORS.red;
  } else if (hasSubLoading) {
    colors.payoff = ZONE_COLORS.orange;
  }
  return colors;
}

export function operatorFacing(
  label: string | null,
  operatorX: number,
  targetMachine: { x: number; orientation: MachineOrientation } | null,
): number {
  if (!label) return 0;
  if (label.endsWith('Take Up')) return targetMachine?.orientation === 'flipped' ? 180 : 0;
  if (label.endsWith('Pay Off')) return targetMachine?.orientation === 'flipped' ? 0 : 180;
  if (label.endsWith('Cradle') && targetMachine) return operatorX < targetMachine.x ? 90 : -90;
  return 0;
}

export function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

export const timelineKinds: { kind: OperatorTimelineKind; label: string; color: string }[] = [
  { kind: 'doffing', label: 'Doffing', color: '#38bdf8' },
  { kind: 'loading', label: 'Loading', color: '#a78bfa' },
  { kind: 'fractureRepairing', label: 'Fracture Repairing', color: '#f87171' },
  { kind: 'diesChange', label: 'Dies Change', color: ZONE_COLORS.diesChange },
  { kind: 'defectRepairing', label: 'Defect Repairing', color: ZONE_COLORS.defectRepairing },
  { kind: 'walking', label: 'Walking', color: '#fbbf24' },
  { kind: 'lunch', label: 'Lunch', color: '#64748b' },
  { kind: 'meeting', label: 'Meeting', color: '#94a3b8' },
  { kind: 'otherBreak', label: 'Other break', color: '#475569' },
  { kind: 'idle', label: 'Idle', color: '#334155' },
];

export const machineTimelineKinds: { kind: MachineTimelineKind; label: string; color: string }[] = [
  { kind: 'running', label: 'Running', color: '#22c55e' },
  { kind: 'doffing', label: 'Doffing', color: '#38bdf8' },
  { kind: 'loading', label: 'Loading', color: '#a78bfa' },
  { kind: 'fractureRepairing', label: 'Fracture Repairing', color: '#f87171' },
  { kind: 'diesChange', label: 'Dies Change', color: ZONE_COLORS.diesChange },
  { kind: 'defectRepairing', label: 'Defect Repairing', color: ZONE_COLORS.defectRepairing },
  { kind: 'waiting', label: 'Waiting to be handled', color: '#64748b' },
];

export function machineTimelineColor(kind: MachineTimelineKind): string {
  if (kind.startsWith('waiting:')) {
    return '#64748b';
  }
  if (kind.startsWith('running:')) {
    const activityKind = kind.slice('running:'.length);
    return `linear-gradient(to bottom, ${machineTimelineColor('running')} 50%, ${machineTimelineColor(activityKind)} 50%)`;
  }
  if (kind.startsWith('loading-')) {
    return '#c4b5fd';
  }
  if (kind.startsWith('doffing-')) {
    return '#7dd3fc';
  }
  if (kind.startsWith('fractureRepairing-')) {
    return '#fca5a5';
  }
  return machineTimelineKinds.find((item) => item.kind === kind)?.color ?? '#64748b';
}

export function machineTimelineLabel(kind: MachineTimelineKind, fallback: string) {
  if (kind.startsWith('waiting:')) return `Waiting ${fallback.replace(/^Waiting /, '')}`;
  if (kind.startsWith('running:')) return fallback || 'Running';
  return machineTimelineKinds.find((item) => item.kind === kind)?.label ?? fallback;
}

export interface TimelineSummaryGroup {
  key: string;
  label: string;
  color: string;
}

export interface TimelineSummary {
  /** Groups in display order: the base kinds first (always listed), then others as first seen. */
  groups: TimelineSummaryGroup[];
  minutesByKey: Map<string, number>;
}

type TimelineSegment = { kind: string; label: string; startMin: number; endMin: number };

// "Other break" only exists in Workload setups that add one — list it only once it occurs.
const OPERATOR_KIND_GROUPS: TimelineSummaryGroup[] = timelineKinds.map(({ kind, label, color }) => ({ key: kind, label, color }));
const OPERATOR_BASE_GROUPS: TimelineSummaryGroup[] = OPERATOR_KIND_GROUPS.filter((g) => g.key !== 'otherBreak');
const MACHINE_BASE_GROUPS: TimelineSummaryGroup[] = machineTimelineKinds.map(({ kind, label, color }) => ({ key: kind, label, color }));
const operatorBaseKinds = new Set<string>(timelineKinds.map((item) => item.kind));
const machineBaseKinds = new Set<string>(machineTimelineKinds.map((item) => item.kind));

/** Summary group for an operator segment. Sub-activity kinds are keyed per WL_Activities row, i.e.
 * per Construction (`doffing-sub-<row id>`), so "Doffing ScanMES" on 65 Constructions would be 65
 * separate kinds — group them by their display label instead. */
function operatorSegmentGroup(segment: TimelineSegment): TimelineSummaryGroup {
  if (operatorBaseKinds.has(segment.kind)) return OPERATOR_KIND_GROUPS.find((g) => g.key === segment.kind)!;
  const label = segment.label.split(' — ')[0];
  return { key: `label:${label}`, label, color: '#c084fc' };
}

/** Same as operatorSegmentGroup, for machine segments (incl. their "Running + …"/"Waiting …"
 * variants, whose labels are Construction-independent too). */
function machineSegmentGroup(segment: TimelineSegment): TimelineSummaryGroup {
  if (machineBaseKinds.has(segment.kind)) return MACHINE_BASE_GROUPS.find((g) => g.key === segment.kind)!;
  const label = machineTimelineLabel(segment.kind, segment.label);
  return { key: `label:${label}`, label, color: machineTimelineColor(segment.kind) };
}

/** Minutes per summary group across the given timelines, clamped to `durationMin` — one pass over
 * every segment (the old per-kind rescans were O(kinds² × segments) and froze the UI at ~1300
 * machines once Constructions multiplied the kinds). */
function summarizeTimelines(
  timelines: TimelineSegment[][],
  durationMin: number,
  baseGroups: TimelineSummaryGroup[],
  groupOf: (segment: TimelineSegment) => TimelineSummaryGroup,
): TimelineSummary {
  const groups = [...baseGroups];
  const seen = new Set(groups.map((g) => g.key));
  const minutesByKey = new Map<string, number>();
  // Group lookups repeat heavily (same kind + label on many segments) — resolve each once.
  const groupCache = new Map<string, TimelineSummaryGroup>();
  for (const timeline of timelines) {
    for (const segment of timeline) {
      const minutes = Math.max(0, Math.min(segment.endMin, durationMin) - segment.startMin);
      const cacheKey = `${segment.kind}\u0000${segment.label}`;
      let group = groupCache.get(cacheKey);
      if (!group) {
        group = groupOf(segment);
        groupCache.set(cacheKey, group);
      }
      if (!seen.has(group.key)) {
        seen.add(group.key);
        groups.push(group);
      }
      minutesByKey.set(group.key, (minutesByKey.get(group.key) ?? 0) + minutes);
    }
  }
  return { groups, minutesByKey };
}

export function summarizeOperatorTimelineGroups(timelines: TimelineSegment[][], durationMin: number): TimelineSummary {
  return summarizeTimelines(timelines, durationMin, OPERATOR_BASE_GROUPS, operatorSegmentGroup);
}

export function summarizeMachineTimelineGroups(timelines: TimelineSegment[][], durationMin: number): TimelineSummary {
  return summarizeTimelines(timelines, durationMin, MACHINE_BASE_GROUPS, machineSegmentGroup);
}
