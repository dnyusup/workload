import type { Mpp_wl_activities } from '../generated/models/Mpp_wl_activitiesModel';
import { Mpp_wl_activitiesmpp_taskname } from '../generated/models/Mpp_wl_activitiesModel';
import type { Mpp_wl_productses } from '../generated/models/Mpp_wl_productsesModel';
import type { ActivityConfig, MachCondition, MachineSpecInput } from '../types';
import { fractureRepairingDenominator } from './calculations';

const WEIGHT_LOADING_AREAS = ['WW', 'BA', 'CA', 'IS', 'IP'];
const DIES_CHANGE_AREAS = ['WW', 'BA', 'CA'];
const DEFECT_REPAIRING_AREAS = ['CB', 'BU', 'SP', 'CH', 'CR'];

const TASK_KEY_BY_LABEL: Record<string, string> = {
  Doffing: 'doffing',
  Loading: 'loading',
  FractureRepairing: 'fractureRepairing',
  DiesChange: 'diesChange',
  DefectRepairing: 'defectRepairing',
};

const TASK_ORDER = ['Doffing', 'Loading', 'FractureRepairing', 'DiesChange', 'DefectRepairing'] as const;

function parseNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function parseMachCondition(value: string | undefined): MachCondition {
  return (value ?? '').trim().toLowerCase() === 'run' ? 'run' : 'stop';
}

function taskLabelText(row: Mpp_wl_activities): string {
  if (row.mpp_taskname != null) {
    const label = Mpp_wl_activitiesmpp_taskname[row.mpp_taskname];
    if (label) return label;
  }
  return row.mpp_tasknamename ?? '';
}

/** WL_Products holds one row per Construction Detail — its columns fill the Machine Specification
 * form directly (several are stored as text in Dataverse even though they're numeric). */
export function mapProductToSpec(product: Mpp_wl_productses): MachineSpecInput {
  return {
    area: product.mpp_area ?? '',
    layLength: parseNumber(product.mpp_laylength, 0),
    noOfWires: parseNumber(product.mpp_numberoffibers, 1),
    speed: parseNumber(product.mpp_speed, 0),
    spoolLength: parseNumber(product.mpp_spoollength, 0),
    linearDensity: parseNumber(product.mpp_lineardensity, 0),
    fracturePerTon: parseNumber(product.mpp_fractureperton, 0),
    diesPerTon: parseNumber(product.mpp_dieston, 0),
    defectsPerTon: parseNumber(product.mpp_defectston, 0),
  };
}

/** ROUNDDOWN(value/divisor) — the number of whole spools that fit within a given Pay-Off length. */
function rounddownRatio(value: number, divisor: number): number {
  if (!divisor) return 0;
  return Math.floor(value / divisor);
}

/** Builds Loading from WL_Products' POlength1/2/3 columns, per the
 * regulation: how many of the three are filled decides whether there's 0, 1 or 2 sub-loadings.
 * For WW/BA/CA/IS/IP, POlength is a weight in kg rather than a physical length: only the parent
 * Loading is created, its denominator is POlength/SpoolWeight (decimal values are intentional),
 * and the simulation marks it due from fractional production progress, so it may interrupt a
 * spool before Doffing.
 *   - 1 filled: parent only, denominator = ROUNDDOWN(that length / SpoolLength).
 *   - 2 filled: parent denominator = ROUNDDOWN(MAX(length) / SpoolLength); one sub-loading, taken
 *     whole (time/numerator/denominator/machcondition) from the WL_Activities row
 *     Task=Loading/SubTask=Partial1.
 *   - 3 filled: parent denominator same as the 2-filled case (based on the max length). The other
 *     two lengths each get a ROUNDDOWN(length/SpoolLength); if those two values are equal, it
 *     collapses to a single sub-loading (Partial1) just like the 2-filled case. If they differ,
 *     there are two: the smaller-value one is Partial1, the other is Partial2.
 *   - none filled: no POlength regulation configured for this Construction — Loading falls back to
 *     the generic same-as-other-tasks handling (parent + literal WL_Activities subs).
 * Any Loading/Partial row this regulation calls for but that's missing from WL_Activities is
 * reported back as an error instead of silently skipped. */
function buildLoadingActivities(
  rows: Mpp_wl_activities[],
  product: Pick<Mpp_wl_productses, 'mpp_area' | 'mpp_polength1' | 'mpp_polength2' | 'mpp_polength3' | 'mpp_spoollength'>,
  spoolWeight: number,
): { activities: ActivityConfig[]; errors: string[] } | null {
  const poLengths = [
    { value: parseNumber(product.mpp_polength1, NaN) },
    { value: parseNumber(product.mpp_polength2, NaN) },
    { value: parseNumber(product.mpp_polength3, NaN) },
  ].filter((p): p is { value: number } => Number.isFinite(p.value) && p.value > 0);

  if (poLengths.length === 0) return null;

  const errors: string[] = [];
  const activities: ActivityConfig[] = [];
  const loadingRows = rows.filter((row) => taskLabelText(row) === 'Loading');
  const parentRow = loadingRows.find((row) => !row.mpp_subtaskname?.trim());
  const findSub = (subtaskName: string) =>
    loadingRows.find((row) => row.mpp_subtaskname?.trim().toLowerCase() === subtaskName.toLowerCase());
  const spoolLength = parseNumber(product.mpp_spoollength, 0);
  const weightLoading = WEIGHT_LOADING_AREAS.includes((product.mpp_area ?? '').trim().toUpperCase());

  if (!parentRow) {
    errors.push('Loading (Task=Loading, SubTask blank) not found in WL_Activities for this Construction.');
  } else {
    const maxPoLength = Math.max(...poLengths.map((p) => p.value));
    activities.push({
      key: 'loading',
      label: 'Loading',
      timeMinutes: parseNumber(parentRow.mpp_tasktime, 0),
      numerator: 1,
      numeratorAuto: false,
      denominator: rounddownRatio(maxPoLength, spoolLength),
      denominatorAuto: false,
      machCondition: parseMachCondition(parentRow.mpp_machcondition),
      numeratorReadOnly: true,
      denominatorReadOnly: true,
      loadingInterrupt: weightLoading,
    });
  }

  if (weightLoading) {
    const poLength = poLengths[0].value;
    if (!spoolWeight) {
      errors.push('Loading denominator cannot be calculated because SpoolWeight is zero.');
    } else if (parentRow) {
      const loading = activities[0];
      loading.denominator = poLength / spoolWeight;
      loading.loadingInterrupt = true;
      // POlength is kilograms for these areas: only the parent Loading is applicable.
      return { activities, errors };
    }
  }

  if (poLengths.length > 1) {
    const maxEntry = poLengths.reduce((best, p) => (p.value > best.value ? p : best), poLengths[0]);
    const others = poLengths.filter((p) => p !== maxEntry);
    // Which sub gets which POlength: with only one "other" length it's always Partial1; with two,
    // whichever has the smaller ROUNDDOWN(length/SpoolLength) is Partial1 and the other Partial2 —
    // or just one merged Partial1 if both round down to the same value.
    const subPlan: { subtaskName: string; poLength: number; slot: 1 | 2 }[] =
      others.length === 1
        ? [{ subtaskName: 'Partial1', poLength: others[0].value, slot: 1 }]
        : (() => {
            const withRundown = others.map((p) => ({ poLength: p.value, rundown: rounddownRatio(p.value, spoolLength) }));
            const [a, b] = withRundown;
            if (a.rundown === b.rundown) return [{ subtaskName: 'Partial1', poLength: a.poLength, slot: 1 as const }];
            const sorted = [...withRundown].sort((x, y) => x.rundown - y.rundown);
            return [
              { subtaskName: 'Partial1', poLength: sorted[0].poLength, slot: 1 as const },
              { subtaskName: 'Partial2', poLength: sorted[1].poLength, slot: 2 as const },
            ];
          })();

    subPlan.forEach(({ subtaskName, poLength, slot }) => {
      const subRow = findSub(subtaskName);
      if (!subRow) {
        errors.push(`Sub Loading "${subtaskName}" (Task=Loading, SubTask=${subtaskName}) not found in WL_Activities for this Construction.`);
        return;
      }
      activities.push({
        key: `loading-sub-${subRow.mpp_wl_activityid}`,
        parentKey: 'loading',
        label: `Loading ${subRow.mpp_subtaskname}`.trim(),
        // Time and MachCondition come from WL_Activities; Numerator/Denominator are formula-driven
        // from this sub's own POlength, not whatever WL_Activities happens to have stored for them.
        timeMinutes: parseNumber(subRow.mpp_tasktime, 0),
        numerator: 1,
        numeratorAuto: false,
        denominator: rounddownRatio(poLength, spoolLength),
        denominatorAuto: false,
        machCondition: parseMachCondition(subRow.mpp_machcondition),
        numeratorReadOnly: true,
        denominatorReadOnly: true,
        loadingPartialSlot: slot,
      });
    });

    // When both Partial1 and Partial2 exist, they can occasionally come due on the same machine at
    // the same time — the regulation is to do a single combined "Loading Partial3" then, instead of
    // both in sequence, sourcing Time/MachCondition from its own WL_Activities row. Its
    // numerator/denominator don't matter (it's never independently due — see loadingPartialSlot).
    if (subPlan.length === 2) {
      const partial3Row = findSub('Partial3');
      if (!partial3Row) {
        errors.push('Sub Loading "Partial3" (Task=Loading, SubTask=Partial3) not found in WL_Activities for this Construction — needed for when Partial1 and Partial2 are both due at once.');
      } else {
        activities.push({
          key: `loading-sub-${partial3Row.mpp_wl_activityid}`,
          parentKey: 'loading',
          label: 'Loading Partial3',
          timeMinutes: parseNumber(partial3Row.mpp_tasktime, 0),
          numerator: 0,
          numeratorAuto: false,
          denominator: 1,
          denominatorAuto: false,
          machCondition: parseMachCondition(partial3Row.mpp_machcondition),
          numeratorReadOnly: true,
          denominatorReadOnly: true,
          loadingPartialSlot: 3,
        });
      }
    }
  }

  return { activities, errors };
}

/** Builds the Activity Table from WL_Activities rows already filtered to one Construction.
 * A row with a blank SubTask is the parent (Doffing/Loading/FractureRepairing); a row with a
 * SubTask value is a sub-activity, labeled "<Task> <SubTask>" and keyed so the sim's existing
 * `<parent>-sub-*` prefix checks (machine zones, run/stop scheduling) keep working. Fracture
 * Repairing's own numerator/denominator stay formula-driven (Fracture/Ton, 1000/SpoolWeight)
 * rather than whatever WL_Activities stored for that row, matching the app's existing behavior.
 * Loading is driven by WL_Products' POlength1/2/3 columns when any are filled — see
 * buildLoadingActivities — and otherwise falls back to the generic per-task handling below. */
export function buildActivitiesFromRows(
  rows: Mpp_wl_activities[],
  product: Pick<
    Mpp_wl_productses,
    'mpp_area' | 'mpp_polength1' | 'mpp_polength2' | 'mpp_polength3' | 'mpp_spoollength' | 'mpp_dieston' | 'mpp_defectston'
  >,
  spoolWeight: number,
  fracturePerTon: number,
): { activities: ActivityConfig[]; errors: string[] } {
  const result: ActivityConfig[] = [];
  const errors: string[] = [];
  const loadingOverride = buildLoadingActivities(rows, product, spoolWeight);

  for (const taskLabel of TASK_ORDER) {
    const taskKey = TASK_KEY_BY_LABEL[taskLabel];

    if (taskKey === 'loading' && loadingOverride) {
      result.push(...loadingOverride.activities);
      errors.push(...loadingOverride.errors);
      continue;
    }

    const displayLabel =
      taskLabel === 'FractureRepairing' ? 'Fracture Repairing' : taskLabel === 'DiesChange' ? 'Dies Change' : taskLabel === 'DefectRepairing' ? 'Defect Repairing' : taskLabel;
    const taskRows = rows.filter((row) => taskLabelText(row) === taskLabel);
    const parentRow = taskRows.find((row) => !row.mpp_subtaskname?.trim());
    const subRows = taskRows.filter((row) => row.mpp_subtaskname?.trim());
    const isFractureParent = taskKey === 'fractureRepairing';
    const area = (product.mpp_area ?? '').trim().toUpperCase();
    const isDiesChangeParent = taskKey === 'diesChange' && DIES_CHANGE_AREAS.includes(area);
    const isDefectRepairingParent = taskKey === 'defectRepairing' && DEFECT_REPAIRING_AREAS.includes(area);
    const regulatedRate = isDiesChangeParent
      ? parseNumber(product.mpp_dieston, 0)
      : isDefectRepairingParent
        ? parseNumber(product.mpp_defectston, 0)
        : 0;
    const isTonRegulatedParent = isFractureParent || isDiesChangeParent || isDefectRepairingParent;

    if (parentRow && (taskKey !== 'diesChange' || isDiesChangeParent) && (taskKey !== 'defectRepairing' || isDefectRepairingParent)) {
      result.push({
        key: taskKey,
        label: displayLabel,
        timeMinutes: parseNumber(parentRow.mpp_tasktime, 0),
        numerator: isTonRegulatedParent ? (isFractureParent ? fracturePerTon : regulatedRate) : parseNumber(parentRow.mpp_numerator, 1),
        numeratorAuto: isTonRegulatedParent,
        denominator: isTonRegulatedParent ? fractureRepairingDenominator(spoolWeight) : parseNumber(parentRow.mpp_denominator, 1),
        denominatorAuto: isTonRegulatedParent,
        machCondition: parseMachCondition(parentRow.mpp_machcondition),
        defectTakeupOnly: isDefectRepairingParent,
      });
    }

    if (taskKey !== 'diesChange' && taskKey !== 'defectRepairing') {
      subRows.forEach((row) => {
      result.push({
        key: `${taskKey}-sub-${row.mpp_wl_activityid}`,
        parentKey: taskKey,
        label: `${displayLabel} ${row.mpp_subtaskname}`.trim(),
        timeMinutes: parseNumber(row.mpp_tasktime, 0),
        numerator: parseNumber(row.mpp_numerator, 1),
        numeratorAuto: false,
        denominator: parseNumber(row.mpp_denominator, 1),
        denominatorAuto: false,
        machCondition: parseMachCondition(row.mpp_machcondition),
      });
      });
    }
  }

  return { activities: result, errors };
}
