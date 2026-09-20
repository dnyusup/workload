import { useEffect, useMemo, useState } from 'react';
import { Mpp_wl_outputmodelsesService } from '../../generated/services/Mpp_wl_outputmodelsesService';
import type { Mpp_wl_outputmodelses } from '../../generated/models/Mpp_wl_outputmodelsesModel';
import { fetchAllPages } from '../../lib/dataversePaging';
import { OUTPUT_MODEL_PERCENT_KEYS, percentageForDisplay } from '../../lib/outputModel';
import { downloadOutputModelRows } from '../../lib/outputModelExport';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { CustomSortControl, type CustomSortLevel } from './CustomSortControl';
import type { MachineStartCondition } from '../../types';

type OutputModelKey =
  | 'mpp_constructiondetailcode'
  | 'mpp_construction'
  | 'mpp_areacode'
  | 'mpp_machinecode'
  | 'mpp_productcode'
  | 'mpp_tensilegroup'
  | 'mpp_laylength'
  | 'mpp_spooltype'
  | 'mpp_spoollength'
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
  | 'mpp_updatedby'
  | 'mpp_updatedon'
  | 'mpp_version'
  | 'mpp_versionremark'
  | 'mpp_startmachcondition';

interface OutputModelColumn {
  key: OutputModelKey;
  label: string;
}

const OUTPUT_MODEL_COLUMNS: OutputModelColumn[] = [
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
  { key: 'mpp_updatedby', label: 'UpdatedBy' },
  { key: 'mpp_updatedon', label: 'UpdatedOn' },
  { key: 'mpp_startmachcondition', label: 'StartMachCondition' },
];

function formatValue(value: unknown, key: OutputModelKey) {
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

function comparableValue(record: Mpp_wl_outputmodelses, key: OutputModelKey): string | number {
  const value = record[key];
  return typeof value === 'number' ? value : String(value ?? '');
}

export function OutputModelsManager({
  onUseStartCondition,
}: {
  onUseStartCondition?: (row: Mpp_wl_outputmodelses, conditions: MachineStartCondition[]) => void;
}) {
  const [rows, setRows] = useState<Mpp_wl_outputmodelses[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [search, setSearch] = useState('');
  const [sortLevels, setSortLevels] = useState<CustomSortLevel[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchAllPages(Mpp_wl_outputmodelsesService.getAll, { orderBy: ['mpp_updatedon desc'] })
      .then((result) => {
        if (!cancelled) setRows(result);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load WL_Outputmodels.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const refresh = () => {
    setLoading(true);
    setLoadError(null);
    setReloadToken((token) => token + 1);
  };

  const loadStartCondition = (row: Mpp_wl_outputmodelses) => {
    try {
      const parsed = JSON.parse(row.mpp_startmachcondition ?? '') as MachineStartCondition[];
      if (!Array.isArray(parsed) || parsed.some((condition) => !condition.machineId)) {
        throw new Error('The saved start condition is invalid.');
      }
      onUseStartCondition?.(row, parsed);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'The saved start condition is invalid.');
    }
  };

  const visibleRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? rows.filter((row) =>
          [row.mpp_constructiondetailcode, row.mpp_construction, row.mpp_areacode, row.mpp_productcode, row.mpp_updatedby]
            .some((value) => String(value ?? '').toLowerCase().includes(query)),
        )
      : rows;
    if (!sortLevels.length) return filtered;
    return [...filtered].sort((left, right) => {
      for (const level of sortLevels) {
        const leftValue = comparableValue(left, level.key as OutputModelKey);
        const rightValue = comparableValue(right, level.key as OutputModelKey);
        const comparison =
          typeof leftValue === 'number' && typeof rightValue === 'number'
            ? leftValue - rightValue
            : String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: 'base' });
        if (comparison !== 0) return level.dir === 'asc' ? comparison : -comparison;
      }
      return 0;
    });
  }, [rows, search, sortLevels]);

  const exportExcel = () => {
    const date = new Date().toISOString().slice(0, 10);
    downloadOutputModelRows(visibleRows, `wl-outputmodels-${date}.csv`);
  };

  return (
    <Card
      title="WL_Outputmodels"
      subtitle="Saved workload simulation output models"
      actions={
        <div className="data-manager-actions">
          <input
            className="input output-models-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search output model…"
            aria-label="Search output model"
          />
          <Button variant="ghost" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={exportExcel} disabled={loading || visibleRows.length === 0}>
            📊 Export Excel
          </Button>
          <CustomSortControl
            columns={OUTPUT_MODEL_COLUMNS}
            levels={sortLevels}
            onChange={setSortLevels}
          />
        </div>
      }
    >
      {loadError && <p className="construction-selector-error">{loadError}</p>}
      {loading ? (
        <p className="data-manager-hint">Loading…</p>
      ) : (
        <div className="data-table-wrap">
          <table className="table output-models-table">
            <thead>
              <tr>
                {OUTPUT_MODEL_COLUMNS.map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
                {onUseStartCondition && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.mpp_wl_outputmodelsid}>
                  {OUTPUT_MODEL_COLUMNS.map((column) => (
                    <td key={column.key}>{formatValue(row[column.key], column.key)}</td>
                  ))}
                  {onUseStartCondition && (
                    <td className="data-row-actions">
                      <Button
                        variant="ghost"
                        onClick={() => loadStartCondition(row)}
                        disabled={!row.mpp_startmachcondition}
                        title="Use the inherited machine condition for the next simulation"
                      >
                        Use Start Condition
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={OUTPUT_MODEL_COLUMNS.length + (onUseStartCondition ? 1 : 0)} className="data-manager-hint">
                    {rows.length === 0 ? 'No saved output models yet.' : 'No output models match the search.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
