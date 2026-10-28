import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  loadFrequencyCatalog,
  getActiveFrequencyFilterParams,
  computeFrequencyDateRange,
  type FrequencyRecord,
  type ActiveFrequencyFilterParams,
  type LoadFrequencyOptions,
} from '../../lib/frequencyCatalog';
import { loadDefaultValuesOrBuiltIn, type FrequencyDateRangeType } from '../../lib/defaultValuesStore';
import { usePagedRows } from '../../hooks/usePagedRows';
import { TablePager } from '../ui/TablePager';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { DateInput } from '../ui/Field';
import { FloatingScrollbar } from '../ui/FloatingScrollbar';
import { SearchableSelect, type SearchableSelectOption } from '../ui/SearchableSelect';


type SortKey =
  | 'area'
  | 'zoneName'
  | 'group'
  | 'construction'
  | 'layLength'
  | 'tensileStrength'
  | 'tonProduced'
  | 'fracturePerTon'
  | 'defectPerTon'
  | 'diesPerTon'
  | 'groupProductInfo';

const DAX_QUERY_CODE = `EVALUATE
ADDCOLUMNS(
    SUMMARIZECOLUMNS(
        DimZone[ZoneName],
        McGroup[Group],
        DimProduct[Construction],
        DimProduct[LayLength],
        DimProduct[TensileStrength],

        -- Filter Plant
        TREATAS({"PTBI"}, DimPlantRegion[PlantName]),
		
        -- 2. FILTER DATE BETWEEN (START DATE & END DATE)
        FILTER(
            ALL(DimDate[Date]), 
            DimDate[Date] >= DATE(2026, 10, 20) && DimDate[Date] <= DATE(2026, 10, 27)
        ),

        -- Aggregation Values (For Measure, enclose in square brackets [ ])
        "Fr/T", [Fracture/Ton (#)],
        "Def/T", [Def/Ton (#)],
        "Dies/T", [Die/Ton (#)],
        "TonProduced", [TonProduced]
    ),
    -- MERGE 4 COLUMNS WITH "-" DELIMITER:
    "Group_Product_Info", 
        McGroup[Group] & "-" & 
        DimProduct[Construction] & "-" & 
        DimProduct[LayLength] & "-" & 
        DimProduct[TensileStrength],
    "Area", Left(DimZone[ZoneName], 2)
)`;

export function FrequencyManager() {
  const [rows, setRows] = useState<FrequencyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [activeParams, setActiveParams] = useState<ActiveFrequencyFilterParams | null>(getActiveFrequencyFilterParams());
  const [copiedDax, setCopiedDax] = useState(false);
  const [showDaxModal, setShowDaxModal] = useState(false);

  // Date Range Filter States
  const [dateRangeType, setDateRangeType] = useState<FrequencyDateRangeType>('last1Year');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Filters & Search
  const [search, setSearch] = useState('');
  const [areaFilter, setAreaFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [constructionFilter, setConstructionFilter] = useState('');

  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>('groupProductInfo');
  const [sortAsc, setSortAsc] = useState(true);

  const tableWrapRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async (customOpts?: LoadFrequencyOptions) => {
    setLoading(true);
    setError(null);
    try {
      const defaults = await loadDefaultValuesOrBuiltIn();
      let start = customOpts?.startDate;
      let end = customOpts?.endDate;
      let type = customOpts?.dateRangeType;

      if (!start || !end) {
        if (startDate && endDate) {
          start = startDate;
          end = endDate;
          type = dateRangeType;
        } else {
          type = defaults.frequencyDateRangeType;
          const computed = computeFrequencyDateRange(type, defaults.frequencyStartDate, defaults.frequencyEndDate);
          start = computed.startDate;
          end = computed.endDate;
        }
      }

      setStartDate(start);
      setEndDate(end);
      if (type) setDateRangeType(type);

      const { records } = await loadFrequencyCatalog({
        startDate: start,
        endDate: end,
        dateRangeType: type,
        forceRefresh: true,
      });
      setRows(records);
      setActiveParams(getActiveFrequencyFilterParams());
      setLastRefreshed(new Date());
    } catch (err) {
      console.error('Failed to run WL_Frequency flow:', err);
      const msg = err instanceof Error ? err.message : 'Failed to execute Power Automate flow WL_Frequency.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, dateRangeType]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handlePresetChange = (type: FrequencyDateRangeType) => {
    setDateRangeType(type);
    if (type !== 'custom') {
      const range = computeFrequencyDateRange(type);
      setStartDate(range.startDate);
      setEndDate(range.endDate);
      void fetchData({ startDate: range.startDate, endDate: range.endDate, dateRangeType: type, forceRefresh: true });
    }
  };

  const handleStartDateChange = (val: string) => {
    setStartDate(val);
    setDateRangeType('custom');
  };

  const handleEndDateChange = (val: string) => {
    setEndDate(val);
    setDateRangeType('custom');
  };

  const handleApplyDate = () => {
    if (!startDate || !endDate) return;
    void fetchData({ startDate, endDate, dateRangeType: 'custom', forceRefresh: true });
  };

  const handleResetToDefaultRange = async () => {
    setLoading(true);
    try {
      const defaults = await loadDefaultValuesOrBuiltIn();
      const range = computeFrequencyDateRange(
        defaults.frequencyDateRangeType,
        defaults.frequencyStartDate,
        defaults.frequencyEndDate,
      );
      setDateRangeType(defaults.frequencyDateRangeType);
      setStartDate(range.startDate);
      setEndDate(range.endDate);
      await fetchData({
        startDate: range.startDate,
        endDate: range.endDate,
        dateRangeType: defaults.frequencyDateRangeType,
        forceRefresh: true,
      });
    } catch (err) {
      console.warn('Failed to reset to default range:', err);
      setLoading(false);
    }
  };

  // Unique options for filters
  const areaOptions: SearchableSelectOption[] = useMemo(() => {
    const areas = [...new Set(rows.map((r) => r.area).filter(Boolean))].sort();
    return areas.map((a) => ({ value: a, label: `Area: ${a}` }));
  }, [rows]);

  const groupOptions: SearchableSelectOption[] = useMemo(() => {
    const groups = [...new Set(rows.map((r) => r.group).filter(Boolean))].sort();
    return groups.map((g) => ({ value: g, label: `Group: ${g}` }));
  }, [rows]);

  const constructionOptions: SearchableSelectOption[] = useMemo(() => {
    const constructions = [...new Set(rows.map((r) => r.construction).filter(Boolean))].sort();
    return constructions.map((c) => ({ value: c, label: `Construction: ${c}` }));
  }, [rows]);

  // Filtered & Sorted
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (areaFilter && r.area !== areaFilter) return false;
      if (groupFilter && r.group !== groupFilter) return false;
      if (constructionFilter && r.construction !== constructionFilter) return false;
      if (query) {
        const text = `${r.area} ${r.zoneName} ${r.group} ${r.construction} ${r.groupProductInfo} ${r.tensileStrength}`.toLowerCase();
        if (!text.includes(query)) return false;
      }
      return true;
    });
  }, [rows, areaFilter, groupFilter, constructionFilter, search]);

  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
    list.sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];

      if (valA === valB) return 0;
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;

      let cmp = 0;
      if (typeof valA === 'number' && typeof valB === 'number') {
        cmp = valA - valB;
      } else {
        cmp = String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
      }
      return sortAsc ? cmp : -cmp;
    });
    return list;
  }, [filteredRows, sortKey, sortAsc]);

  const paged = usePagedRows(
    sortedRows,
    `${search}|${areaFilter}|${groupFilter}|${constructionFilter}|${sortKey}|${sortAsc}`,
    50,
  );

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return ' ↕';
    return sortAsc ? ' ↑' : ' ↓';
  };

  // Metrics summary (SumProduct / Weighted Average based on TonProduced)
  const summaryMetrics = useMemo(() => {
    if (filteredRows.length === 0) {
      return {
        total: 0,
        totalTon: 0,
        sumProductFr: 0,
        sumProductDef: 0,
        sumProductDies: 0,
        weightedFr: 0,
        weightedDef: 0,
        weightedDies: 0,
      };
    }
    let totalTon = 0;
    let sumProductFr = 0;
    let sumProductDef = 0;
    let sumProductDies = 0;

    for (const r of filteredRows) {
      const ton = r.tonProduced ?? 0;
      totalTon += ton;
      if (r.fracturePerTon !== null) {
        sumProductFr += r.fracturePerTon * ton;
      }
      if (r.defectPerTon !== null) {
        sumProductDef += r.defectPerTon * ton;
      }
      if (r.diesPerTon !== null) {
        sumProductDies += r.diesPerTon * ton;
      }
    }

    return {
      total: filteredRows.length,
      totalTon,
      sumProductFr,
      sumProductDef,
      sumProductDies,
      weightedFr: totalTon > 0 ? sumProductFr / totalTon : 0,
      weightedDef: totalTon > 0 ? sumProductDef / totalTon : 0,
      weightedDies: totalTon > 0 ? sumProductDies / totalTon : 0,
    };
  }, [filteredRows]);

  const handleExportCsv = () => {
    const headers = [
      'Area',
      'ZoneName',
      'McGroup',
      'Construction',
      'LayLength',
      'TensileStrength',
      'TonProduced',
      'Fr/T',
      'Def/T',
      'Dies/T',
      'Group_Product_Info',
    ];
    const csvLines = sortedRows.map((r) => [
      `"${r.area}"`,
      `"${r.zoneName.replace(/"/g, '""')}"`,
      `"${r.group.replace(/"/g, '""')}"`,
      `"${r.construction.replace(/"/g, '""')}"`,
      r.layLength,
      `"${r.tensileStrength.replace(/"/g, '""')}"`,
      r.tonProduced ?? '',
      r.fracturePerTon ?? '',
      r.defectPerTon ?? '',
      r.diesPerTon ?? '',
      `"${r.groupProductInfo.replace(/"/g, '""')}"`,
    ]);

    const csvContent = [headers.join(','), ...csvLines.map((l) => l.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `WL_Frequency_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const clearFilters = () => {
    setSearch('');
    setAreaFilter('');
    setGroupFilter('');
    setConstructionFilter('');
  };

  const hasActiveFilters = Boolean(
    search || areaFilter || groupFilter || constructionFilter,
  );

  return (
    <div className="frequency-manager">
      <Card
        title="WL_Frequency"
        subtitle="Power BI Semantic Model data (MES Data) via Power Automate Flow (WL_Frequency)"
        actions={
          <div className="data-manager-actions">
            <Button variant="ghost" onClick={() => void fetchData({ forceRefresh: true })} disabled={loading} title="Run flow again to fetch latest data">
              {loading ? 'Refreshing…' : '🔄 Refresh Data'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setShowDaxModal(true)}
              title="View DAX Query and Power Automate flow architecture"
            >
              ℹ️ DAX & Flow Info
            </Button>
            <Button
              variant="secondary"
              onClick={handleExportCsv}
              disabled={loading || sortedRows.length === 0}
              title="Export visible records to CSV"
            >
              📊 Export CSV
            </Button>
          </div>
        }
      >
        {/* Active Filter Info & Editable Date Range Banner */}
        <div className="frequency-active-filter-banner">
          <span className="frequency-filter-banner-item">
            🏭 Plant: <strong>{activeParams?.plant ?? 'PTBI'}</strong>
          </span>

          <span className="frequency-filter-banner-divider">|</span>

          <div className="frequency-date-controls">
            <span className="frequency-filter-banner-item">
              📅 Period:
            </span>

            <select
              className="frequency-date-preset-select"
              value={dateRangeType}
              onChange={(e) => handlePresetChange(e.target.value as FrequencyDateRangeType)}
              disabled={loading}
              title="Select date range preset"
            >
              <option value="last7Days">Last 7 Days</option>
              <option value="last14Days">Last 14 Days</option>
              <option value="last30Days">Last 30 Days</option>
              <option value="last3Months">Last 3 Months</option>
              <option value="last6Months">Last 6 Months</option>
              <option value="last1Year">Last 1 Year</option>
              <option value="custom">Custom Range</option>
            </select>

            <DateInput
              value={startDate}
              onChange={handleStartDateChange}
              disabled={loading}
              className="frequency-date-input"
            />
            <span className="frequency-date-sep">to</span>
            <DateInput
              value={endDate}
              onChange={handleEndDateChange}
              disabled={loading}
              className="frequency-date-input"
            />

            <button
              type="button"
              className="frequency-date-apply-btn"
              onClick={handleApplyDate}
              disabled={loading || !startDate || !endDate}
              title="Apply date range and query MES Data"
            >
              {loading ? 'Querying…' : 'Apply'}
            </button>

            <button
              type="button"
              className="frequency-date-reset-btn"
              title="Reset date range to default from Settings"
              aria-label="Reset date range to default from Settings"
              disabled={loading}
              onClick={() => void handleResetToDefaultRange()}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          </div>

          <span className="frequency-filter-banner-hint">
            (Default configured in Setting → Default Values)
          </span>
        </div>

        {/* KPI Summary Cards */}
        <div className="frequency-kpi-grid">
          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">Total Records</span>
            <span className="frequency-kpi-value">{summaryMetrics.total.toLocaleString()}</span>
            <span className="frequency-kpi-sub">
              {lastRefreshed ? `Updated ${lastRefreshed.toLocaleTimeString()}` : 'Not loaded yet'}
            </span>
          </div>
          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">Ton Produced</span>
            <span className="frequency-kpi-value text-accent-green">
              {summaryMetrics.totalTon > 0
                ? summaryMetrics.totalTon.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
                : '0.0'}
            </span>
            <span className="frequency-kpi-sub">Total Volume (Ton)</span>
          </div>
          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">Fr / T (Weighted)</span>
            <span className="frequency-kpi-value text-accent-cyan">
              {summaryMetrics.weightedFr > 0 ? summaryMetrics.weightedFr.toFixed(3) : '0.000'}
            </span>
            <span className="frequency-kpi-sub" title="SumProduct = Σ (Fr/T × TonProduced)">
              Σ {Math.round(summaryMetrics.sumProductFr).toLocaleString()} fracture events
            </span>
          </div>
          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">Def / T (Weighted)</span>
            <span className="frequency-kpi-value text-accent-amber">
              {summaryMetrics.weightedDef > 0 ? summaryMetrics.weightedDef.toFixed(3) : '0.000'}
            </span>
            <span className="frequency-kpi-sub" title="SumProduct = Σ (Def/T × TonProduced)">
              Σ {Math.round(summaryMetrics.sumProductDef).toLocaleString()} defect events
            </span>
          </div>
          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">Dies / T (Weighted)</span>
            <span className="frequency-kpi-value text-accent-purple">
              {summaryMetrics.weightedDies > 0 ? summaryMetrics.weightedDies.toFixed(3) : '0.000'}
            </span>
            <span className="frequency-kpi-sub" title="SumProduct = Σ (Dies/T × TonProduced)">
              Σ {Math.round(summaryMetrics.sumProductDies).toLocaleString()} die change events
            </span>
          </div>
        </div>

        {error && (
          <div className="frequency-alert-error">
            <span className="frequency-alert-icon">⚠️</span>
            <div className="frequency-alert-body">
              <strong>Error Loading Data:</strong> {error}
              <div className="frequency-alert-actions">
                <Button variant="ghost" onClick={() => void fetchData({ forceRefresh: true })} disabled={loading}>
                  Try Again
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Filters and search */}
        <div className="frequency-filters-bar">
          <input
            className="input frequency-search-input"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Group_Product_Info, Construction, McGroup…"
            aria-label="Search frequency records"
          />
          <SearchableSelect
            value={areaFilter}
            onChange={setAreaFilter}
            options={areaOptions}
            placeholder="All Areas"
            searchPlaceholder="Search Area…"
            className="frequency-filter-select"
          />
          <SearchableSelect
            value={groupFilter}
            onChange={setGroupFilter}
            options={groupOptions}
            placeholder="All Groups"
            searchPlaceholder="Search McGroup…"
            className="frequency-filter-select"
          />
          <SearchableSelect
            value={constructionFilter}
            onChange={setConstructionFilter}
            options={constructionOptions}
            placeholder="All Constructions"
            searchPlaceholder="Search Construction…"
            className="frequency-filter-select"
          />
          {hasActiveFilters && (
            <Button variant="ghost" onClick={clearFilters} title="Reset all search filters">
              ✕ Clear
            </Button>
          )}
        </div>

        {loading ? (
          <div className="frequency-loading-state">
            <div className="frequency-spinner" />
            <p>Running Power BI query via Power Automate flow…</p>
            <span className="frequency-loading-sub">Fetching DAX query results from Semantic Model</span>
          </div>
        ) : sortedRows.length === 0 ? (
          <div className="frequency-empty-state">
            <span className="frequency-empty-icon">📂</span>
            <h4>No records found</h4>
            <p>
              {hasActiveFilters
                ? 'No rows match the current filter criteria.'
                : 'Click "Refresh Data" to load records from Power Automate Flow.'}
            </p>
            {hasActiveFilters && (
              <Button variant="secondary" onClick={clearFilters}>
                Reset Filters
              </Button>
            )}
          </div>
        ) : (
          <>
            <TablePager
              page={paged.page}
              pageCount={paged.pageCount}
              pageSize={paged.pageSize}
              total={paged.total}
              onPageChange={paged.setPage}
              label="frequency data rows"
            />
            <div className="data-table-wrap" ref={tableWrapRef}>
              <table className="table frequency-table">
                <thead>
                  <tr>
                    <th className="table-sortable-header" onClick={() => toggleSort('area')}>
                      Area {sortIndicator('area')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('zoneName')}>
                      Zone Name {sortIndicator('zoneName')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('group')}>
                      McGroup {sortIndicator('group')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('construction')}>
                      Construction {sortIndicator('construction')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('layLength')}>
                      Lay Length {sortIndicator('layLength')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('tensileStrength')}>
                      Tensile {sortIndicator('tensileStrength')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('tonProduced')}>
                      Ton Produced {sortIndicator('tonProduced')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('fracturePerTon')}>
                      Fr/T {sortIndicator('fracturePerTon')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('defectPerTon')}>
                      Def/T {sortIndicator('defectPerTon')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('diesPerTon')}>
                      Dies/T {sortIndicator('diesPerTon')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('groupProductInfo')}>
                      Group_Product_Info {sortIndicator('groupProductInfo')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paged.pageRows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <span className="frequency-area-badge">{row.area || '-'}</span>
                      </td>
                      <td>{row.zoneName || '-'}</td>
                      <td>
                        <strong>{row.group || '-'}</strong>
                      </td>
                      <td>{row.construction || '-'}</td>
                      <td>{row.layLength !== '' ? row.layLength : '-'}</td>
                      <td>{row.tensileStrength || '-'}</td>
                      <td className="numeric-col">
                        <span className="frequency-num-ton">
                          {row.tonProduced !== null
                            ? row.tonProduced.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })
                            : '-'}
                        </span>
                      </td>
                      <td className="numeric-col">
                        <span className="frequency-num-fr">
                          {row.fracturePerTon !== null ? row.fracturePerTon.toFixed(3) : '-'}
                        </span>
                      </td>
                      <td className="numeric-col">
                        <span className="frequency-num-def">
                          {row.defectPerTon !== null ? row.defectPerTon.toFixed(3) : '-'}
                        </span>
                      </td>
                      <td className="numeric-col">
                        <span className="frequency-num-dies">
                          {row.diesPerTon !== null ? row.diesPerTon.toFixed(3) : '-'}
                        </span>
                      </td>
                      <td>
                        <code className="frequency-code-tag">{row.groupProductInfo || '-'}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager
              page={paged.page}
              pageCount={paged.pageCount}
              pageSize={paged.pageSize}
              total={paged.total}
              onPageChange={paged.setPage}
              label="frequency data rows"
            />
            <FloatingScrollbar targetRef={tableWrapRef} />
          </>
        )}
      </Card>

      {/* DAX Query & Flow Architecture Dialog Modal Popup */}
      {showDaxModal && (
        <div className="modal-backdrop frequency-dax-overlay" onClick={() => setShowDaxModal(false)}>
          <div
            className="frequency-dax-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Power BI DAX & Flow Integration"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="frequency-dax-modal-header"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                padding: '16px 20px',
                borderBottom: '1px solid #1e293b',
                background: '#0b1120',
              }}
            >
              <div>
                <span
                  style={{
                    color: '#38bdf8',
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                  }}
                >
                  Power BI Integration
                </span>
                <h3 style={{ margin: '4px 0 2px', fontSize: '1.2rem', color: '#f8fafc', fontWeight: 600 }}>
                  Power BI DAX & Flow Integration
                </h3>
                <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8' }}>
                  Architecture details and active DAX query connecting Semantic Model to WorkLoad
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowDaxModal(false)}
                title="Close dialog"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#94a3b8',
                  fontSize: '1.4rem',
                  cursor: 'pointer',
                  padding: '4px 8px',
                  borderRadius: '6px',
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            <div className="frequency-dax-dialog-body">
              <div className="frequency-dialog-section">
                <h4>1. Architecture & Data Flow</h4>
                <div className="frequency-arch-diagram">
                  <div className="frequency-arch-step">
                    <span className="frequency-arch-icon">📊</span>
                    <div>
                      <strong>Power BI Semantic Model</strong>
                      <p>Centralized dataset (PTBI Plant, DimDate, DimProduct, DimZone, McGroup)</p>
                    </div>
                  </div>
                  <div className="frequency-arch-arrow">➔</div>
                  <div className="frequency-arch-step">
                    <span className="frequency-arch-icon">⚡</span>
                    <div>
                      <strong>Power Automate Cloud Flow</strong>
                      <p>Flow: <code>WL_Frequency</code> (Run query against dataset ➔ firstTableRows)</p>
                    </div>
                  </div>
                  <div className="frequency-arch-arrow">➔</div>
                  <div className="frequency-arch-step">
                    <span className="frequency-arch-icon">💻</span>
                    <div>
                      <strong>WorkLoad Code App</strong>
                      <p><code>WL_FrequencyService.Run()</code> ➔ Data Table & KPIs</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="frequency-dialog-section">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h4 style={{ margin: 0 }}>2. DAX Query Evaluation (Active with Current Settings)</h4>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const queryToCopy = activeParams?.daxQuery || DAX_QUERY_CODE;
                      void navigator.clipboard.writeText(queryToCopy);
                      setCopiedDax(true);
                      setTimeout(() => setCopiedDax(false), 2000);
                    }}
                  >
                    {copiedDax ? '✓ DAX Copied!' : '📋 Copy DAX'}
                  </Button>
                </div>
                <pre className="frequency-dax-code">{activeParams?.daxQuery || DAX_QUERY_CODE}</pre>
              </div>

              <div className="frequency-dialog-section">
                <h4>3. Column Mapping to WorkLoad</h4>
                <ul className="frequency-mapping-list">
                  <li>
                    <code>DimZone[ZoneName]</code> ➔ <strong>Zone Name & Area</strong> (e.g. RA, BA, RU, etc.).
                  </li>
                  <li>
                    <code>McGroup[Group]</code> ➔ <strong>McGroup</strong> (Machine group identifier).
                  </li>
                  <li>
                    <code>TonProduced</code> ➔ <strong>Ton Produced</strong> (Actual production volume in metric tons).
                  </li>
                  <li>
                    <code>Fr/T</code> ➔ <strong>Fracture/Ton</strong>. KPI calculated using <strong>SumProduct</strong>: <code>Σ (Fr/T × TonProduced) ÷ Total TonProduced</code>.
                  </li>
                  <li>
                    <code>Def/T</code> ➔ <strong>Defect/Ton</strong>. KPI calculated using <strong>SumProduct</strong>: <code>Σ (Def/T × TonProduced) ÷ Total TonProduced</code>.
                  </li>
                  <li>
                    <code>Dies/T</code> ➔ <strong>Dies/Ton</strong>. KPI calculated using <strong>SumProduct</strong>: <code>Σ (Dies/T × TonProduced) ÷ Total TonProduced</code>.
                  </li>
                  <li>
                    <code>Group_Product_Info</code> ➔ Unique key combining McGroup, Construction, LayLength, and Tensile.
                  </li>
                </ul>
              </div>
            </div>
            <div
              className="modal-footer"
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                padding: '12px 20px',
                borderTop: '1px solid #1e293b',
                background: '#0b1120',
              }}
            >
              <Button variant="secondary" onClick={() => setShowDaxModal(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
