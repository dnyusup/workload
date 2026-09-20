import type { Mpp_wl_outputmodelses } from '../generated/models/Mpp_wl_outputmodelsesModel';
import { OUTPUT_MODEL_PERCENT_KEYS, percentageForDisplay } from './outputModel';

export type OutputModelExportKey =
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
  | 'mpp_linearspeed'
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
  | 'mpp_updatedon';

export type OutputModelExportRecord = Partial<
  Record<OutputModelExportKey | 'mpp_version' | 'mpp_versionremark', string | number | null | undefined>
>;

export interface OutputModelExportColumn {
  key: OutputModelExportKey | 'mpp_version' | 'mpp_versionremark';
  label: string;
}

export const OUTPUT_MODEL_EXPORT_COLUMNS: readonly OutputModelExportColumn[] = [
  { key: 'mpp_constructiondetailcode', label: 'ConstructionDetail' },
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
  { key: 'mpp_fractureperton', label: 'Fracture/Ton' },
  { key: 'mpp_defectperton', label: 'Defect/Ton' },
  { key: 'mpp_diesperton', label: 'Dies/Ton' },
  { key: 'mpp_polength1', label: 'POlength1' },
  { key: 'mpp_polength2', label: 'POlength2' },
  { key: 'mpp_polength3', label: 'POlength3' },
  { key: 'mpp_lineardensity', label: 'LinearDensity' },
  { key: 'mpp_twistperminute', label: 'Twist/min' },
  { key: 'mpp_spoolweight', label: 'SpoolWeight' },
  { key: 'mpp_linearspeed', label: 'LinearSpeed' },
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
  { key: 'mpp_manhoursperton', label: 'ManHour/Ton' },
  { key: 'mpp_machinehoursperton', label: 'MachHour/Ton' },
  { key: 'mpp_totalspoolcount', label: 'TotalSpool' },
  { key: 'mpp_actualfractureperton', label: 'ActFracture/Ton' },
  { key: 'mpp_actualdefectperton', label: 'ActDefect/Ton' },
  { key: 'mpp_actualdiesperton', label: 'ActDies/Ton' },
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
];

export const OUTPUT_MODEL_EXPORT_COLUMNS_WITH_VERSION: readonly OutputModelExportColumn[] = [
  ...OUTPUT_MODEL_EXPORT_COLUMNS,
  { key: 'mpp_version', label: 'Version' },
  { key: 'mpp_versionremark', label: 'VersionRemark' },
];

function formattedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB');
}

export function formatOutputModelExportValue(
  record: OutputModelExportRecord,
  key: OutputModelExportKey | 'mpp_version' | 'mpp_versionremark',
) {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (key === 'mpp_version') return `="${String(value)}"`;
  if ((OUTPUT_MODEL_PERCENT_KEYS as readonly string[]).includes(key)) {
    return `${String(percentageForDisplay(Number(value)))}%`;
  }
  if (key === 'mpp_updatedon') return formattedDate(String(value));
  return String(value);
}

function outputModelRowsAsMatrix(
  rows: readonly OutputModelExportRecord[],
  columns: readonly OutputModelExportColumn[],
) {
  return [
    columns.map((column) => column.label),
    ...rows.map((row) => columns.map((column) => formatOutputModelExportValue(row, column.key))),
  ];
}

export function outputModelRowsAsTsv(
  rows: readonly OutputModelExportRecord[],
  columns: readonly OutputModelExportColumn[] = OUTPUT_MODEL_EXPORT_COLUMNS,
) {
  const matrix = outputModelRowsAsMatrix(rows, columns);
  return matrix
    .map((row) => row.join('\t'))
    .join('\r\n');
}

export function outputModelRowsAsCsv(
  rows: readonly OutputModelExportRecord[],
  columns: readonly OutputModelExportColumn[] = OUTPUT_MODEL_EXPORT_COLUMNS_WITH_VERSION,
) {
  const escapeCsv = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return `\ufeff${outputModelRowsAsMatrix(rows, columns)
    .map((row) => row.map(escapeCsv).join(','))
    .join('\r\n')}`;
}

export async function copyOutputModelRows(
  rows: readonly OutputModelExportRecord[],
  columns: readonly OutputModelExportColumn[] = OUTPUT_MODEL_EXPORT_COLUMNS,
) {
  const text = outputModelRowsAsTsv(rows, columns);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textArea);
  if (!copied) throw new Error('Clipboard access is unavailable. Please allow clipboard access and try again.');
}

export function downloadOutputModelRows(
  rows: readonly OutputModelExportRecord[],
  filename: string,
  columns: readonly OutputModelExportColumn[] = OUTPUT_MODEL_EXPORT_COLUMNS_WITH_VERSION,
) {
  const blob = new Blob([outputModelRowsAsCsv(rows, columns)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function asOutputModelExportRecord(
  row: Mpp_wl_outputmodelses | OutputModelExportRecord,
): OutputModelExportRecord {
  return row;
}
