import type { ProductionMachineAssignment, ProductionSetup, ProductionSimulationState } from '../types';
import type { ConstructionAttributes, ResolvedConstruction } from './productionConstructionResolver';
import { isFinishProductSpoolType } from './productType';
import { summarizeOperatorTimelines } from './operatorOccupation';

/** Production Report data layer: per-machine and per-operator facts derived from one simulation
 * snapshot, and their roll-up by any WL_Products column. Pure functions — no React. */

export type ReportDimension =
  | 'constructionDetail'
  | 'construction'
  | 'area'
  | 'machineCode'
  | 'product'
  | 'tensileGroup'
  | 'spoolType'
  | 'productType'
  | 'layLength'
  | 'spoolLength'
  | 'speed'
  | 'numberOfWires'
  | 'machine';

export const REPORT_DIMENSIONS: { key: ReportDimension; label: string }[] = [
  { key: 'constructionDetail', label: 'Construction Detail' },
  { key: 'construction', label: 'Construction' },
  { key: 'area', label: 'Area' },
  { key: 'machineCode', label: 'Mach' },
  { key: 'product', label: 'Product' },
  { key: 'tensileGroup', label: 'Tensile Group' },
  { key: 'spoolType', label: 'Spool Type' },
  { key: 'productType', label: 'FP / SFP' },
  { key: 'layLength', label: 'Lay Length' },
  { key: 'spoolLength', label: 'Spool Length' },
  { key: 'speed', label: 'Speed' },
  { key: 'numberOfWires', label: 'No. of Wires' },
  { key: 'machine', label: 'Machine' },
];

const NOT_SET = '(not set)';

export interface MachineFact {
  id: string;
  label: string;
  attributes: ConstructionAttributes | null;
  productType: 'FP' | 'SFP';
  plannedMin: number;
  runningMin: number;
  downtimeMin: number;
  /** Downtime minutes by reason LABEL (sub-activity keys from different Constructions merged). */
  downtimeByReason: Map<string, number>;
  spools: number;
  grossTonKg: number;
  operatorIds: string[];
}

export interface OperatorFact {
  id: string;
  label: string;
  walkingMin: number;
  serviceMin: number;
  idleMin: number;
  availableMin: number;
  occupation: number;
  machineIds: string[];
}

export interface ReportTotals {
  machines: number;
  plannedMin: number;
  runningMin: number;
  downtimeMin: number;
  availability: number;
  quality: number;
  oee: number;
  spools: number;
  grossTon: number;
  goodTon: number;
  rejectTon: number;
  goodTonFp: number;
  goodTonSfp: number;
  downtimeByReason: [string, number][];
  operators: number;
  avgOccupation: number;
  manhourPerTon: number;
}

export interface ReportGroup extends ReportTotals {
  key: string;
  label: string;
  machineIds: string[];
  topReason: string | null;
}

/** WL_Products attributes for a Construction, with every blank field filled from what else is
 * known: the Construction Detail code itself (Mach-Product-LayLength-TensileGroup-SpoolType-
 * SpoolLength-Speed, as built in WL_Products) and the construction's spec. Covers runs whose
 * Constructions were resolved without attributes, and rows with empty columns. */
function attributesFor(construction: ResolvedConstruction | undefined): ConstructionAttributes | null {
  if (!construction) return null;
  const given: Partial<ConstructionAttributes> = construction.attributes ?? {};
  const parts = (given.constructionDetail || construction.label || '').split('-').map((p) => p.trim());
  const parsed: Partial<ConstructionAttributes> =
    parts.length === 7
      ? {
          machineCode: parts[0],
          product: parts[1],
          layLength: parts[2],
          tensileGroup: parts[3],
          spoolType: parts[4],
          spoolLength: parts[5],
          speed: parts[6],
          construction: parts.slice(0, 5).join('-'),
        }
      : {};
  const spec = construction.spec;
  const pick = (key: keyof ConstructionAttributes, ...fallbacks: (string | number | undefined)[]) => {
    for (const value of [given[key], parsed[key], ...fallbacks]) {
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
    return '';
  };
  return {
    constructionDetail: pick('constructionDetail', construction.label),
    construction: pick('construction'),
    area: pick('area', spec?.area?.toUpperCase()),
    machineCode: pick('machineCode'),
    product: pick('product'),
    tensileGroup: pick('tensileGroup'),
    spoolType: pick('spoolType', construction.spoolType),
    layLength: pick('layLength', spec?.layLength),
    spoolLength: pick('spoolLength', spec?.spoolLength),
    speed: pick('speed', spec?.speed),
    numberOfWires: pick('numberOfWires', spec?.noOfWires),
  };
}

function operatorIdsOf(a: ProductionMachineAssignment | undefined): string[] {
  if (!a) return [];
  return [...new Set([a.doffingOperatorId, a.loadingOperatorId, a.fractureRepairingOperatorId, a.diesChangeOperatorId, a.defectRepairingOperatorId].filter((id): id is string => !!id))];
}

/** One fact row per machine that has a Construction assigned (unplanned machines never produce). */
export function buildMachineFacts(
  state: ProductionSimulationState,
  setup: ProductionSetup,
  resolved: Map<string, ResolvedConstruction>,
  activityLabel: (key: string) => string,
): MachineFact[] {
  const assignmentByMachine = new Map(setup.assignments.map((a) => [a.machineId, a]));
  const clock = Math.max(0, Math.min(state.metrics.clockMin, state.metrics.shiftTimeMin));
  const facts: MachineFact[] = [];
  state.machines.forEach((m) => {
    const assignment = assignmentByMachine.get(m.id);
    if (!assignment?.constructionDetailId || m.status === 'unassigned') return;
    const construction = resolved.get(assignment.constructionDetailId);
    let runningMin = 0;
    m.timeline.forEach((segment) => {
      if (segment.kind === 'running' || segment.kind.startsWith('running:')) {
        runningMin += Math.max(0, Math.min(segment.endMin, clock) - segment.startMin);
      }
    });
    const attributes = attributesFor(construction);
    const downtimeByReason = new Map<string, number>();
    Object.entries(m.downtimeByReason).forEach(([key, minutes]) => {
      if (minutes <= 0) return;
      const label = activityLabel(key);
      downtimeByReason.set(label, (downtimeByReason.get(label) ?? 0) + minutes);
    });
    facts.push({
      id: m.id,
      label: m.label,
      attributes,
      productType: isFinishProductSpoolType(attributes?.spoolType) ? 'FP' : 'SFP',
      plannedMin: clock,
      runningMin,
      downtimeMin: m.downtimeMin,
      downtimeByReason,
      spools: m.shiftSpoolsCompleted,
      grossTonKg: m.shiftSpoolsCompleted * Math.max(0, m.spoolWeight),
      operatorIds: operatorIdsOf(assignment),
    });
  });
  return facts;
}

export function buildOperatorFacts(
  state: ProductionSimulationState,
  setup: ProductionSetup,
  activityLabel: (key: string) => string,
): OperatorFact[] {
  const clock = Math.max(0, Math.min(state.metrics.clockMin, state.metrics.shiftTimeMin));
  const machinesByOperator = new Map<string, string[]>();
  setup.assignments.forEach((a) => {
    if (!a.constructionDetailId) return;
    operatorIdsOf(a).forEach((id) => {
      const list = machinesByOperator.get(id) ?? [];
      list.push(a.machineId);
      machinesByOperator.set(id, list);
    });
  });
  return state.operators
    .filter((op) => machinesByOperator.has(op.id))
    .map((op) => {
      const summary = summarizeOperatorTimelines([op], clock, activityLabel);
      return {
        id: op.id,
        label: op.label,
        walkingMin: summary.walking,
        serviceMin: summary.totalService,
        idleMin: summary.idle,
        availableMin: summary.elapsed,
        occupation: summary.utilization,
        machineIds: machinesByOperator.get(op.id) ?? [],
      };
    });
}

export function dimensionValue(fact: MachineFact, dimension: ReportDimension): string {
  if (dimension === 'machine') return fact.label;
  if (dimension === 'productType') return fact.productType;
  const value = fact.attributes?.[dimension];
  return value && value.trim() ? value : NOT_SET;
}

/** Totals over a set of machines (and the operators handling any of them). */
export function summarize(
  machines: MachineFact[],
  operators: OperatorFact[],
  quality: number,
  shiftHours: number,
): ReportTotals {
  let plannedMin = 0;
  let runningMin = 0;
  let downtimeMin = 0;
  let spools = 0;
  let grossKg = 0;
  let fpKg = 0;
  const reasons = new Map<string, number>();
  const machineIds = new Set<string>();
  machines.forEach((m) => {
    machineIds.add(m.id);
    plannedMin += m.plannedMin;
    runningMin += m.runningMin;
    downtimeMin += m.downtimeMin;
    spools += m.spools;
    grossKg += m.grossTonKg;
    if (m.productType === 'FP') fpKg += m.grossTonKg;
    m.downtimeByReason.forEach((minutes, reason) => reasons.set(reason, (reasons.get(reason) ?? 0) + minutes));
  });
  const involved = operators.filter((op) => op.machineIds.some((id) => machineIds.has(id)));
  const availability = plannedMin > 0 ? Math.max(0, Math.min(1, (plannedMin - downtimeMin) / plannedMin)) : 1;
  const grossTon = grossKg / 1000;
  const goodTon = grossTon * quality;
  const goodTonFp = (fpKg / 1000) * quality;
  return {
    machines: machines.length,
    plannedMin,
    runningMin,
    downtimeMin,
    availability,
    quality,
    oee: availability * quality,
    spools,
    grossTon,
    goodTon,
    rejectTon: grossTon - goodTon,
    goodTonFp,
    goodTonSfp: Math.max(0, goodTon - goodTonFp),
    downtimeByReason: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
    operators: involved.length,
    avgOccupation: involved.length > 0 ? involved.reduce((sum, op) => sum + op.occupation, 0) / involved.length : 0,
    manhourPerTon: goodTon > 0 ? (involved.length * shiftHours) / goodTon : 0,
  };
}

export function groupMachines(
  machines: MachineFact[],
  operators: OperatorFact[],
  dimension: ReportDimension,
  quality: number,
  shiftHours: number,
): ReportGroup[] {
  const byKey = new Map<string, MachineFact[]>();
  machines.forEach((m) => {
    const key = dimensionValue(m, dimension);
    const list = byKey.get(key);
    if (list) list.push(m);
    else byKey.set(key, [m]);
  });
  return [...byKey.entries()].map(([key, list]) => {
    const totals = summarize(list, operators, quality, shiftHours);
    return {
      ...totals,
      key,
      label: key,
      machineIds: list.map((m) => m.id),
      topReason: totals.downtimeByReason[0]?.[0] ?? null,
    };
  });
}
