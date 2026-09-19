import { useCallback, useEffect, useMemo, useState } from 'react';
import { Mpp_wl_activitiesService } from '../../generated/services/Mpp_wl_activitiesService';
import {
  Mpp_wl_activitiesmpp_taskname,
  type Mpp_wl_activities,
  type Mpp_wl_activitiesBase,
} from '../../generated/models/Mpp_wl_activitiesModel';
import { Mpp_wl_productsesService } from '../../generated/services/Mpp_wl_productsesService';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { SearchableSelect } from '../ui/SearchableSelect';
import { CustomSortControl, type CustomSortLevel } from './CustomSortControl';

/** DiesChange only applies to Constructions belonging to these Areas (see WL_Products.mpp_area) —
 * everywhere else it's hidden from the Task dropdown, mirroring the Dies/Ton field restriction. */
const DIES_CHANGE_AREAS = ['WW', 'CA', 'BA'];
const DEFECT_REPAIRING_AREAS = ['CB', 'BU', 'SP', 'CH', 'CR'];

const TASK_OPTIONS = Object.entries(Mpp_wl_activitiesmpp_taskname).map(([value, label]) => ({
  value: Number(value) as 0 | 1 | 2 | 3 | 4,
  label,
}));

interface ActivityFields {
  mpp_constructiontype: string;
  mpp_taskname: 0 | 1 | 2 | 3 | 4;
  mpp_subtaskname: string;
  mpp_tasktime: number;
  mpp_numerator: number;
  mpp_denominator: number;
  mpp_machcondition: 'Stop' | 'Run';
  mpp_productcode: string;
  mpp_machinecode: string;
  mpp_spooltype: string;
  mpp_tensilegroup: string;
  mpp_laylength: number;
}

interface ActivityRow {
  id: string;
  isNew: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  fields: ActivityFields;
}

/** Mirror image of WL_Products' ConstructionDetail/Construction join (see ProductsManager.tsx):
 * there, Construction is DERIVED from Mach/Product/LayLength/TensileGroup/SpoolType. Here,
 * Construction is the field the user actually picks/types, so it's the other way round — these
 * five columns are derived FROM it by splitting on "-" in that same order, and shown read-only. */
function fieldsFromConstruction(construction: string): Pick<ActivityFields, 'mpp_machinecode' | 'mpp_productcode' | 'mpp_laylength' | 'mpp_tensilegroup' | 'mpp_spooltype'> {
  const parts = construction.split('-');
  const [machinecode = '', productcode = '', laylength = '', tensilegroup = '', spooltype = ''] = parts;
  return {
    mpp_machinecode: machinecode,
    mpp_productcode: productcode,
    mpp_laylength: Number(laylength) || 0,
    mpp_tensilegroup: tensilegroup,
    mpp_spooltype: spooltype,
  };
}

function emptyFields(): ActivityFields {
  return {
    mpp_constructiontype: '',
    mpp_taskname: 0,
    mpp_subtaskname: '',
    mpp_tasktime: 0,
    mpp_numerator: 1,
    mpp_denominator: 1,
    mpp_machcondition: 'Stop',
    mpp_productcode: '',
    mpp_machinecode: '',
    mpp_spooltype: '',
    mpp_tensilegroup: '',
    mpp_laylength: 0,
  };
}

function fieldsFromRecord(record: Mpp_wl_activities): ActivityFields {
  const constructionType = record.mpp_constructiontype ?? '';
  return {
    mpp_constructiontype: constructionType,
    mpp_taskname: (record.mpp_taskname ?? 0) as 0 | 1 | 2 | 3 | 4,
    mpp_subtaskname: record.mpp_subtaskname ?? '',
    mpp_tasktime: record.mpp_tasktime ?? 0,
    mpp_numerator: record.mpp_numerator ?? 1,
    mpp_denominator: record.mpp_denominator ?? 1,
    mpp_machcondition: (record.mpp_machcondition ?? '').trim().toLowerCase() === 'run' ? 'Run' : 'Stop',
    ...fieldsFromConstruction(constructionType),
  };
}

export function ActivitiesManager({
  initialConstructionFilter,
}: {
  /** Set when navigating here from WL_Products (double-click on a Construction cell) —
   * pre-selects that Construction in the filter dropdown below. */
  initialConstructionFilter?: string;
} = {}) {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [constructionFilter, setConstructionFilter] = useState(initialConstructionFilter ?? '');
  const [sortLevels, setSortLevels] = useState<CustomSortLevel[]>([]);
  // Construction (mpp_constructioncode) -> Area, sourced from WL_Products, used only to decide
  // whether DiesChange should appear in the Task dropdown for a given row (see DIES_CHANGE_AREAS).
  const [areaByConstruction, setAreaByConstruction] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (initialConstructionFilter) setConstructionFilter(initialConstructionFilter);
  }, [initialConstructionFilter]);

  useEffect(() => {
    let cancelled = false;
    Mpp_wl_productsesService.getAll({}).then((result) => {
      if (cancelled || !result.success) return;
      const map = new Map<string, string>();
      for (const product of result.data ?? []) {
        if (product.mpp_constructioncode) map.set(product.mpp_constructioncode, product.mpp_area ?? '');
      }
      setAreaByConstruction(map);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Mpp_wl_activitiesService.getAll({ orderBy: ['mpp_constructiontype asc', 'mpp_taskname asc'] })
      .then((result) => {
        if (cancelled) return;
        if (result.success) {
          setRows(
            (result.data ?? []).map((record) => ({
              id: record.mpp_wl_activityid,
              isNew: false,
              dirty: false,
              saving: false,
              error: null,
              fields: fieldsFromRecord(record),
            })),
          );
        } else {
          setLoadError(result.error?.message ?? 'Failed to load WL_Activities.');
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load WL_Activities.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const updateField = useCallback(<K extends keyof ActivityFields>(id: string, key: K, value: ActivityFields[K]) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        const fields = { ...row.fields, [key]: value };
        if (key === 'mpp_constructiontype') Object.assign(fields, fieldsFromConstruction(value as string));
        return { ...row, dirty: true, fields };
      }),
    );
  }, []);

  const toggleSort = (key: keyof ActivityFields) => {
    setSortLevels((prev) => {
      const current = prev[0];
      return current?.key === key ? [{ key, dir: current.dir === 'asc' ? 'desc' : 'asc' }] : [{ key, dir: 'asc' }];
    });
  };

  const constructionOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.fields.mpp_constructiontype).filter(Boolean));
    if (constructionFilter) set.add(constructionFilter);
    return Array.from(set)
      .sort((a, b) => a.localeCompare(b))
      .map((v) => ({ value: v, label: v }));
  }, [rows, constructionFilter]);

  const visibleRows = useMemo(() => {
    const filtered = constructionFilter ? rows.filter((r) => r.fields.mpp_constructiontype === constructionFilter) : rows;
    if (!sortLevels.length) return filtered;
    return [...filtered].sort((a, b) => {
      for (const { key, dir } of sortLevels) {
        const av = a.fields[key as keyof ActivityFields];
        const bv = b.fields[key as keyof ActivityFields];
        const sign = dir === 'asc' ? 1 : -1;
        const comparison =
          typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
        if (comparison !== 0) return comparison * sign;
      }
      return 0;
    });
  }, [rows, constructionFilter, sortLevels]);

  const sortIndicator = (key: keyof ActivityFields) => {
    const level = sortLevels.findIndex((item) => item.key === key);
    if (level < 0) return '';
    const direction = sortLevels[level].dir === 'asc' ? '▲' : '▼';
    return ` ${level + 1}${direction}`;
  };

  /** Special tasks are shown only for their applicable Areas; already-saved values remain visible
   * so changing product master data does not silently hide an existing activity. */
  const taskOptionsFor = (row: ActivityRow) => {
    const area = areaByConstruction.get(row.fields.mpp_constructiontype) ?? '';
    const allowed = new Set<number>([0, 1, 2]);
    if (DIES_CHANGE_AREAS.includes(area) || row.fields.mpp_taskname === 3) allowed.add(3);
    if (DEFECT_REPAIRING_AREAS.includes(area) || row.fields.mpp_taskname === 4) allowed.add(4);
    return TASK_OPTIONS.filter((opt) => allowed.has(opt.value));
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        id: `new-${Date.now()}`,
        isNew: true,
        dirty: true,
        saving: false,
        error: null,
        // Pre-fill Construction from the active filter — adding an activity while already
        // scoped to one Construction almost always means adding it for that same Construction.
        fields: {
          ...emptyFields(),
          mpp_constructiontype: constructionFilter,
          ...fieldsFromConstruction(constructionFilter),
        },
      },
    ]);
  };

  const toPayload = (fields: ActivityFields): Omit<Mpp_wl_activitiesBase, 'mpp_wl_activityid'> => ({
    mpp_constructiontype: fields.mpp_constructiontype,
    mpp_taskname: fields.mpp_taskname,
    mpp_subtaskname: fields.mpp_subtaskname || undefined,
    mpp_tasktime: fields.mpp_tasktime,
    mpp_numerator: fields.mpp_numerator,
    mpp_denominator: fields.mpp_denominator,
    mpp_machcondition: fields.mpp_machcondition,
    mpp_productcode: fields.mpp_productcode || undefined,
    mpp_machinecode: fields.mpp_machinecode || undefined,
    mpp_spooltype: fields.mpp_spooltype || undefined,
    mpp_tensilegroup: fields.mpp_tensilegroup || undefined,
    mpp_laylength: fields.mpp_laylength,
    statecode: 0,
  });

  const saveRow = async (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, saving: true, error: null } : r)));
    const payload = toPayload(row.fields);
    try {
      if (row.isNew) {
        const result = await Mpp_wl_activitiesService.create(payload);
        if (result.success) {
          setRows((prev) =>
            prev.map((r) => (r.id === id ? { ...r, id: result.data.mpp_wl_activityid, isNew: false, dirty: false, saving: false } : r)),
          );
        } else {
          setRows((prev) => prev.map((r) => (r.id === id ? { ...r, saving: false, error: result.error?.message ?? 'Failed to create.' } : r)));
        }
      } else {
        const result = await Mpp_wl_activitiesService.update(id, payload);
        if (result.success) {
          setRows((prev) => prev.map((r) => (r.id === id ? { ...r, dirty: false, saving: false } : r)));
        } else {
          setRows((prev) => prev.map((r) => (r.id === id ? { ...r, saving: false, error: result.error?.message ?? 'Failed to save.' } : r)));
        }
      }
    } catch (err) {
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, saving: false, error: err instanceof Error ? err.message : 'Failed to save.' } : r)),
      );
    }
  };

  const deleteRow = async (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    if (row.isNew) {
      setRows((prev) => prev.filter((r) => r.id !== id));
      return;
    }
    const label = `${Mpp_wl_activitiesmpp_taskname[row.fields.mpp_taskname]}${row.fields.mpp_subtaskname ? ' ' + row.fields.mpp_subtaskname : ''}`;
    if (!window.confirm(`Delete activity "${label}"?`)) return;
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, saving: true } : r)));
    try {
      await Mpp_wl_activitiesService.delete(id);
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, saving: false, error: err instanceof Error ? err.message : 'Failed to delete.' } : r)));
    }
  };

  return (
    <Card
      title="WL_Activities"
      subtitle="Operator activities (Task/SubTask, Time, Numerator/Denominator, MachCondition) per Construction"
      actions={
        <div className="data-manager-actions">
          <Button variant="ghost" onClick={() => setReloadToken((t) => t + 1)} disabled={loading}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={addRow}>
            + Add Activity
          </Button>
        </div>
      }
    >
      {loadError && <p className="construction-selector-error">{loadError}</p>}
      {loading ? (
        <p className="data-manager-hint">Loading…</p>
      ) : (
        <>
          <div className="activities-construction-filter">
            <span className="toolbar-x">Filter by Construction</span>
            <SearchableSelect
              value={constructionFilter}
              onChange={setConstructionFilter}
              options={constructionOptions}
              placeholder="All Constructions"
              searchPlaceholder="Search Construction…"
            />
          </div>
          <div className="data-table-wrap">
          <table className="table activities-table">
            <thead>
              <tr>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_constructiontype')}>
                  Construction{sortIndicator('mpp_constructiontype')}
                </th>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_taskname')}>
                  Task{sortIndicator('mpp_taskname')}
                </th>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_subtaskname')}>
                  SubTask{sortIndicator('mpp_subtaskname')}
                </th>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_tasktime')}>
                  Time{sortIndicator('mpp_tasktime')}
                </th>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_numerator')}>
                  Numerator{sortIndicator('mpp_numerator')}
                </th>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_denominator')}>
                  Denominator{sortIndicator('mpp_denominator')}
                </th>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_machcondition')}>
                  MachCondition{sortIndicator('mpp_machcondition')}
                </th>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_productcode')}>
                  Product{sortIndicator('mpp_productcode')}
                </th>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_machinecode')}>
                  Mach{sortIndicator('mpp_machinecode')}
                </th>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_spooltype')}>
                  SpoolType{sortIndicator('mpp_spooltype')}
                </th>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_tensilegroup')}>
                  TensileGroup{sortIndicator('mpp_tensilegroup')}
                </th>
                <th className="table-sortable-header" onClick={() => toggleSort('mpp_laylength')}>
                  LayLength{sortIndicator('mpp_laylength')}
                </th>
                <th className="data-actions-header">
                  <CustomSortControl
                    columns={[
                      { key: 'mpp_constructiontype', label: 'Construction' },
                      { key: 'mpp_taskname', label: 'Task' },
                      { key: 'mpp_subtaskname', label: 'SubTask' },
                      { key: 'mpp_tasktime', label: 'Time' },
                      { key: 'mpp_numerator', label: 'Numerator' },
                      { key: 'mpp_denominator', label: 'Denominator' },
                      { key: 'mpp_machcondition', label: 'MachCondition' },
                      { key: 'mpp_productcode', label: 'Product' },
                      { key: 'mpp_machinecode', label: 'Mach' },
                      { key: 'mpp_spooltype', label: 'SpoolType' },
                      { key: 'mpp_tensilegroup', label: 'TensileGroup' },
                      { key: 'mpp_laylength', label: 'LayLength' },
                    ]}
                    levels={sortLevels}
                    onChange={setSortLevels}
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      className="input"
                      value={row.fields.mpp_constructiontype}
                      onChange={(e) => updateField(row.id, 'mpp_constructiontype', e.target.value)}
                    />
                  </td>
                  <td>
                    <select
                      className="input"
                      value={row.fields.mpp_taskname}
                      onChange={(e) => updateField(row.id, 'mpp_taskname', Number(e.target.value) as 0 | 1 | 2 | 3 | 4)}
                    >
                      {taskOptionsFor(row).map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="input"
                      placeholder="(parent task)"
                      value={row.fields.mpp_subtaskname}
                      onChange={(e) => updateField(row.id, 'mpp_subtaskname', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      type="number"
                      value={row.fields.mpp_tasktime}
                      onChange={(e) => updateField(row.id, 'mpp_tasktime', parseFloat(e.target.value) || 0)}
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      type="number"
                      value={row.fields.mpp_numerator}
                      onChange={(e) => updateField(row.id, 'mpp_numerator', parseFloat(e.target.value) || 0)}
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      type="number"
                      value={row.fields.mpp_denominator}
                      onChange={(e) => updateField(row.id, 'mpp_denominator', parseFloat(e.target.value) || 0)}
                    />
                  </td>
                  <td>
                    <select
                      className="input"
                      value={row.fields.mpp_machcondition}
                      onChange={(e) => updateField(row.id, 'mpp_machcondition', e.target.value as 'Stop' | 'Run')}
                    >
                      <option value="Stop">Stop</option>
                      <option value="Run">Run</option>
                    </select>
                  </td>
                  <td>
                    <input
                      className="input input-readonly"
                      value={row.fields.mpp_productcode}
                      readOnly
                      title="Derived from Construction — edit Construction instead"
                    />
                  </td>
                  <td>
                    <input
                      className="input input-readonly"
                      value={row.fields.mpp_machinecode}
                      readOnly
                      title="Derived from Construction — edit Construction instead"
                    />
                  </td>
                  <td>
                    <input
                      className="input input-readonly"
                      value={row.fields.mpp_spooltype}
                      readOnly
                      title="Derived from Construction — edit Construction instead"
                    />
                  </td>
                  <td>
                    <input
                      className="input input-readonly"
                      value={row.fields.mpp_tensilegroup}
                      readOnly
                      title="Derived from Construction — edit Construction instead"
                    />
                  </td>
                  <td>
                    <input
                      className="input input-readonly"
                      type="number"
                      value={row.fields.mpp_laylength}
                      readOnly
                      title="Derived from Construction — edit Construction instead"
                    />
                  </td>
                  <td className="data-row-actions">
                    <Button variant="primary" onClick={() => saveRow(row.id)} disabled={row.saving || !row.dirty}>
                      {row.saving ? 'Saving…' : 'Save'}
                    </Button>
                    <Button variant="danger" onClick={() => deleteRow(row.id)} disabled={row.saving}>
                      Delete
                    </Button>
                    {row.error && <span className="data-row-error">{row.error}</span>}
                  </td>
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={13} className="data-manager-hint">
                    {rows.length === 0
                      ? 'No activities yet — click "+ Add Activity" to create one.'
                      : `No activities for Construction "${constructionFilter}".`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </>
      )}
    </Card>
  );
}
