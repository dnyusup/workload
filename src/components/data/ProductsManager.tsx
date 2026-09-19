import { useCallback, useEffect, useMemo, useState } from 'react';
import { Mpp_wl_productsesService } from '../../generated/services/Mpp_wl_productsesService';
import type { Mpp_wl_productses, Mpp_wl_productsesBase } from '../../generated/models/Mpp_wl_productsesModel';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { PRODUCT_AREAS } from '../../types';
import { CustomSortControl, type CustomSortLevel } from './CustomSortControl';

interface ProductFields {
  mpp_constructiondetailcode: string;
  mpp_constructioncode: string;
  mpp_productspecification: string;
  mpp_machinecode: string;
  mpp_area: string;
  mpp_spooltype: string;
  mpp_tensilegroup: string;
  mpp_laylength: number;
  mpp_numberoffibers: number;
  mpp_speed: string;
  mpp_spoollength: number;
  mpp_lineardensity: string;
  mpp_fractureperton: string;
  mpp_dieston: string;
  mpp_defectston: string;
  mpp_polength1: number;
  mpp_polength2: number;
  mpp_polength3: number;
}

interface ProductRow {
  id: string;
  isNew: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  fields: ProductFields;
}

const COLUMNS: { key: keyof ProductFields; label: string; type: 'text' | 'number' | 'area'; readOnly?: boolean }[] = [
  { key: 'mpp_constructiondetailcode', label: 'ConstructionDetail', type: 'text', readOnly: true },
  { key: 'mpp_constructioncode', label: 'Construction', type: 'text', readOnly: true },
  { key: 'mpp_productspecification', label: 'Product', type: 'text' },
  { key: 'mpp_machinecode', label: 'Mach', type: 'text' },
  { key: 'mpp_area', label: 'Area', type: 'area' },
  { key: 'mpp_spooltype', label: 'SpoolType', type: 'text' },
  { key: 'mpp_tensilegroup', label: 'TensileGroup', type: 'text' },
  { key: 'mpp_laylength', label: 'LayLength', type: 'number' },
  { key: 'mpp_numberoffibers', label: 'NoOfWires', type: 'number' },
  { key: 'mpp_speed', label: 'Speed', type: 'text' },
  { key: 'mpp_spoollength', label: 'SpoolLength', type: 'number' },
  { key: 'mpp_lineardensity', label: 'LinearDensity', type: 'text' },
  { key: 'mpp_fractureperton', label: 'Fracture/Ton', type: 'text' },
  { key: 'mpp_dieston', label: 'Dies/Ton', type: 'text' },
  { key: 'mpp_defectston', label: 'Defect/Ton', type: 'text' },
  { key: 'mpp_polength1', label: 'POlength1', type: 'number' },
  { key: 'mpp_polength2', label: 'POlength2', type: 'number' },
  { key: 'mpp_polength3', label: 'POlength3', type: 'number' },
];

/** ConstructionDetail/Construction are derived, not hand-entered — ConstructionDetail joins
 * Mach-Product-LayLength-TensileGroup-SpoolType-SpoolLength-Speed with "-"; Construction is the
 * same join without SpoolLength or Speed. Recomputed on every edit to any of those source fields. */
const CONSTRUCTION_SOURCE_KEYS: (keyof ProductFields)[] = [
  'mpp_machinecode',
  'mpp_productspecification',
  'mpp_laylength',
  'mpp_tensilegroup',
  'mpp_spooltype',
  'mpp_spoollength',
  'mpp_speed',
];

function computeConstructionCodes(
  f: Pick<
    ProductFields,
    'mpp_machinecode' | 'mpp_productspecification' | 'mpp_laylength' | 'mpp_tensilegroup' | 'mpp_spooltype' | 'mpp_spoollength' | 'mpp_speed'
  >,
): { constructionCode: string; constructionDetailCode: string } {
  const base = [f.mpp_machinecode, f.mpp_productspecification, String(f.mpp_laylength), f.mpp_tensilegroup, f.mpp_spooltype];
  return {
    constructionCode: base.join('-'),
    constructionDetailCode: [...base, String(f.mpp_spoollength), f.mpp_speed].join('-'),
  };
}

/** Dies/Ton is only meaningful for these areas — elsewhere it's locked to whatever value is
 * already stored (usually blank). */
const DIES_TON_EDITABLE_AREAS = ['WW', 'CA', 'BA'];

function emptyFields(): ProductFields {
  return {
    mpp_constructiondetailcode: '',
    mpp_constructioncode: '',
    mpp_productspecification: '',
    mpp_machinecode: '',
    mpp_area: '',
    mpp_spooltype: '',
    mpp_tensilegroup: '',
    mpp_laylength: 0,
    mpp_numberoffibers: 0,
    mpp_speed: '',
    mpp_spoollength: 0,
    mpp_lineardensity: '',
    mpp_fractureperton: '',
    mpp_dieston: '',
    mpp_defectston: '',
    mpp_polength1: 0,
    mpp_polength2: 0,
    mpp_polength3: 0,
  };
}

function fieldsFromRecord(record: Mpp_wl_productses): ProductFields {
  const base = {
    mpp_productspecification: record.mpp_productspecification ?? '',
    mpp_machinecode: record.mpp_machinecode ?? '',
    mpp_area: record.mpp_area ?? '',
    mpp_spooltype: record.mpp_spooltype ?? '',
    mpp_tensilegroup: record.mpp_tensilegroup ?? '',
    mpp_laylength: record.mpp_laylength ?? 0,
    mpp_numberoffibers: record.mpp_numberoffibers ?? 0,
    mpp_speed: record.mpp_speed ?? '',
    mpp_spoollength: record.mpp_spoollength ?? 0,
    mpp_lineardensity: record.mpp_lineardensity ?? '',
    mpp_fractureperton: record.mpp_fractureperton ?? '',
    mpp_dieston: record.mpp_dieston ?? '',
    mpp_defectston: record.mpp_defectston ?? '',
    mpp_polength1: record.mpp_polength1 ?? 0,
    mpp_polength2: record.mpp_polength2 ?? 0,
    mpp_polength3: record.mpp_polength3 ?? 0,
  };
  const codes = computeConstructionCodes(base);
  return { ...base, mpp_constructioncode: codes.constructionCode, mpp_constructiondetailcode: codes.constructionDetailCode };
}

export function ProductsManager({
  onOpenActivitiesForConstruction,
}: {
  /** Double-clicking the Construction cell jumps to WL_Activities pre-filtered to that value. */
  onOpenActivitiesForConstruction?: (construction: string) => void;
} = {}) {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [areaFilter, setAreaFilter] = useState('');
  const [machineFilter, setMachineFilter] = useState('');
  const [sortLevels, setSortLevels] = useState<CustomSortLevel[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Mpp_wl_productsesService.getAll({ orderBy: ['mpp_constructiondetailcode asc'] })
      .then((result) => {
        if (cancelled) return;
        if (result.success) {
          setRows(
            (result.data ?? []).map((record) => ({
              id: record.mpp_wl_productsid,
              isNew: false,
              dirty: false,
              saving: false,
              error: null,
              fields: fieldsFromRecord(record),
            })),
          );
        } else {
          setLoadError(result.error?.message ?? 'Failed to load WL_Products.');
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load WL_Products.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const updateField = useCallback((id: string, key: keyof ProductFields, value: string | number) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        const fields = { ...row.fields, [key]: value };
        if (CONSTRUCTION_SOURCE_KEYS.includes(key)) {
          const codes = computeConstructionCodes(fields);
          fields.mpp_constructioncode = codes.constructionCode;
          fields.mpp_constructiondetailcode = codes.constructionDetailCode;
        }
        return { ...row, dirty: true, fields };
      }),
    );
  }, []);

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { id: `new-${Date.now()}`, isNew: true, dirty: true, saving: false, error: null, fields: emptyFields() },
    ]);
  };

  const saveRow = async (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, saving: true, error: null } : r)));
    const payload: Omit<Mpp_wl_productsesBase, 'mpp_wl_productsid'> = { ...row.fields, statecode: 0 };
    try {
      if (row.isNew) {
        const result = await Mpp_wl_productsesService.create(payload);
        if (result.success) {
          setRows((prev) =>
            prev.map((r) => (r.id === id ? { ...r, id: result.data.mpp_wl_productsid, isNew: false, dirty: false, saving: false } : r)),
          );
        } else {
          setRows((prev) => prev.map((r) => (r.id === id ? { ...r, saving: false, error: result.error?.message ?? 'Failed to create.' } : r)));
        }
      } else {
        const result = await Mpp_wl_productsesService.update(id, payload);
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
    if (!window.confirm(`Delete Construction Detail "${row.fields.mpp_constructiondetailcode || id}"?`)) return;
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, saving: true } : r)));
    try {
      await Mpp_wl_productsesService.delete(id);
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, saving: false, error: err instanceof Error ? err.message : 'Failed to delete.' } : r)));
    }
  };

  const toggleSort = (key: keyof ProductFields) => {
    setSortLevels((prev) => {
      const current = prev[0];
      return current?.key === key ? [{ key, dir: current.dir === 'asc' ? 'desc' : 'asc' }] : [{ key, dir: 'asc' }];
    });
  };

  const visibleRows = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (areaFilter && row.fields.mpp_area !== areaFilter) return false;
      if (machineFilter && row.fields.mpp_machinecode !== machineFilter) return false;
      return !q || COLUMNS.some((col) => String(row.fields[col.key]).toLowerCase().includes(q));
    });
    if (!sortLevels.length) return filtered;
    return [...filtered].sort((a, b) => {
      for (const { key, dir } of sortLevels) {
        const av = a.fields[key as keyof ProductFields];
        const bv = b.fields[key as keyof ProductFields];
        const sign = dir === 'asc' ? 1 : -1;
        const comparison =
          typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
        if (comparison !== 0) return comparison * sign;
      }
      return 0;
    });
  }, [rows, searchTerm, areaFilter, machineFilter, sortLevels]);

  const sortIndicator = (key: keyof ProductFields) => {
    const level = sortLevels.findIndex((item) => item.key === key);
    if (level < 0) return '';
    const direction = sortLevels[level].dir === 'asc' ? '▲' : '▼';
    return ` ${level + 1}${direction}`;
  };

  const machineOptions = useMemo(
    () =>
      [...new Set(rows.map((row) => row.fields.mpp_machinecode.trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
      ),
    [rows],
  );

  return (
    <Card
      title="WL_Products"
      subtitle="Master data: machine & product specification per Construction Detail"
      actions={
        <div className="data-manager-actions">
          <Button variant="ghost" onClick={() => setReloadToken((t) => t + 1)} disabled={loading}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={addRow}>
            + Add Product
          </Button>
        </div>
      }
    >
      {loadError && <p className="construction-selector-error">{loadError}</p>}
      {loading ? (
        <p className="data-manager-hint">Loading…</p>
      ) : (
        <>
          <div className="products-filters">
            <input
              className="input list-search-input"
              placeholder="Search all columns…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <select className="input" value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)}>
              <option value="">All areas</option>
              {PRODUCT_AREAS.map((area) => (
                <option key={area} value={area}>
                  Area: {area}
                </option>
              ))}
            </select>
            <select className="input" value={machineFilter} onChange={(e) => setMachineFilter(e.target.value)}>
              <option value="">All machines</option>
              {machineOptions.map((machine) => (
                <option key={machine} value={machine}>
                  Machine: {machine}
                </option>
              ))}
            </select>
          </div>
          <div className="data-table-wrap">
            <table className="table products-table">
              <thead>
                <tr>
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={`table-sortable-header ${col.key === 'mpp_area' ? 'products-area-column' : ''}`}
                      onClick={() => toggleSort(col.key)}
                    >
                      {col.label}
                      <span className="table-sort-indicator">{sortIndicator(col.key)}</span>
                    </th>
                  ))}
                  <th className="data-actions-header">
                    <CustomSortControl
                      columns={COLUMNS.map(({ key, label }) => ({ key, label }))}
                      levels={sortLevels}
                      onChange={setSortLevels}
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.id}>
                    {COLUMNS.map((col) => {
                      const readOnly =
                        col.key === 'mpp_dieston'
                          ? !DIES_TON_EDITABLE_AREAS.includes(row.fields.mpp_area)
                          : col.readOnly;
                      return (
                      <td
                        key={col.key}
                        className={col.key === 'mpp_area' ? 'products-area-column' : undefined}
                        onDoubleClick={
                          col.key === 'mpp_constructioncode' && row.fields.mpp_constructioncode
                            ? () => onOpenActivitiesForConstruction?.(row.fields.mpp_constructioncode)
                            : undefined
                        }
                        title={col.key === 'mpp_constructioncode' ? 'Double-click to view this Construction in WL_Activities' : undefined}
                      >
                        {col.type === 'area' ? (
                          <select
                            className="input"
                            value={row.fields[col.key]}
                            onChange={(e) => updateField(row.id, col.key, e.target.value)}
                          >
                            <option value="">Select area</option>
                            {PRODUCT_AREAS.map((area) => (
                              <option key={area} value={area}>
                                {area}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className={`input ${readOnly ? 'input-readonly' : ''}`}
                            type={col.type}
                            value={row.fields[col.key]}
                            readOnly={readOnly}
                            title={
                              col.readOnly
                                ? 'Auto-generated from Mach/Product/LayLength/TensileGroup/SpoolType(/SpoolLength)'
                                : col.key === 'mpp_dieston' && readOnly
                                  ? 'Dies/Ton is only editable for area WW, CA, BA'
                                  : undefined
                            }
                            onChange={(e) =>
                              readOnly
                                ? undefined
                                : updateField(row.id, col.key, col.type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value)
                            }
                          />
                        )}
                      </td>
                      );
                    })}
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
                    <td colSpan={COLUMNS.length + 1} className="data-manager-hint">
                      {rows.length === 0 ? 'No products yet — click "+ Add Product" to create one.' : `No products match "${searchTerm}".`}
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
