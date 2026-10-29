import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  loadActualOutputData,
  generateActualOutputDax,
  type ActualOutputRecord,
  type ActualOutputFilterParams,
} from '../../lib/actualOutputCatalog';
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
  | 'machineName'
  | 'machineType'
  | 'group'
  | 'construction'
  | 'layLength'
  | 'tensileStrength'
  | 'spoolType'
  | 'standardSpeed'
  | 'linerDensity'
  | 'constructionDetail'
  | 'totalProducedKG'
  | 'tonProduced'
  | 'aQualityKG'
  | 'doffedSpoolCount'
  | 'effectiveHours'
  | 'effectiveHoursInHours'
  | 'scheduledHrs'
  | 'oee'
  | 'totalFracture'
  | 'fracturePerTon'
  | 'totalDefect'
  | 'defectPerTon'
  | 'diesCount'
  | 'diesPerTon';

function getTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const FLOW_DAX_TEMPLATE = `EVALUATE
ADDCOLUMNS(
SUMMARIZECOLUMNS(
    -- 1. DIMENSI GROUP BY
    DimPlantRegion[PlantName],
    DimDate[Date],
    DimShift[DaySequenceNo],
    DimZone[ZoneName],
    McGroup[Group],
    DimMachine[MachineType],
    DimWIPOrder[SAPMachineTypeGroup],
    DimMachine[Name],
    DimProduct[ProductGroup],
    DimProduct[BK_ProductNo],
    DimProduct[SPGCode],
    DimProduct[Const+TG],
    DimProduct[Construction],
    DimProduct[LayLength],
    DimProduct[TensileStrength],
    DimProduct[SpoolType],
    DimProduct[StandardLength],
    DimWIPOrder[StandardSpeed],
    DimProduct[LinerDensity],

    -- 2. FILTER PLANT, TANGGAL & SHIFT (Sama seperti WL_Frequency):
    TREATAS({"@{triggerBody()['text']}"}, DimPlantRegion[PlantName]),
    FILTER(
        ALL(DimDate[Date]), 
        DimDate[Date] = DATEVALUE("@{triggerBody()['date']}")
    ),
    TREATAS({@{triggerBody()['number']}}, DimShift[DaySequenceNo]),

    -- 3. NILAI AGREGASI
    "DoffedSpoolCount", SUM(FactMachineProductivity[DoffedSpoolCount]),
    "DoffedRejectSpoolCount", SUM(FactMachineProductivity[DoffedRejectSpoolCount]),
    "AQualityKG", SUM(FactMachineProductivity[AQualityKG]),
    "ShortLengthAQualityKG", SUM(FactMachineEmployeeProductivity[ShortLengthAQualityKG]),
    "TotalRejectedKG", SUM(FactMachineProductivity[TotalRejectedKG]),
    "TotalProducedKG", SUM(FactMachineProductivity[TotalProducedKG]),
    "EffectiveHours", SUM(FactMachineEmployeeProductivity[EffectiveHours]),
    "TotalFracture", SUM(FactMachineProductivity[TotalFracture]),
    "DiesCount", SUM(FactMachineProductivity[DiesCount]),
    "HeadDiesCount", SUM(FactMachineProductivity[HeadDiesCount]),
    
    -- 4. MEASURES RESMI
    "TotalDefect", [TotalDefect],
    "EffectiveHrs", [Effective Time (Hrs)],
    "ScheduledHrs", [Scheduled Time (Hrs)],
    "TonProduced", [TonProduced]
),

    "ConstructionDetail", 
        IF(
			(OR(McGroup[Group] = "BFM",McGroup[Group] = "KT")),
			DimWIPOrder[SAPMachineTypeGroup],
			IF(
				McGroup[Group] = "SP",
				"HENX",
				McGroup[Group]
			)
		) & "-" & 
        DimProduct[Construction] & "-" & 
        If(ISBLANK(DimProduct[LayLength]),0,DimProduct[LayLength]) & "-" & 
        DimProduct[TensileStrength] & "-" &
        IF(
            LEFT(DimProduct[SpoolType], 2) = "BS",
            LEFT(DimProduct[SpoolType], 4),
            DimProduct[SpoolType]
        ) & "-" &
        DimProduct[StandardLength] & "-" &
        DimWIPOrder[StandardSpeed],
        
    "Area", Left(DimZone[ZoneName], 2)
)`;

export function ActualOutputManager() {
  const [rows, setRows] = useState<ActualOutputRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [copiedDax, setCopiedDax] = useState(false);
  const [showDaxModal, setShowDaxModal] = useState(false);
  const [daxViewMode, setDaxViewMode] = useState<'flow' | 'evaluated'>('flow');

  // Trigger Parameters
  const [plant, setPlant] = useState('PTBI');
  const [date, setDate] = useState(getTodayIso);
  const [shift, setShift] = useState(1);

  // Filters & Search
  const [search, setSearch] = useState('');
  const [areaFilter, setAreaFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [machineTypeFilter, setMachineTypeFilter] = useState('');

  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>('machineName');
  const [sortAsc, setSortAsc] = useState(true);

  const tableWrapRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(
    async (overrideParams?: Partial<ActualOutputFilterParams>, forceRefresh = false) => {
      setLoading(true);
      setError(null);
      const queryParams: ActualOutputFilterParams = {
        plant: overrideParams?.plant ?? plant,
        date: overrideParams?.date ?? date,
        shift: overrideParams?.shift ?? shift,
      };

      try {
        const { records } = await loadActualOutputData(queryParams, forceRefresh);
        setRows(records);
        setLastRefreshed(new Date());
      } catch (err) {
        console.error('Failed to run WL_ActualOutput flow:', err);
        const msg = err instanceof Error ? err.message : 'Failed to execute Power Automate flow WL_ActualOutput.';
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [plant, date, shift],
  );

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Options for secondary filters
  const areaOptions: SearchableSelectOption[] = useMemo(() => {
    const areas = [...new Set(rows.map((r) => r.area).filter(Boolean))].sort();
    return areas.map((a) => ({ value: a, label: `Area: ${a}` }));
  }, [rows]);

  const groupOptions: SearchableSelectOption[] = useMemo(() => {
    const groups = [...new Set(rows.map((r) => r.group).filter(Boolean))].sort();
    return groups.map((g) => ({ value: g, label: `Group: ${g}` }));
  }, [rows]);

  const machineTypeOptions: SearchableSelectOption[] = useMemo(() => {
    const types = [...new Set(rows.map((r) => r.machineType).filter(Boolean))].sort();
    return types.map((t) => ({ value: t, label: `Type: ${t}` }));
  }, [rows]);

  // Filtered & Sorted
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (areaFilter && r.area !== areaFilter) return false;
      if (groupFilter && r.group !== groupFilter) return false;
      if (machineTypeFilter && r.machineType !== machineTypeFilter) return false;
      if (query) {
        const text = `${r.machineName} ${r.area} ${r.zoneName} ${r.group} ${r.machineType} ${r.construction} ${r.constructionDetail} ${r.spgCode} ${r.bkProductNo}`.toLowerCase();
        if (!text.includes(query)) return false;
      }
      return true;
    });
  }, [rows, areaFilter, groupFilter, machineTypeFilter, search]);

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
    `${search}|${areaFilter}|${groupFilter}|${machineTypeFilter}|${sortKey}|${sortAsc}`,
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

  // Aggregated KPI Metrics
  const summaryMetrics = useMemo(() => {
    if (filteredRows.length === 0) {
      return {
        total: 0,
        totalProducedKG: 0,
        tonProduced: 0,
        aQualityKG: 0,
        totalRejectedKG: 0,
        rejectRatePct: 0,
        doffedSpools: 0,
        doffedRejectSpools: 0,
        effectiveHours: 0,
        scheduledHours: 0,
        utilizationPct: 0,
        totalFracture: 0,
        totalDefect: 0,
        fracturePerTon: 0,
        defectPerTon: 0,
        diesCount: 0,
        headDiesCount: 0,
        diesPerTon: 0,
        oeePct: 0,
        effectiveHoursMinutes: 0,
        effectiveHoursInHours: 0,
      };
    }

    let totalProducedKG = 0;
    let tonProduced = 0;
    let aQualityKG = 0;
    let totalRejectedKG = 0;
    let doffedSpools = 0;
    let doffedRejectSpools = 0;
    let effectiveHours = 0;
    let scheduledHours = 0;
    let totalFracture = 0;
    let totalDefect = 0;
    let diesCount = 0;
    let headDiesCount = 0;

    for (const r of filteredRows) {
      totalProducedKG += r.totalProducedKG ?? 0;
      tonProduced += r.tonProduced ?? (r.totalProducedKG ? r.totalProducedKG / 1000 : 0);
      aQualityKG += r.aQualityKG ?? 0;
      totalRejectedKG += r.totalRejectedKG ?? 0;
      doffedSpools += r.doffedSpoolCount ?? 0;
      doffedRejectSpools += r.doffedRejectSpoolCount ?? 0;
      effectiveHours += r.effectiveHours ?? r.effectiveHrs ?? 0;
      scheduledHours += r.scheduledHrs ?? 0;
      totalFracture += r.totalFracture ?? 0;
      totalDefect += r.totalDefect ?? 0;
      diesCount += r.diesCount ?? 0;
      headDiesCount += r.headDiesCount ?? 0;
    }

    // Eff hrs saat ini nilainya menit, jadi dibagi 60 agar menjadi jam:
    const effectiveHoursMinutes = effectiveHours;
    const effectiveHoursInHours = effectiveHoursMinutes / 60;

    const rejectRatePct = totalProducedKG > 0 ? (totalRejectedKG / totalProducedKG) * 100 : 0;
    const oeePct = scheduledHours > 0 ? (effectiveHoursInHours / scheduledHours) * 100 : 0;
    const fracturePerTon = tonProduced > 0 ? totalFracture / tonProduced : 0;
    const defectPerTon = tonProduced > 0 ? totalDefect / tonProduced : 0;
    // Rumus Dies/T = (DiesCount + HeadDiesCount) / TonProduced
    const totalDiesCombined = diesCount + headDiesCount;
    const diesPerTon = tonProduced > 0 ? totalDiesCombined / tonProduced : 0;

    return {
      total: filteredRows.length,
      totalProducedKG,
      tonProduced,
      aQualityKG,
      totalRejectedKG,
      rejectRatePct,
      doffedSpools,
      doffedRejectSpools,
      effectiveHours: effectiveHoursMinutes,
      effectiveHoursMinutes,
      effectiveHoursInHours,
      scheduledHours,
      oeePct,
      totalFracture,
      fracturePerTon,
      totalDefect,
      defectPerTon,
      diesCount,
      headDiesCount,
      diesPerTon,
    };
  }, [filteredRows]);

  const handleExportCsv = () => {
    const headers = [
      'Plant',
      'Date',
      'Shift',
      'Area',
      'ZoneName',
      'MachineName',
      'MachineType',
      'McGroup',
      'Construction',
      'LayLength',
      'TensileStrength',
      'SpoolType',
      'StandardLength',
      'StandardSpeed',
      'ConstructionDetail',
      'TotalProducedKG',
      'TonProduced',
      'AQualityKG',
      'TotalRejectedKG',
      'DoffedSpoolCount',
      'DoffedRejectSpoolCount',
      'EffectiveMinutes',
      'EffectiveHours',
      'ScheduledHours',
      'OEE_Pct',
      'TotalFracture',
      'Fr_Per_Ton',
      'TotalDefect',
      'Def_Per_Ton',
      'DiesCount',
      'HeadDiesCount',
      'Dies_Per_Ton',
    ];

    const csvLines = sortedRows.map((r) => [
      `"${r.plantName}"`,
      `"${r.date}"`,
      r.shift,
      `"${r.area}"`,
      `"${r.zoneName.replace(/"/g, '""')}"`,
      `"${r.machineName.replace(/"/g, '""')}"`,
      `"${r.machineType.replace(/"/g, '""')}"`,
      `"${r.group.replace(/"/g, '""')}"`,
      `"${r.construction.replace(/"/g, '""')}"`,
      r.layLength,
      `"${r.tensileStrength.replace(/"/g, '""')}"`,
      `"${r.spoolType.replace(/"/g, '""')}"`,
      r.standardLength,
      r.standardSpeed,
      `"${r.constructionDetail.replace(/"/g, '""')}"`,
      r.totalProducedKG ?? '',
      r.tonProduced ?? '',
      r.aQualityKG ?? '',
      r.totalRejectedKG ?? '',
      r.doffedSpoolCount ?? '',
      r.doffedRejectSpoolCount ?? '',
      r.effectiveHours ?? '',
      r.effectiveHoursInHours ?? '',
      r.scheduledHrs ?? '',
      r.oee !== null ? `${r.oee}%` : '',
      r.totalFracture ?? '',
      r.fracturePerTon ?? '',
      r.totalDefect ?? '',
      r.defectPerTon ?? '',
      r.diesCount ?? '',
      r.headDiesCount ?? '',
      r.diesPerTon ?? '',
    ]);

    const csvContent = [headers.join(','), ...csvLines.map((l) => l.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `MES_ActualOutput_${plant}_${date}_Shift${shift}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const clearFilters = () => {
    setSearch('');
    setAreaFilter('');
    setGroupFilter('');
    setMachineTypeFilter('');
  };

  const hasActiveFilters = Boolean(search || areaFilter || groupFilter || machineTypeFilter);

  const activeDaxQuery = useMemo(() => {
    return generateActualOutputDax({ plant, date, shift });
  }, [plant, date, shift]);

  return (
    <div className="actual-output-manager">
      <Card
        title="MES_ActualOutput"
        subtitle="Power BI Semantic Model data (Actual Output & Productivity) via Power Automate Flow (MES_ActualOutput)"
        actions={
          <div className="data-manager-actions">
            <Button
              variant="ghost"
              onClick={() => void fetchData(undefined, true)}
              disabled={loading}
              title="Run flow again to fetch latest data"
            >
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
        {/* Trigger Parameters Bar */}
        <div className="frequency-active-filter-banner">
          <span className="frequency-filter-banner-item">
            🏭 Plant:
            <input
              type="text"
              value={plant}
              onChange={(e) => setPlant(e.target.value)}
              disabled={loading}
              className="frequency-date-input"
              style={{ width: '80px', marginLeft: '6px' }}
              title="Plant Name"
            />
          </span>

          <span className="frequency-filter-banner-divider">|</span>

          <div className="frequency-date-controls">
            <span className="frequency-filter-banner-item">📅 Date:</span>
            <DateInput
              value={date}
              onChange={(v) => setDate(v)}
              disabled={loading}
              className="frequency-date-input"
            />

            <span className="frequency-filter-banner-item" style={{ marginLeft: '6px' }}>
              ⏱️ Shift:
            </span>
            <select
              className="frequency-date-preset-select"
              value={shift}
              onChange={(e) => setShift(Number(e.target.value))}
              disabled={loading}
              title="Select Shift"
            >
              <option value={1}>Shift 1</option>
              <option value={2}>Shift 2</option>
              <option value={3}>Shift 3</option>
            </select>

            <button
              type="button"
              className="frequency-date-apply-btn"
              onClick={() => void fetchData(undefined, true)}
              disabled={loading || !date || !plant}
              title="Execute query with current Plant, Date & Shift"
            >
              {loading ? 'Querying…' : 'Query'}
            </button>
          </div>

          <span className="frequency-filter-banner-hint">
            Querying actual productivity data from Power BI
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
            <span className="frequency-kpi-label">Volume Produced</span>
            <span className="frequency-kpi-value text-accent-green">
              {summaryMetrics.tonProduced > 0
                ? summaryMetrics.tonProduced.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })
                : '0.0'}{' '}
              <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Ton</span>
            </span>
            <span className="frequency-kpi-sub">
              {Math.round(summaryMetrics.totalProducedKG).toLocaleString()} KG produced
            </span>
          </div>

          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">A-Quality vs Reject</span>
            <span className="frequency-kpi-value text-accent-cyan">
              {Math.round(summaryMetrics.aQualityKG).toLocaleString()}{' '}
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>KG</span>
            </span>
            <span className="frequency-kpi-sub" title="Rejection rate percentage">
              Reject: {Math.round(summaryMetrics.totalRejectedKG).toLocaleString()} KG ({summaryMetrics.rejectRatePct.toFixed(2)}%)
            </span>
          </div>

          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">Doffed Spools</span>
            <span className="frequency-kpi-value text-accent-purple">
              {summaryMetrics.doffedSpools.toLocaleString()}
            </span>
            <span className="frequency-kpi-sub">
              Reject spools: {summaryMetrics.doffedRejectSpools.toLocaleString()}
            </span>
          </div>

          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">OEE</span>
            <span className="frequency-kpi-value text-accent-amber">
              {summaryMetrics.oeePct > 0 ? `${summaryMetrics.oeePct.toFixed(1)}%` : '—'}
            </span>
            <span className="frequency-kpi-sub" title="Effective Hours (minutes / 60) / Scheduled Hours">
              {summaryMetrics.effectiveHoursInHours.toFixed(1)}h / {summaryMetrics.scheduledHours.toFixed(1)}h
            </span>
          </div>

          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">FR / T</span>
            <span className="frequency-kpi-value" style={{ color: '#fb7185' }}>
              {summaryMetrics.tonProduced > 0 ? summaryMetrics.fracturePerTon.toFixed(2) : '—'}
            </span>
            <span className="frequency-kpi-sub" title="Total Fractures / Ton Produced">
              {summaryMetrics.totalFracture.toLocaleString()} fractures ({summaryMetrics.tonProduced > 0 ? `${summaryMetrics.fracturePerTon.toFixed(2)}/T` : '—'})
            </span>
          </div>

          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">DEF / T</span>
            <span className="frequency-kpi-value" style={{ color: '#fb923c' }}>
              {summaryMetrics.tonProduced > 0 ? summaryMetrics.defectPerTon.toFixed(2) : '—'}
            </span>
            <span className="frequency-kpi-sub" title="Total Defects / Ton Produced">
              {summaryMetrics.totalDefect.toLocaleString()} defects ({summaryMetrics.tonProduced > 0 ? `${summaryMetrics.defectPerTon.toFixed(2)}/T` : '—'})
            </span>
          </div>

          <div className="frequency-kpi-card">
            <span className="frequency-kpi-label">DIES / T</span>
            <span className="frequency-kpi-value" style={{ color: '#60a5fa' }}>
              {summaryMetrics.tonProduced > 0 ? summaryMetrics.diesPerTon.toFixed(2) : '—'}
            </span>
            <span className="frequency-kpi-sub" title="(DiesCount + HeadDiesCount) / Ton Produced">
              {(summaryMetrics.diesCount + summaryMetrics.headDiesCount).toLocaleString()} dies ({summaryMetrics.diesCount.toLocaleString()} + {summaryMetrics.headDiesCount.toLocaleString()} head)
            </span>
          </div>
        </div>

        {error && (
          <div className="frequency-alert-error">
            <span className="frequency-alert-icon">⚠️</span>
            <div className="frequency-alert-body">
              <strong>Error Loading Data:</strong> {error}
              <div className="frequency-alert-actions">
                <Button variant="ghost" onClick={() => void fetchData(undefined, true)} disabled={loading}>
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
            placeholder="Search Machine, ConstructionDetail, Group, SPGCode…"
            aria-label="Search actual output records"
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
            value={machineTypeFilter}
            onChange={setMachineTypeFilter}
            options={machineTypeOptions}
            placeholder="All Machine Types"
            searchPlaceholder="Search Machine Type…"
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
            <p>Running Power BI query via Power Automate flow WL_ActualOutput…</p>
            <span className="frequency-loading-sub">Fetching shift productivity and machine outputs</span>
          </div>
        ) : sortedRows.length === 0 ? (
          <div className="frequency-empty-state">
            <span className="frequency-empty-icon">📂</span>
            <h4>No records found</h4>
            <p>
              {hasActiveFilters
                ? 'No rows match the current filter criteria.'
                : 'Click "Query" to load records for the selected Plant, Date, and Shift.'}
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
              label="actual output rows"
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
                    <th className="table-sortable-header" onClick={() => toggleSort('machineName')}>
                      Machine {sortIndicator('machineName')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('group')}>
                      McGroup {sortIndicator('group')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('machineType')}>
                      Machine Type {sortIndicator('machineType')}
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
                    <th className="table-sortable-header" onClick={() => toggleSort('spoolType')}>
                      Spool {sortIndicator('spoolType')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('standardSpeed')}>
                      Speed {sortIndicator('standardSpeed')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('linerDensity')}>
                      Density {sortIndicator('linerDensity')}
                    </th>
                    <th className="table-sortable-header" onClick={() => toggleSort('constructionDetail')}>
                      ConstructionDetail {sortIndicator('constructionDetail')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('totalProducedKG')}>
                      Produced (KG) {sortIndicator('totalProducedKG')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('tonProduced')}>
                      Ton {sortIndicator('tonProduced')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('aQualityKG')}>
                      A-Quality (KG) {sortIndicator('aQualityKG')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('doffedSpoolCount')}>
                      Doff Spools {sortIndicator('doffedSpoolCount')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('effectiveHoursInHours')}>
                      Eff Hrs (H) {sortIndicator('effectiveHoursInHours')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('scheduledHrs')}>
                      Sched Hrs {sortIndicator('scheduledHrs')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('oee')}>
                      OEE {sortIndicator('oee')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('totalFracture')}>
                      Fractures {sortIndicator('totalFracture')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('fracturePerTon')}>
                      Fr / T {sortIndicator('fracturePerTon')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('totalDefect')}>
                      Defects {sortIndicator('totalDefect')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('defectPerTon')}>
                      Def / T {sortIndicator('defectPerTon')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('diesCount')}>
                      Dies {sortIndicator('diesCount')}
                    </th>
                    <th className="table-sortable-header numeric-col" onClick={() => toggleSort('diesPerTon')}>
                      Dies / T {sortIndicator('diesPerTon')}
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
                        <strong style={{ color: '#38bdf8' }}>{row.machineName || '-'}</strong>
                      </td>
                      <td>{row.group || '-'}</td>
                      <td>
                        <span className="frequency-type-badge">{row.machineType || '-'}</span>
                      </td>
                      <td>{row.construction || '-'}</td>
                      <td>{row.layLength !== '' ? row.layLength : '-'}</td>
                      <td>{row.tensileStrength || '-'}</td>
                      <td>{row.spoolType || '-'}</td>
                      <td>{row.standardSpeed || '-'}</td>
                      <td className="numeric-col">{row.linerDensity !== null ? row.linerDensity : '-'}</td>
                      <td>
                        <code className="frequency-code-tag" title={row.constructionDetail}>
                          {row.constructionDetail || '-'}
                        </code>
                      </td>
                      <td className="numeric-col">
                        <span className="frequency-num-ton">
                          {row.totalProducedKG !== null ? row.totalProducedKG.toLocaleString() : '-'}
                        </span>
                      </td>
                      <td className="numeric-col">
                        {row.tonProduced !== null
                          ? row.tonProduced.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })
                          : '-'}
                      </td>
                      <td className="numeric-col">
                        {row.aQualityKG !== null ? row.aQualityKG.toLocaleString() : '-'}
                      </td>
                      <td className="numeric-col">
                        {row.doffedSpoolCount !== null ? row.doffedSpoolCount.toLocaleString() : '-'}
                      </td>
                      <td className="numeric-col" title={`Eff Time: ${row.effectiveHours ?? 0} minutes / 60`}>
                        {row.effectiveHoursInHours !== null ? `${row.effectiveHoursInHours.toFixed(1)}h` : '-'}
                      </td>
                      <td className="numeric-col">
                        {row.scheduledHrs !== null ? `${row.scheduledHrs.toFixed(1)}h` : '-'}
                      </td>
                      <td className="numeric-col">
                        <strong
                          style={{
                            color:
                              row.oee !== null
                                ? row.oee >= 85
                                  ? '#34d399'
                                  : row.oee >= 70
                                  ? '#fbbf24'
                                  : '#f87171'
                                : '#94a3b8',
                          }}
                        >
                          {row.oee !== null ? `${row.oee.toFixed(1)}%` : '-'}
                        </strong>
                      </td>
                      <td className="numeric-col">
                        <span className="frequency-num-fr">
                          {row.totalFracture !== null ? row.totalFracture.toLocaleString() : '-'}
                        </span>
                      </td>
                      <td className="numeric-col" style={{ color: '#fb7185', fontWeight: 600 }}>
                        {row.fracturePerTon !== null ? row.fracturePerTon.toFixed(2) : '-'}
                      </td>
                      <td className="numeric-col">
                        <span className="frequency-num-def">
                          {row.totalDefect !== null ? row.totalDefect.toLocaleString() : '-'}
                        </span>
                      </td>
                      <td className="numeric-col" style={{ color: '#fb923c', fontWeight: 600 }}>
                        {row.defectPerTon !== null ? row.defectPerTon.toFixed(2) : '-'}
                      </td>
                      <td className="numeric-col">
                        <span className="frequency-num-dies">
                          {row.diesCount !== null ? row.diesCount.toLocaleString() : '-'}
                        </span>
                      </td>
                      <td className="numeric-col" style={{ color: '#60a5fa', fontWeight: 600 }}>
                        {row.diesPerTon !== null ? row.diesPerTon.toFixed(2) : '-'}
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
              label="actual output rows"
            />
            <FloatingScrollbar targetRef={tableWrapRef} />
          </>
        )}
      </Card>

      {/* DAX Query & Architecture Modal Popup */}
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
                  MES_ActualOutput DAX & Flow Integration
                </h3>
                <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8' }}>
                  Architecture and DAX query details connecting Semantic Model to MES_ActualOutput
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
                      <p>FactMachineProductivity & FactMachineEmployeeProductivity</p>
                    </div>
                  </div>
                  <div className="frequency-arch-arrow">➔</div>
                  <div className="frequency-arch-step">
                    <span className="frequency-arch-icon">⚡</span>
                    <div>
                      <strong>Power Automate Cloud Flow</strong>
                      <p>Flow: <code>WL_ActualOutput</code> (Inputs: PlantName, Date, Shift)</p>
                    </div>
                  </div>
                  <div className="frequency-arch-arrow">➔</div>
                  <div className="frequency-arch-step">
                    <span className="frequency-arch-icon">💻</span>
                    <div>
                      <strong>WorkLoad Code App</strong>
                      <p><code>WL_ActualOutputService.Run()</code> ➔ Data Table & KPIs</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="frequency-dialog-section">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button
                      variant={daxViewMode === 'flow' ? 'primary' : 'secondary'}
                      style={{ padding: '6px 12px', fontSize: '0.82rem' }}
                      onClick={() => setDaxViewMode('flow')}
                    >
                      ⚡ Flow DAX (Power Automate)
                    </Button>
                    <Button
                      variant={daxViewMode === 'evaluated' ? 'primary' : 'secondary'}
                      style={{ padding: '6px 12px', fontSize: '0.82rem' }}
                      onClick={() => setDaxViewMode('evaluated')}
                    >
                      📊 Evaluated DAX ({plant}, {date}, Shift {shift})
                    </Button>
                  </div>
                  <Button
                    variant="secondary"
                    style={{ padding: '6px 12px', fontSize: '0.82rem' }}
                    onClick={() => {
                      const textToCopy = daxViewMode === 'flow' ? FLOW_DAX_TEMPLATE : activeDaxQuery;
                      void navigator.clipboard.writeText(textToCopy);
                      setCopiedDax(true);
                      setTimeout(() => setCopiedDax(false), 2000);
                    }}
                  >
                    {copiedDax ? '✓ Copied!' : '📋 Copy Query'}
                  </Button>
                </div>

                {daxViewMode === 'flow' && (
                  <div
                    style={{
                      background: 'rgba(56, 189, 248, 0.08)',
                      border: '1px solid rgba(56, 189, 248, 0.25)',
                      borderRadius: 8,
                      padding: '12px 16px',
                      marginBottom: 12,
                      fontSize: '0.82rem',
                      lineHeight: 1.5,
                      color: '#cbd5e1',
                    }}
                  >
                    <strong style={{ color: '#38bdf8', display: 'block', marginBottom: 4 }}>
                      ⚠️ Aturan Penting Formatting di Power Automate (Penyebab Data Kosong/0 Record):
                    </strong>
                    <ol style={{ margin: '0 0 0 16px', padding: 0 }}>
                      <li style={{ marginBottom: 4 }}>
                        <strong>Tanggal (Sama seperti WL_Frequency):</strong> Gunakan{' '}
                        <code style={{ color: '#fcd34d', background: '#1e293b', padding: '2px 4px', borderRadius: 4 }}>
                          FILTER(ALL(DimDate[Date]), DimDate[Date] = DATEVALUE("@&#123;triggerBody()['date']&#125;"))
                        </code>
                        . Pastikan tanda petik <code>""</code> menempel rapat tanpa spasi di dalamnya.
                      </li>
                      <li style={{ marginBottom: 4 }}>
                        <strong>Tanda Petik Tanpa Spasi:</strong> Pada PlantName, pastikan tidak ada spasi di dalam petik:{' '}
                        <code style={{ color: '#fcd34d', background: '#1e293b', padding: '2px 4px', borderRadius: 4 }}>
                          "&#64;&#123;triggerBody()['text']&#125;"
                        </code>
                        , BUKAN <code style={{ color: '#f87171' }}>" &#64;&#123;triggerBody()['text']&#125; "</code>.
                      </li>
                      <li>
                        <strong>Shift (Angka Numerik):</strong> Shift bertipe Number sehingga{' '}
                        <strong>TIDAK menggunakan tanda petik</strong>:{' '}
                        <code style={{ color: '#fcd34d', background: '#1e293b', padding: '2px 4px', borderRadius: 4 }}>
                          TREATAS(&#123;&#64;&#123;triggerBody()['number']&#125;&#125;, DimShift[DaySequenceNo])
                        </code>
                        .
                      </li>
                    </ol>
                  </div>
                )}

                <pre className="frequency-dax-code">
                  {daxViewMode === 'flow' ? FLOW_DAX_TEMPLATE : activeDaxQuery}
                </pre>
              </div>

              <div className="frequency-dialog-section">
                <h4>3. Dimensions & Measures</h4>
                <ul className="frequency-mapping-list">
                  <li>
                    <code>ConstructionDetail</code> ➔ <code>Group-Construction-LayLength-Tensile-Spool-StdLength-StdSpeed</code>.
                  </li>
                  <li>
                    <code>TotalProducedKG</code> / <code>TonProduced</code> ➔ Production output volume.
                  </li>
                  <li>
                    <code>AQualityKG</code> & <code>TotalRejectedKG</code> ➔ First-quality output vs rejected material.
                  </li>
                  <li>
                    <code>EffectiveHours</code> & <code>ScheduledHrs</code> ➔ Actual machine running hours vs planned shift schedule.
                  </li>
                  <li>
                    <code>TotalFracture</code>, <code>TotalDefect</code>, <code>DiesCount</code> ➔ Machine stoppage and maintenance counters.
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
