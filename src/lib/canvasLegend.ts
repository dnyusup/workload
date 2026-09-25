import type { ProductionMachineAssignment } from '../types';

export type LegendTab = 'construction' | 'operator';

export interface LegendEntry {
  id: string;
  label: string;
  color: string;
  /** How many machines this entry covers — shown next to the label. */
  count: number;
  /** Optional extra value shown before the count (e.g. an operator's man occupation). */
  detail?: string;
}

export type LegendHover = { tab: LegendTab; id: string } | null;

/** Legend id for the "nothing assigned" row on either tab. */
export const NO_ASSIGNMENT_LEGEND_ID = '__none__';

export interface CanvasLegendData {
  constructionEntries: LegendEntry[];
  operatorEntries: LegendEntry[];
  /** Machine ids to highlight for a hovered legend entry, or null when nothing is hovered. */
  highlightFor: (hover: LegendHover) => Set<string> | null;
}

/** Builds both legend tabs for a Production Setup canvas: which machines each Construction and
 * each operator (in any of its 5 task slots) covers, plus the "not assigned" rows — shared by the
 * Setup canvas and the Production Run canvas so both legends count and highlight identically. */
export function buildCanvasLegendData({
  machineIds,
  assignmentByMachineId,
  constructionColors,
  constructionLabel,
  operators,
  unassignedColor,
}: {
  machineIds: string[];
  assignmentByMachineId: Map<string, ProductionMachineAssignment>;
  /** Construction id → color, in legend order. */
  constructionColors: Map<string, string>;
  constructionLabel: (id: string) => string;
  operators: { id: string; label: string; color: string }[];
  unassignedColor: string;
}): CanvasLegendData {
  const byConstruction = new Map<string, string[]>();
  const byOperator = new Map<string, string[]>();
  const unplanned: string[] = [];
  const noOperator: string[] = [];
  const push = (map: Map<string, string[]>, key: string, id: string) => {
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
  };

  machineIds.forEach((machineId) => {
    const a = assignmentByMachineId.get(machineId);
    if (a?.constructionDetailId) push(byConstruction, a.constructionDetailId, machineId);
    else unplanned.push(machineId);
    const operatorIds = new Set(
      [a?.doffingOperatorId, a?.loadingOperatorId, a?.fractureRepairingOperatorId, a?.diesChangeOperatorId, a?.defectRepairingOperatorId].filter(
        (id): id is string => !!id,
      ),
    );
    if (operatorIds.size === 0) noOperator.push(machineId);
    operatorIds.forEach((id) => push(byOperator, id, machineId));
  });

  return {
    constructionEntries: [
      { id: NO_ASSIGNMENT_LEGEND_ID, label: 'Not planned', color: unassignedColor, count: unplanned.length },
      ...[...constructionColors].map(([id, color]) => ({
        id,
        label: constructionLabel(id),
        color,
        count: byConstruction.get(id)?.length ?? 0,
      })),
    ],
    operatorEntries: [
      { id: NO_ASSIGNMENT_LEGEND_ID, label: 'No operator assigned', color: unassignedColor, count: noOperator.length },
      ...operators.map((o) => ({ ...o, count: byOperator.get(o.id)?.length ?? 0 })),
    ],
    highlightFor: (hover) => {
      if (!hover) return null;
      if (hover.tab === 'construction') {
        return new Set(hover.id === NO_ASSIGNMENT_LEGEND_ID ? unplanned : byConstruction.get(hover.id) ?? []);
      }
      return new Set(hover.id === NO_ASSIGNMENT_LEGEND_ID ? noOperator : byOperator.get(hover.id) ?? []);
    },
  };
}
