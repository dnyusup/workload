import type { Mpp_wl_outputmodelses } from '../generated/models/Mpp_wl_outputmodelsesModel';
import { OUTPUT_MODEL_PERCENT_KEYS, percentageForDisplay } from './outputModel';

/** WL_Outputmodels columns and their display formatting — shared by the table, its detail
 * dialog and the Workload Simulator's result preview. */
export type OutputModelKey =
  | 'mpp_constructiondetailcode'
  | 'mpp_construction'
  | 'mpp_areacode'
  | 'mpp_machinecode'
  | 'mpp_productcode'
  | 'mpp_tensilegroup'
  | 'mpp_laylength'
  | 'mpp_spooltype'
  | 'mpp_spoollength'
  | 'mpp_nofwires'
  | 'mpp_speed'
  | 'mpp_fractureperton'
  | 'mpp_defectperton'
  | 'mpp_diesperton'
  | 'mpp_polength1'
  | 'mpp_polength2'
  | 'mpp_polength3'
  | 'mpp_lineardensity'
  | 'mpp_twistperminute'
  | 'mpp_spoolweight'
  | 'mpp_linearspeeds'
  | 'mpp_runtimeperspool'
  | 'mpp_taskpriority'
  | 'mpp_shifttime'
  | 'mpp_lunchtime'
  | 'mpp_lunchstarttime'
  | 'mpp_meetingtime'
  | 'mpp_meetingstarttime'
  | 'mpp_numberofmachinesassigned'
  | 'mpp_plannedmanoccupation'
  | 'mpp_actualmanoccupation'
  | 'mpp_tonspershift'
  | 'mpp_plannedmachineefficiency'
  | 'mpp_actualmachineefficiency'
  | 'mpp_manhoursperton'
  | 'mpp_machinehoursperton'
  | 'mpp_totalspoolcount'
  | 'mpp_actualfractureperton'
  | 'mpp_actualdefectperton'
  | 'mpp_actualdiesperton'
  | 'mpp_doffingtime'
  | 'mpp_loadingtime'
  | 'mpp_fracturerepairingtime'
  | 'mpp_defectrepairingtime'
  | 'mpp_dieschangetime'
  | 'mpp_walkingtime'
  | 'mpp_othertime'
  | 'mpp_idle'
  | 'mpp_updatedby'
  | 'mpp_updatedon'
  | 'mpp_version'
  | 'mpp_versionremark'
  | 'mpp_startmachcondition';

/** A saved row, or an unsaved simulation result with the same fields. */
export type OutputModelRecord = Partial<Pick<Mpp_wl_outputmodelses, OutputModelKey>>;

export interface OutputModelColumn {
  key: OutputModelKey;
  label: string;
}

export const OUTPUT_MODEL_COLUMNS: OutputModelColumn[] = [
  { key: 'mpp_constructiondetailcode', label: 'ConstructionDetail' },
  { key: 'mpp_version', label: 'Version' },
  { key: 'mpp_versionremark', label: 'VersionRemark' },
  { key: 'mpp_construction', label: 'Construction' },
  { key: 'mpp_areacode', label: 'Area' },
  { key: 'mpp_machinecode', label: 'Mach' },
  { key: 'mpp_productcode', label: 'Product' },
  { key: 'mpp_tensilegroup', label: 'TensileGroup' },
  { key: 'mpp_laylength', label: 'LayLength' },
  { key: 'mpp_spooltype', label: 'SpoolType' },
  { key: 'mpp_spoollength', label: 'SpoolLength' },
  { key: 'mpp_nofwires', label: 'NoFWires' },
  { key: 'mpp_speed', label: 'Speed' },
  { key: 'mpp_fractureperton', label: 'Fracture/ton' },
  { key: 'mpp_defectperton', label: 'Defect/ton' },
  { key: 'mpp_diesperton', label: 'Dies/ton' },
  { key: 'mpp_polength1', label: 'POlength1' },
  { key: 'mpp_polength2', label: 'POlength2' },
  { key: 'mpp_polength3', label: 'POlength3' },
  { key: 'mpp_lineardensity', label: 'LinearDensity' },
  { key: 'mpp_twistperminute', label: 'Twist/min' },
  { key: 'mpp_spoolweight', label: 'SpoolWeight' },
  { key: 'mpp_linearspeeds', label: 'LinearSpeed' },
  { key: 'mpp_runtimeperspool', label: 'Runtime/spool' },
  { key: 'mpp_taskpriority', label: 'TaskPriority' },
  { key: 'mpp_shifttime', label: 'ShiftTime' },
  { key: 'mpp_lunchtime', label: 'LunchTime' },
  { key: 'mpp_lunchstarttime', label: 'LunchStartAt' },
  { key: 'mpp_meetingtime', label: 'MeetingTime' },
  { key: 'mpp_meetingstarttime', label: 'MeetingStartAt' },
  { key: 'mpp_numberofmachinesassigned', label: '#MachinesAssigned' },
  { key: 'mpp_plannedmanoccupation', label: 'PlannedManOccupation' },
  { key: 'mpp_actualmanoccupation', label: 'ActualManOccupation' },
  { key: 'mpp_tonspershift', label: 'Ton/Shift' },
  { key: 'mpp_plannedmachineefficiency', label: 'PlannedMachEff' },
  { key: 'mpp_actualmachineefficiency', label: 'ActualMachEff' },
  { key: 'mpp_manhoursperton', label: 'ManHour/ton' },
  { key: 'mpp_machinehoursperton', label: 'MachHour/ton' },
  { key: 'mpp_totalspoolcount', label: 'TotalSpool' },
  { key: 'mpp_actualfractureperton', label: 'ActFracture/Ton' },
  { key: 'mpp_actualdefectperton', label: 'ActDefect/ton' },
  { key: 'mpp_actualdiesperton', label: 'ActDies/ton' },
  { key: 'mpp_doffingtime', label: 'Doffing' },
  { key: 'mpp_loadingtime', label: 'Loading' },
  { key: 'mpp_fracturerepairingtime', label: 'FractureRepairing' },
  { key: 'mpp_defectrepairingtime', label: 'DefectRepairing' },
  { key: 'mpp_dieschangetime', label: 'DiesChange' },
  { key: 'mpp_walkingtime', label: 'Walking' },
  { key: 'mpp_othertime', label: 'Others' },
  { key: 'mpp_idle', label: 'Idle' },
  { key: 'mpp_updatedby', label: 'UpdatedBy' },
  { key: 'mpp_updatedon', label: 'UpdatedOn' },
  { key: 'mpp_startmachcondition', label: 'StartMachCondition' },
];

export function formatOutputModelValue(value: unknown, key: OutputModelKey) {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'mpp_startmachcondition') {
    try {
      const conditions = JSON.parse(String(value)) as unknown[];
      return `${conditions.length} machine condition${conditions.length === 1 ? '' : 's'} captured`;
    } catch {
      return 'Invalid condition data';
    }
  }
  if (key === 'mpp_updatedon') {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
  if (typeof value === 'number') {
    if ((OUTPUT_MODEL_PERCENT_KEYS as readonly string[]).includes(key)) {
      return `${percentageForDisplay(value).toFixed(2)}%`;
    }
    return String(Math.round(value * 10) / 10);
  }
  return String(value);
}

export const outputModelColumnLabel = (key: OutputModelKey) =>
  OUTPUT_MODEL_COLUMNS.find((column) => column.key === key)?.label ?? key;
