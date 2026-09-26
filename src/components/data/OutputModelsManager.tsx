import { useEffect, useMemo, useState } from 'react';
import { Mpp_wl_outputmodelsesService } from '../../generated/services/Mpp_wl_outputmodelsesService';
import type { Mpp_wl_outputmodelses } from '../../generated/models/Mpp_wl_outputmodelsesModel';
import { fetchAllPages } from '../../lib/dataversePaging';
import { outputModelVersionNumber } from '../../lib/outputModel';
import { OUTPUT_MODEL_COLUMNS, formatOutputModelValue, type OutputModelKey } from '../../lib/outputModelColumns';
import { OutputModelDetailDialog } from './OutputModelDetailDialog';
import { downloadOutputModelRows } from '../../lib/outputModelExport';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { SearchableSelect, type SearchableSelectOption } from '../ui/SearchableSelect';
import { CustomSortControl, type CustomSortLevel } from './CustomSortControl';
import type { MachineStartCondition } from '../../types';

type OutputModelFilterKey = 'area' | 'machine' | 'construction' | 'spoolType';

interface OutputModelFilters {
  area: string;
  machine: string;
  construction: string;
  spoolType: string;
}

function comparableValue(record: Mpp_wl_outputmodelses, key: OutputModelKey): string | number {
  const value = record[key];
  return typeof value === 'number' ? value : String(value ?? '');
}

function normalizedFilterValue(value: unknown): string {
  return String(value ?? '').trim();
}

function matchesOutputModelSearch(row: Mpp_wl_outputmodelses, query: string): boolean {
  if (!query) return true;
  return [
    row.mpp_constructiondetailcode,
    row.mpp_construction,
    row.mpp_areacode,
    row.mpp_productcode,
    row.mpp_updatedby,
  ].some((value) => String(value ?? '').toLowerCase().includes(query));
}

function matchesOutputModelFilters(
  row: Mpp_wl_outputmodelses,
  filters: OutputModelFilters,
  excludedFilter?: OutputModelFilterKey,
): boolean {
  if (excludedFilter !== 'area' && filters.area && normalizedFilterValue(row.mpp_areacode) !== filters.area) return false;
  if (excludedFilter !== 'machine' && filters.machine && normalizedFilterValue(row.mpp_machinecode) !== filters.machine) return false;
  if (excludedFilter !== 'construction' && filters.construction && normalizedFilterValue(row.mpp_construction) !== filters.construction) {
    return false;
  }
  if (excludedFilter !== 'spoolType' && filters.spoolType && normalizedFilterValue(row.mpp_spooltype) !== filters.spoolType) {
    return false;
  }
  return true;
}

function filterOptions(
  rows: Mpp_wl_outputmodelses[],
  searchQuery: string,
  filters: OutputModelFilters,
  key: OutputModelFilterKey,
  field: keyof Mpp_wl_outputmodelses,
  currentValue: string,
  label: string,
): SearchableSelectOption[] {
  const values = rows
    .filter((row) => matchesOutputModelSearch(row, searchQuery) && matchesOutputModelFilters(row, filters, key))
    .map((row) => normalizedFilterValue(row[field]))
    .filter(Boolean);
  const uniqueValues = [...new Set([...values, currentValue].filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }),
  );
  return uniqueValues.map((value) => ({ value, label: `${label}: ${value}` }));
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
  const [detailRow, setDetailRow] = useState<Mpp_wl_outputmodelses | null>(null);
  const [search, setSearch] = useState('');
  const [sortLevels, setSortLevels] = useState<CustomSortLevel[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [areaFilter, setAreaFilter] = useState('');
  const [machineFilter, setMachineFilter] = useState('');
  const [constructionFilter, setConstructionFilter] = useState('');
  const [spoolTypeFilter, setSpoolTypeFilter] = useState('');

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

  const deleteOutputModel = async (row: Mpp_wl_outputmodelses) => {
    const version = row.mpp_version ?? '0001';
    if (outputModelVersionNumber(row.mpp_version) <= 1 || deletingId) return;
    if (
      !window.confirm(
        `Delete output model version ${version} for "${row.mpp_constructiondetailcode ?? 'this Construction Detail'}"?`,
      )
    ) {
      return;
    }
    setDeletingId(row.mpp_wl_outputmodelsid);
    setLoadError(null);
    try {
      await Mpp_wl_outputmodelsesService.delete(row.mpp_wl_outputmodelsid);
      setRows((current) => current.filter((item) => item.mpp_wl_outputmodelsid !== row.mpp_wl_outputmodelsid));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : `Failed to delete output model version ${version}.`);
    } finally {
      setDeletingId(null);
    }
  };

  const visibleRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filters = {
      area: areaFilter,
      machine: machineFilter,
      construction: constructionFilter,
      spoolType: spoolTypeFilter,
    };
    const filtered = rows.filter(
      (row) => matchesOutputModelSearch(row, query) && matchesOutputModelFilters(row, filters),
    );
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
  }, [rows, search, areaFilter, machineFilter, constructionFilter, spoolTypeFilter, sortLevels]);

  const outputModelFilters = useMemo<OutputModelFilters>(
    () => ({
      area: areaFilter,
      machine: machineFilter,
      construction: constructionFilter,
      spoolType: spoolTypeFilter,
    }),
    [areaFilter, machineFilter, constructionFilter, spoolTypeFilter],
  );
  const searchQuery = search.trim().toLowerCase();
  const areaOptions = useMemo(
    () =>
      filterOptions(
        rows,
        searchQuery,
        outputModelFilters,
        'area',
        'mpp_areacode',
        areaFilter,
        'Area',
      ),
    [rows, searchQuery, outputModelFilters, areaFilter],
  );
  const machineOptions = useMemo(
    () =>
      filterOptions(
        rows,
        searchQuery,
        outputModelFilters,
        'machine',
        'mpp_machinecode',
        machineFilter,
        'Mach',
      ),
    [rows, searchQuery, outputModelFilters, machineFilter],
  );
  const constructionOptions = useMemo(
    () =>
      filterOptions(
        rows,
        searchQuery,
        outputModelFilters,
        'construction',
        'mpp_construction',
        constructionFilter,
        'Construction',
      ),
    [rows, searchQuery, outputModelFilters, constructionFilter],
  );
  const spoolTypeOptions = useMemo(
    () =>
      filterOptions(
        rows,
        searchQuery,
        outputModelFilters,
        'spoolType',
        'mpp_spooltype',
        spoolTypeFilter,
        'Spool Type',
      ),
    [rows, searchQuery, outputModelFilters, spoolTypeFilter],
  );

  const exportExcel = () => {
    const date = new Date().toISOString().slice(0, 10);
    downloadOutputModelRows(visibleRows, `wl-outputmodels-${date}.csv`);
  };

  const clearFilters = () => {
    setSearch('');
    setAreaFilter('');
    setMachineFilter('');
    setConstructionFilter('');
    setSpoolTypeFilter('');
  };

  const hasActiveFilters = Boolean(search || areaFilter || machineFilter || constructionFilter || spoolTypeFilter);

  return (
    <Card
      title="WL_Outputmodels"
      subtitle="Saved workload simulation output models"
      actions={
        <div className="data-manager-actions">
          <Button variant="ghost" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={exportExcel} disabled={loading || visibleRows.length === 0}>
            📊 Export
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
        <>
          <div className="output-models-filters">
            <input
              className="input output-models-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search all columns…"
              aria-label="Search output model"
            />
            <SearchableSelect
              value={areaFilter}
              onChange={setAreaFilter}
              options={areaOptions}
              placeholder="All areas"
              searchPlaceholder="Search area…"
              className="output-model-filter"
            />
            <SearchableSelect
              value={machineFilter}
              onChange={setMachineFilter}
              options={machineOptions}
              placeholder="All machines"
              searchPlaceholder="Search Mach…"
              className="output-model-filter"
            />
            <SearchableSelect
              value={constructionFilter}
              onChange={setConstructionFilter}
              options={constructionOptions}
              placeholder="All constructions"
              searchPlaceholder="Search construction…"
              className="output-model-filter"
            />
            <SearchableSelect
              value={spoolTypeFilter}
              onChange={setSpoolTypeFilter}
              options={spoolTypeOptions}
              placeholder="All spool types"
              searchPlaceholder="Search spool type…"
              className="output-model-filter"
            />
            <Button variant="ghost" onClick={clearFilters} disabled={!hasActiveFilters}>
              <span aria-hidden="true">✕</span> Clear filters
            </Button>
          </div>
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
                  <tr
                    key={row.mpp_wl_outputmodelsid}
                    className="output-model-row"
                    onDoubleClick={() => setDetailRow(row)}
                    title="Double-click to view details"
                  >
                    {OUTPUT_MODEL_COLUMNS.map((column) => (
                      <td key={column.key}>{formatOutputModelValue(row[column.key], column.key)}</td>
                    ))}
                    {onUseStartCondition && (
                      <td className="data-row-actions" onDoubleClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          onClick={() => loadStartCondition(row)}
                          disabled={!row.mpp_startmachcondition}
                          title="Use the inherited machine condition for the next simulation"
                        >
                          Use Start Condition
                        </Button>
                        {outputModelVersionNumber(row.mpp_version) > 1 && (
                          <Button
                            variant="danger"
                            onClick={() => void deleteOutputModel(row)}
                            disabled={deletingId !== null}
                            title={`Delete version ${row.mpp_version ?? '0001'}`}
                            aria-label={`Delete output model version ${row.mpp_version ?? '0001'}`}
                          >
                            <span aria-hidden="true">🗑</span> Delete
                          </Button>
                        )}
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
        </>
      )}
      {detailRow && <OutputModelDetailDialog row={detailRow} onClose={() => setDetailRow(null)} />}
    </Card>
  );
}
