import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  generateRejectShortDax,
  getActiveRejectShortFilterParams,
  loadRejectShortData,
  type ActiveRejectShortFilterParams,
  type RejectShortRecord,
} from '../../lib/rejectShortCatalog';
import { computeFrequencyDateRange } from '../../lib/frequencyCatalog';
import { loadDefaultValuesOrBuiltIn, type FrequencyDateRangeType } from '../../lib/defaultValuesStore';
import { usePagedRows } from '../../hooks/usePagedRows';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { DateInput } from '../ui/Field';
import { FloatingScrollbar } from '../ui/FloatingScrollbar';
import { SearchableSelect, type SearchableSelectOption } from '../ui/SearchableSelect';
import { TablePager } from '../ui/TablePager';

type SortKey =
  | 'plantName'
  | 'reasonCode'
  | 'reasonDescription'
  | 'construction'
  | 'layLength'
  | 'tensileStrength'
  | 'linerDensity'
  | 'totalRejectKG'
  | 'totalRejectSpool'
  | 'totalRejectMeter'
  | 'avgRejectMeterPerSpool';

function csvCell(value: unknown): string {
  const str = String(value ?? '');
  return /[,"\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const DEFAULT_DAX_PREVIEW = generateRejectShortDax({
  plant: 'PTBI',
  startParts: { year: 2026, month: 10, day: 20 },
  endParts: { year: 2026, month: 10, day: 27 },
});

/** Displays MES Reject Short records queried from Power BI via Power Automate (WL_RejectShort). */
export function RejectShortManager() {
  const [rows, setRows] = useState<RejectShortRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [activeParams, setActiveParams] = useState<ActiveRejectShortFilterParams | null>(
    getActiveRejectShortFilterParams(),
  );
  const [copiedDax, setCopiedDax] = useState(false);
  const [showDaxModal, setShowDaxModal] = useState(false);

  // Date Range Filter States
  const [dateRangeType, setDateRangeType] = useState<FrequencyDateRangeType>('last7Days');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Search & Filter States
  const [search, setSearch] = useState('');
  const [reasonCodeFilter, setReasonCodeFilter] = useState('');
  const [constructionFilter, setConstructionFilter] = useState('');
  const [tensileFilter, setTensileFilter] = useState('');

  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>('totalRejectMeter');
  const [sortAsc, setSortAsc] = useState(false);

  const tableWrapRef = useRef<HTMLDivElement>(null);

  const runQuery = useCallback(
    async (opts?: {
      plant?: string;
      startDate?: string;
      endDate?: string;
      dateRangeType?: FrequencyDateRangeType;
      forceRefresh?: boolean;
    }) => {
      setLoading(true);
      setError(null);
      try {
        const { records } = await loadRejectShortData({
          plant: opts?.plant,
          startDate: opts?.startDate,
          endDate: opts?.endDate,
          dateRangeType: opts?.dateRangeType,
          forceRefresh: opts?.forceRefresh ?? true,
        });
        setRows(records);
        setActiveParams(getActiveRejectShortFilterParams());
        setLastRefreshed(new Date());
      } catch (err) {
        console.error('Failed to run WL_RejectShort flow:', err);
        setError(err instanceof Error ? err.message : 'Failed to execute Power Automate flow WL_RejectShort.');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const defaults = await loadDefaultValuesOrBuiltIn();
        if (cancelled) return;
        const type = defaults.rejectShortDateRangeType;
        const computed = computeFrequencyDateRange(
          type,
          defaults.rejectShortStartDate,
          defaults.rejectShortEndDate,
        );
        setDateRangeType(type);
        setStartDate(computed.startDate);
        setEndDate(computed.endDate);
        await runQuery({
          plant: defaults.rejectShortPlant,
          startDate: computed.startDate,
          endDate: computed.endDate,
          dateRangeType: type,
          forceRefresh: true,
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load MES_RejectShort defaults.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runQuery]);

  const handlePresetChange = (type: FrequencyDateRangeType) => {
    setDateRangeType(type);
    if (type !== 'custom') {
      const range = computeFrequencyDateRange(type);
      setStartDate(range.startDate);
      setEndDate(range.endDate);
      void runQuery({
        startDate: range.startDate,
        endDate: range.endDate,
        dateRangeType: type,
        forceRefresh: true,
      });
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
    void runQuery({ startDate, endDate, dateRangeType: 'custom', forceRefresh: true });
  };

  const handleResetToDefaultRange = async () => {
    const defaults = await loadDefaultValuesOrBuiltIn();
    const range = computeFrequencyDateRange(
      defaults.rejectShortDateRangeType,
      defaults.rejectShortStartDate,
      defaults.rejectShortEndDate,
    );
    setDateRangeType(defaults.rejectShortDateRangeType);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    await runQuery({
      plant: defaults.rejectShortPlant,
      startDate: range.startDate,
      endDate: range.endDate,
      dateRangeType: defaults.rejectShortDateRangeType,
      forceRefresh: true,
    });
  };

  const handleRefresh = () => {
    if (startDate && endDate) {
      void runQuery({ startDate, endDate, dateRangeType, forceRefresh: true });
    } else {
      void runQuery({ forceRefresh: true });
    }
  };

  const reasonCodeOptions: SearchableSelectOption[] = useMemo(() => {
    const codes = new Map<string, string>();
    for (const r of rows) {
      if (r.reasonCode && !codes.has(r.reasonCode)) {
        codes.set(r.reasonCode, r.reasonDescription);
      }
    }
    return [...codes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, desc]) => ({
        value: code,
        label: desc ? `${code} — ${desc}` : `Code: ${code}`,
      }));
  }, [rows]);

  const constructionOptions: SearchableSelectOption[] = useMemo(() => {
    const items = [...new Set(rows.map((r) => r.construction).filter(Boolean))].sort();
    return items.map((c) => ({ value: c, label: `Construction: ${c}` }));
  }, [rows]);

  const tensileOptions: SearchableSelectOption[] = useMemo(() => {
    const items = [...new Set(rows.map((r) => r.tensileStrength).filter(Boolean))].sort();
    return items.map((t) => ({ value: t, label: `Tensile: ${t}` }));
  }, [rows]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (reasonCodeFilter && r.reasonCode !== reasonCodeFilter) return false;
      if (constructionFilter && r.construction !== constructionFilter) return false;
      if (tensileFilter && r.tensileStrength !== tensileFilter) return false;
      if (query) {
        const text = `${r.plantName} ${r.reasonCode} ${r.reasonDescription} ${r.construction} ${r.layLength} ${r.tensileStrength}`.toLowerCase();
        if (!text.includes(query)) return false;
      }
      return true;
    });
  }, [rows, reasonCodeFilter, constructionFilter, tensileFilter, search]);

  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
    list.sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];
      if (valA === valB) return 0;
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;

      const cmp =
        typeof valA === 'number' && typeof valB === 'number'
          ? valA - valB
          : String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
      return sortAsc ? cmp : -cmp;
    });
    return list;
  }, [filteredRows, sortKey, sortAsc]);

  const paged = usePagedRows(
    sortedRows,
    `${search}|${reasonCodeFilter}|${constructionFilter}|${tensileFilter}|${sortKey}|${sortAsc}`,
    50,
  );

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(key !== 'totalRejectKG' && key !== 'totalRejectSpool' && key !== 'totalRejectMeter' && key !== 'avgRejectMeterPerSpool');
    }
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return ' ↕';
    return sortAsc ? ' ↑' : ' ↓';
  };

  const summaryMetrics = useMemo(() => {
    let totalRejectKG = 0;
    let totalRejectSpool = 0;
    let totalRejectMeter = 0;
    for (const r of filteredRows) {
      totalRejectKG += r.totalRejectKG;
      totalRejectSpool += r.totalRejectSpool;
      totalRejectMeter += r.totalRejectMeter;
    }
    return {
      total: filteredRows.length,
      totalRejectKG,
      totalRejectSpool,
      totalRejectMeter,
      weightedAvgMeterPerSpool: totalRejectSpool > 0 ? totalRejectMeter / totalRejectSpool : 0,
    };
  }, [filteredRows]);

  const handleExportCsv = () => {
    const headers = [
      'PlantName',
      'ReasonCode',
      'ReasonCodeDescption',
      'Construction',
      'LayLength',
      'TensileStrength',
      'LinerDensity',
      'TotalRejectKG',
      'TotalRejectSpool',
      'TotalRejectMeter',
      'AVGrejectmeterperspool',
    ];
    const csvLines = sortedRows.map((r) => [
      csvCell(r.plantName),
      csvCell(r.reasonCode),
      csvCell(r.reasonDescription),
      csvCell(r.construction),
      csvCell(r.layLength),
      csvCell(r.tensileStrength),
      csvCell(r.linerDensity ?? ''),
      csvCell(r.totalRejectKG),
      csvCell(r.totalRejectSpool),
      csvCell(r.totalRejectMeter),
      csvCell(r.avgRejectMeterPerSpool),
    ]);
    const csvContent = [headers.join(','), ...csvLines.map((l) => l.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `MES_RejectShort_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const clearFilters = () => {
    setSearch('');
    setReasonCodeFilter('');
    setConstructionFilter('');
    setTensileFilter('');
  };

  const hasActiveFilters = Boolean(search || reasonCodeFilter || constructionFilter || tensileFilter);

  return (
    <div className="frequency-manager">
      <Card
        title="MES_RejectShort"
        subtitle="Short-length non-conformity reject data from Power BI Semantic Model via Power Automate Flow (WL_RejectShort)"
        actions={
          <div className="data-manager-actions">
            <Button
              variant="ghost"
              onClick={handleRefresh}
              disabled={loading}
              title="Run WL_RejectShort flow again to fetch latest data"
            >
              {loading ? 'Refreshing…' : '🔄 Refresh Data'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setShowDaxModal(true)}
              title="View DAX Query and Power Automate flow architecture"
            >
              ℹ️ DAX &amp; Flow Info
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
            <span className="frequency-filter-banner-item">📅 Period:</span>

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
              title="Apply date range and query MES Reject Short data"
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

          <span className="frequency-filter-banner-hint">(Default configured in Setting → Default Values)</span>
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
            <span className="frequency-kpi-label">Total Reject KG</span>
            <span className="frequency-kpi-value text-accent-cyan">
              {summaryMetrics.totalRejectKG.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
            </span>
            <span className="frequency-kpi-sub">FactMachineNonConformity[RejectedKG]</span>
          </div>
          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">Total Reject Spool</span>
            <span className="frequency-kpi-value text-accent-amber">
              {summaryMetrics.totalRejectSpool.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
            <span className="frequency-kpi-sub">Doffed Reject Spool Count</span>
          </div>
          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">Total Reject Meter</span>
            <span className="frequency-kpi-value text-accent-green">
              {summaryMetrics.totalRejectMeter.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            </span>
            <span className="frequency-kpi-sub">
              ≈ {(summaryMetrics.totalRejectMeter / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km
            </span>
          </div>
          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">Avg Reject m / Spool</span>
            <span className="frequency-kpi-value text-accent-purple">
              {summaryMetrics.weightedAvgMeterPerSpool.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
            </span>
            <span className="frequency-kpi-sub">Total Reject Meter ÷ Total Spools</span>
          </div>
        </div>

        {error && (
          <div className="frequency-alert-error">
            <span className="frequency-alert-icon">⚠️</span>
            <div className="frequency-alert-body">
              <strong>Error Loading Data:</strong> {error}
              <div className="frequency-alert-actions">
                <Button variant="ghost" onClick={handleRefresh} disabled={loading}>
                  Try Again
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Filters and Search */}
        <div className="frequency-filters-bar">
          <input
            className="input frequency-search-input"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Construction, Reason Code, Description, Tensile…"
            aria-label="Search reject short records"
          />
          <SearchableSelect
            value={reasonCodeFilter}
            onChange={setReasonCodeFilter}
            options={reasonCodeOptions}
            placeholder="All Reason Codes"
            searchPlaceholder="Search Reason Code…"
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
          <SearchableSelect
            value={tensileFilter}
            onChange={setTensileFilter}
            options={tensileOptions}
            placeholder="All Tensiles"
            searchPlaceholder="Search Tensile…"
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
            <p>Running Power BI query via Power Automate flow (WL_RejectShort)…</p>
            <span className="frequency-loading-sub">Fetching DAX query results from Semantic Model</span>
          </div>
        ) : sortedRows.length === 0 ? (
          <div className="frequency-empty-state">
            <span className="frequency-empty-icon">📂</span>
            <h4>No records found</h4>
            <p>
              {hasActiveFilters
                ? 'No rows match the current filter criteria.'
                : 'Click "Refresh Data" to load records from Power Automate Flow WL_RejectShort.'}
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
              label="reject short data rows"
            />
            <div className="data-table-wrap" ref={tableWrapRef}>
              <table className="table frequency-table">
                <thead>
                  <tr>
                    <th className="table-sortable-header" onClick={() => toggleSort('plantName')}>
                      Plant {sortIndicator('plantName')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('reasonCode')}>
                      Reason Code {sortIndicator('reasonCode')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('reasonDescription')}>
                      Reason Description {sortIndicator('reasonDescription')}
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
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('linerDensity')}>
                      Liner Density {sortIndicator('linerDensity')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('totalRejectKG')}>
                      Total Reject (KG) {sortIndicator('totalRejectKG')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('totalRejectSpool')}>
                      Reject Spools {sortIndicator('totalRejectSpool')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('totalRejectMeter')}>
                      Total Reject (m) {sortIndicator('totalRejectMeter')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('avgRejectMeterPerSpool')}>
                      Avg m/Spool {sortIndicator('avgRejectMeterPerSpool')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paged.pageRows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <span className="frequency-area-badge">{row.plantName || '-'}</span>
                      </td>
                      <td>
                        <code className="frequency-code-tag">{row.reasonCode || '-'}</code>
                      </td>
                      <td>{row.reasonDescription || '-'}</td>
                      <td>
                        <strong>{row.construction || '-'}</strong>
                      </td>
                      <td>{row.layLength !== '' ? row.layLength : '-'}</td>
                      <td>{row.tensileStrength || '-'}</td>
                      <td className="numeric-col">
                        {row.linerDensity !== null ? row.linerDensity.toFixed(4) : '-'}
                      </td>
                      <td className="numeric-col">
                        <span className="frequency-num-fr">
                          {row.totalRejectKG.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </td>
                      <td className="numeric-col">
                        <span className="frequency-num-def">
                          {row.totalRejectSpool.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                      </td>
                      <td className="numeric-col">
                        <span className="frequency-num-ton">
                          {row.totalRejectMeter.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
                        </span>
                      </td>
                      <td className="numeric-col">
                        <span className="frequency-num-dies">
                          {row.avgRejectMeterPerSpool.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
                        </span>
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
              label="reject short data rows"
            />
            <FloatingScrollbar targetRef={tableWrapRef} />
          </>
        )}
      </Card>

      {/* DAX Query & Flow Architecture Modal */}
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
                  WL_RejectShort — DAX &amp; Flow Info
                </h3>
                <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8' }}>
                  Connected via Power Apps CLI (<code>pa app add flow</code>) to Power BI Semantic Model
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
                <h4>1. Architecture &amp; Data Flow</h4>
                <div className="frequency-arch-diagram">
                  <div className="frequency-arch-step">
                    <span className="frequency-arch-icon">📊</span>
                    <div>
                      <strong>Power BI Semantic Model</strong>
                      <p>FactMachineNonConformity, DimPlantRegion, DimProduct, DimReasonCode, DimDate</p>
                    </div>
                  </div>
                  <div className="frequency-arch-arrow">➔</div>
                  <div className="frequency-arch-step">
                    <span className="frequency-arch-icon">⚡</span>
                    <div>
                      <strong>Power Automate Cloud Flow</strong>
                      <p>Flow: <code>WL_RejectShort</code> (Run a query against a dataset ➔ firstTableRows)</p>
                    </div>
                  </div>
                  <div className="frequency-arch-arrow">➔</div>
                  <div className="frequency-arch-step">
                    <span className="frequency-arch-icon">💻</span>
                    <div>
                      <strong>WorkLoad Code App</strong>
                      <p><code>WL_RejectShortService.Run()</code> ➔ Data Table &amp; KPIs</p>
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
                      const queryToCopy = activeParams?.daxQuery || DEFAULT_DAX_PREVIEW;
                      void navigator.clipboard.writeText(queryToCopy);
                      setCopiedDax(true);
                      setTimeout(() => setCopiedDax(false), 2000);
                    }}
                  >
                    {copiedDax ? '✓ DAX Copied!' : '📋 Copy DAX'}
                  </Button>
                </div>
                <pre className="frequency-dax-code">{activeParams?.daxQuery || DEFAULT_DAX_PREVIEW}</pre>
              </div>

              <div className="frequency-dialog-section">
                <h4>3. Column Mapping</h4>
                <ul className="frequency-mapping-list">
                  <li>
                    <code>DimPlantRegion[PlantName]</code>, <code>DimProduct[Construction / LayLength / TensileStrength / LinerDensity]</code> ➔ Product Dimensions
                  </li>
                  <li>
                    <code>DimReasonCode[Code]</code> &amp; <code>DimReasonCode[ReasonCodeDescption]</code> ➔ Filtered on <code>&quot;1233&quot;</code> (Short Reject)
                  </li>
                  <li>
                    <code>TotalRejectKG</code> = <code>SUM(FactMachineNonConformity[RejectedKG])</code>
                  </li>
                  <li>
                    <code>TotalRejectSpool</code> = <code>SUM(FactMachineNonConformity[DoffedRejectSpoolCount])</code>
                  </li>
                  <li>
                    <code>TotalRejectMeter</code> = <code>[TotalRejectKG] / DimProduct[LinerDensity] * 1000</code>
                  </li>
                  <li>
                    <code>AVGrejectmeterperspool</code> = <code>([TotalRejectKG] / DimProduct[LinerDensity] * 1000) / [TotalRejectSpool]</code>
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

