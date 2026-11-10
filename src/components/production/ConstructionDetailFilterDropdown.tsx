import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ConstructionDetailMetricRow {
  key: string;
  label: string;
  machineCount: number;
  oeeForecast: number;
  oeeSimulated: number;
  gap: number;
  machineIds: string[];
}

export interface ConstructionDetailFilterDropdownProps {
  rows: ConstructionDetailMetricRow[];
  totalRow: ConstructionDetailMetricRow;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  className?: string;
}

interface PanelPosition {
  left: number;
  top: number | null;
  bottom: number | null;
  width: number;
  listMaxHeight: number;
}

const PANEL_WIDTH = 520;
const VIEWPORT_MARGIN = 8;
const FULL_PANEL_HEIGHT = 360;

function fmt(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}

export function ConstructionDetailFilterDropdown({
  rows,
  totalRow,
  selectedKey,
  onSelect,
  className = '',
}: ConstructionDetailFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<'label' | 'oeeForecast' | 'oeeSimulated' | 'gap'>('label');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [position, setPosition] = useState<PanelPosition | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedRow = useMemo(() => {
    return rows.find((r) => r.key === selectedKey);
  }, [rows, selectedKey]);

  const updatePosition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const panelWidth = Math.max(rect.width, PANEL_WIDTH);

    let left = rect.left;
    if (left + panelWidth > window.innerWidth - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, window.innerWidth - panelWidth - VIEWPORT_MARGIN);
    }

    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - VIEWPORT_MARGIN;

    let openUpward = false;
    if (spaceBelow >= FULL_PANEL_HEIGHT) {
      openUpward = false;
    } else if (spaceAbove >= FULL_PANEL_HEIGHT) {
      openUpward = true;
    } else {
      openUpward = spaceAbove > spaceBelow;
    }

    const available = openUpward ? spaceAbove : spaceBelow;
    const listMaxHeight = Math.max(120, Math.min(320, available - 90));

    setPosition({
      left,
      width: panelWidth,
      top: openUpward ? null : rect.bottom + 4,
      bottom: openUpward ? window.innerHeight - rect.top + 4 : null,
      listMaxHeight,
    });
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const handleScrollOrResize = () => updatePosition();
    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('scroll', handleScrollOrResize, true);

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);

    return () => {
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [open]);

  const handleHeaderClick = (col: 'label' | 'oeeForecast' | 'oeeSimulated' | 'gap') => {
    if (sortKey === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col);
      setSortDir(col === 'label' ? 'asc' : 'desc');
    }
    if (col === 'label') {
      searchInputRef.current?.focus();
    }
  };

  const filteredAndSortedRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => r.label.toLowerCase().includes(q)) : rows;

    return [...filtered].sort((a, b) => {
      let diff = 0;
      if (sortKey === 'label') {
        diff = a.label.localeCompare(b.label);
      } else {
        diff = a[sortKey] - b[sortKey];
      }
      return sortDir === 'asc' ? diff : -diff;
    });
  }, [rows, query, sortKey, sortDir]);

  const portalTarget = open ? document.fullscreenElement ?? document.body : null;

  const renderGapBadge = (gap: number) => {
    const cls = gap > 0.05 ? 'cd-gap-positive' : gap < -0.05 ? 'cd-gap-negative' : 'cd-gap-neutral';
    const sign = gap > 0.05 ? '+' : '';
    return <span className={cls}>{sign}{fmt(gap)}%</span>;
  };

  return (
    <div className={`cd-filter-wrap ${className}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`cd-filter-trigger ${selectedKey !== null ? 'cd-filter-trigger-active' : ''}`}
        onClick={() => {
          if (!open) {
            setQuery('');
            updatePosition();
          }
          setOpen((v) => !v);
        }}
        title={
          selectedKey !== null
            ? `Filtered: ${selectedRow?.label ?? selectedKey} (Click to change)`
            : 'Filter machine timeline by Construction Detail'
        }
      >
        <span className="cd-trigger-icon" aria-hidden="true">🏗️</span>
        <span
          className="cd-trigger-label"
          title={selectedKey !== null ? (selectedRow?.label ?? selectedKey) : 'All Constructions'}
        >
          {selectedKey === null
            ? 'All Constructions'
            : `${selectedRow?.label ?? selectedKey} (${fmt(selectedRow?.oeeSimulated ?? 0)}%)`}
        </span>
        {selectedKey !== null && (
          <span
            role="button"
            tabIndex={0}
            className="cd-trigger-clear-icon"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                onSelect(null);
              }
            }}
            title="Clear Construction Detail filter"
            aria-label="Clear filter"
          >
            ✕
          </span>
        )}
        <span className="cd-trigger-caret" aria-hidden="true">▾</span>
      </button>

      {open && position && portalTarget &&
        createPortal(
          <div
            ref={panelRef}
            className="cd-filter-panel"
            style={{
              position: 'fixed',
              left: position.left,
              width: position.width,
              top: position.top ?? 'auto',
              bottom: position.bottom ?? 'auto',
              right: 'auto',
            }}
          >
            {/* Search Input Bar */}
            <div className="cd-filter-search-box">
              <span className="cd-filter-search-icon" aria-hidden="true">🔍</span>
              <input
                ref={searchInputRef}
                className="cd-filter-search-input"
                placeholder="Search construction detail…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setOpen(false);
                  }
                }}
              />
              {query && (
                <button
                  type="button"
                  className="cd-filter-search-clear"
                  onClick={() => setQuery('')}
                  title="Clear search"
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Table with Header & Rows */}
            <div className="cd-filter-table-wrap" style={{ maxHeight: position.listMaxHeight }}>
              <table className="cd-filter-table">
                <thead>
                  <tr>
                    <th
                      className="cd-col-name"
                      onClick={() => handleHeaderClick('label')}
                      title="Click to sort by Construction Detail or search"
                    >
                      <div className="cd-header-cell">
                        <span>Construction Detail</span>
                        <button
                          type="button"
                          className="cd-search-icon-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            searchInputRef.current?.focus();
                          }}
                          title="Focus search input"
                          aria-label="Focus search input"
                        >
                          🔍
                        </button>
                        {sortKey === 'label' && (
                          <span className="cd-sort-arrow" aria-hidden="true">
                            {sortDir === 'asc' ? '▲' : '▼'}
                          </span>
                        )}
                      </div>
                    </th>
                    <th
                      className="cd-col-num"
                      onClick={() => handleHeaderClick('oeeForecast')}
                      title="Click to sort by OEE Forecast"
                    >
                      <div className="cd-header-cell cd-header-num">
                        <span>OEE Forecast</span>
                        {sortKey === 'oeeForecast' && (
                          <span className="cd-sort-arrow" aria-hidden="true">
                            {sortDir === 'asc' ? '▲' : '▼'}
                          </span>
                        )}
                      </div>
                    </th>
                    <th
                      className="cd-col-num"
                      onClick={() => handleHeaderClick('oeeSimulated')}
                      title="Click to sort by OEE Simulated"
                    >
                      <div className="cd-header-cell cd-header-num">
                        <span>OEE Simulated</span>
                        {sortKey === 'oeeSimulated' && (
                          <span className="cd-sort-arrow" aria-hidden="true">
                            {sortDir === 'asc' ? '▲' : '▼'}
                          </span>
                        )}
                      </div>
                    </th>
                    <th
                      className="cd-col-num"
                      onClick={() => handleHeaderClick('gap')}
                      title="Click to sort by %Gap (Simulated − Forecast)"
                    >
                      <div className="cd-header-cell cd-header-num">
                        <span>%Gap</span>
                        {sortKey === 'gap' && (
                          <span className="cd-sort-arrow" aria-hidden="true">
                            {sortDir === 'asc' ? '▲' : '▼'}
                          </span>
                        )}
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {/* Total / All Constructions row */}
                  {!query && (
                    <tr
                      className={`cd-filter-row cd-filter-total-row ${selectedKey === null ? 'active' : ''}`}
                      onClick={() => {
                        onSelect(null);
                        setOpen(false);
                      }}
                      title="Show all machines across all constructions"
                    >
                      <td className="cd-col-name">
                        <span className="cd-name-text">🌐 All Constructions</span>
                        <span className="cd-count-badge">{totalRow.machineCount} machines</span>
                      </td>
                      <td>{fmt(totalRow.oeeForecast)}%</td>
                      <td>{fmt(totalRow.oeeSimulated)}%</td>
                      <td>{renderGapBadge(totalRow.gap)}</td>
                    </tr>
                  )}

                  {/* Filtered & sorted Construction rows */}
                  {filteredAndSortedRows.map((r) => {
                    const isSelected = r.key === selectedKey;
                    return (
                      <tr
                        key={r.key}
                        className={`cd-filter-row ${isSelected ? 'active' : ''}`}
                        onClick={() => {
                          onSelect(r.key);
                          setOpen(false);
                        }}
                        title={`Filter to ${r.label} (${r.machineCount} machines)`}
                      >
                        <td className="cd-col-name" title={r.label}>
                          <span className="cd-name-text">{r.label}</span>
                          <span className="cd-count-badge">{r.machineCount}</span>
                        </td>
                        <td>{fmt(r.oeeForecast)}%</td>
                        <td>{fmt(r.oeeSimulated)}%</td>
                        <td>{renderGapBadge(r.gap)}</td>
                      </tr>
                    );
                  })}

                  {filteredAndSortedRows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="cd-filter-empty">
                        No construction details match &ldquo;{query}&rdquo;
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>,
          portalTarget,
        )}
    </div>
  );
}

