import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TheoreticalActivityBreakdown, TheoreticalOperatorRow } from '../../lib/theoreticalOperators';

const fmt = (value: number, digits = 2) => value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Theoretical Operator Required for the setup's planned machines, pinned on the layout canvas;
 * click it to expand the per-activity breakdown or view the per-Construction Detail table. */
export function TheoreticalOperatorsBadge({
  total,
  rows,
  pending,
  unresolved,
  operatorsInSetup,
  loading,
  error,
  activityBreakdown,
}: {
  total: number;
  rows: TheoreticalOperatorRow[];
  /** Construction Details still being worked out. */
  pending: number;
  /** Construction Details Optimize couldn't find a count for (no work / spec missing). */
  unresolved: number;
  operatorsInSetup: number;
  loading: boolean;
  error: string | null;
  activityBreakdown?: TheoreticalActivityBreakdown | null;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const plannedMachines = rows.reduce((sum, row) => sum + row.machines, 0);
  if (plannedMachines === 0 && pending === 0 && !error) return null;
  const working = loading || pending > 0;

  return (
    <>
      <div className={`theoretical-operators-widget${error ? ' has-error' : ''}${expanded ? ' is-expanded' : ''}`}>
        <div className="theoretical-operators-header">
          <button
            type="button"
            className="theoretical-operators-badge"
            onClick={() => setExpanded((prev) => !prev)}
            title={
              error ??
              (expanded
                ? 'Click to collapse activity breakdown'
                : 'Click to expand activity breakdown (Doffing, Loading, Fracture Repairing, etc.)')
            }
            aria-expanded={expanded}
          >
            <span className="theoretical-operators-label">Theoretical Operator Required</span>
            <strong>{error ? '—' : fmt(total)}</strong>
            <span className="theoretical-operators-meta">
              {working ? `calculating${pending > 0 ? ` ${pending} more` : ''}…` : `${operatorsInSetup} in setup`}
            </span>
            <span className={`theoretical-operators-chevron ${expanded ? 'expanded' : ''}`} aria-hidden="true">
              ▼
            </span>
          </button>
        </div>

        {expanded && (
          <div className="theoretical-operators-expanded-panel">
            {activityBreakdown ? (
              <div className="theoretical-operators-activity-list">
                <div className="theoretical-operators-activity-row is-all-task">
                  <span className="activity-label">All Task:</span>
                  <span className="activity-metrics">
                    {activityBreakdown.allTask.operators !== undefined ? (
                      <strong className="activity-opr">{fmt(activityBreakdown.allTask.operators)} Opr Required</strong>
                    ) : (
                      <span className="activity-opr-pending">calculating…</span>
                    )}
                  </span>
                </div>
                {activityBreakdown.activities.map((act) => (
                  <div key={act.key} className="theoretical-operators-activity-row">
                    <span className="activity-bullet">·</span>
                    <span className="activity-label">{act.label}:</span>
                    <span className="activity-metrics">
                      {act.operators !== undefined ? (
                        <strong className="activity-opr">{fmt(act.operators)} Opr Required</strong>
                      ) : (
                        <span className="activity-opr-pending">calculating…</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : working ? (
              <p className="theoretical-operators-loading">Calculating activity breakdown…</p>
            ) : (
              <p className="theoretical-operators-loading">No Construction assigned yet</p>
            )}

            <div className="theoretical-operators-expanded-footer">
              <button
                type="button"
                className="theoretical-operators-detail-link"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(true);
                }}
              >
                📋 View Detail per Construction Detail ↗
              </button>
            </div>
          </div>
        )}
      </div>

      {open && (
        <TheoreticalOperatorsDialog
          total={total}
          rows={rows}
          pending={pending}
          unresolved={unresolved}
          operatorsInSetup={operatorsInSetup}
          activityBreakdown={activityBreakdown}
          error={error}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

type SortKey =
  | 'constructionDetail'
  | 'machines'
  | 'machinesPerOperator'
  | 'operators'
  | 'fracturePerTon'
  | 'defectPerTon'
  | 'diesPerTon'
  | 'frequencyRemark';

function TheoreticalOperatorsDialog({
  total,
  rows,
  pending,
  unresolved,
  operatorsInSetup,
  activityBreakdown,
  error,
  onClose,
}: {
  total: number;
  rows: TheoreticalOperatorRow[];
  pending: number;
  unresolved: number;
  operatorsInSetup: number;
  activityBreakdown?: TheoreticalActivityBreakdown | null;
  error: string | null;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('operators');
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const withoutLayout = rows.filter((row) => !row.hasDefaultLayout).length;

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(key === 'constructionDetail' || key === 'frequencyRemark');
    }
  };

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      return (
        r.constructionDetail.toLowerCase().includes(q) ||
        (r.frequencyRemark && r.frequencyRemark.toLowerCase().includes(q))
      );
    });
  }, [rows, search]);

  const sortedRows = useMemo(() => {
    const list = [...filteredRows];
    list.sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];

      if (valA === undefined || valA === null) return sortAsc ? 1 : -1;
      if (valB === undefined || valB === null) return sortAsc ? -1 : 1;

      if (typeof valA === 'string' && typeof valB === 'string') {
        const cmp = valA.localeCompare(valB, undefined, { numeric: true });
        return sortAsc ? cmp : -cmp;
      }

      if (typeof valA === 'number' && typeof valB === 'number') {
        return sortAsc ? valA - valB : valB - valA;
      }

      return 0;
    });
    return list;
  }, [filteredRows, sortKey, sortAsc]);

  const filteredMachines = sortedRows.reduce((sum, row) => sum + row.machines, 0);
  const filteredOperators = sortedRows.reduce((sum, row) => sum + row.operators, 0);

  const handleCopyTable = async () => {
    const headers = [
      'Construction Detail',
      'Machines',
      '#Assigned Machines',
      'Operators',
      'Fr / Ton',
      'Def / Ton',
      'Dies / Ton',
      'Remark',
    ];
    const bodyRows = sortedRows.map((r) => [
      r.constructionDetail + (!r.hasDefaultLayout ? ' (no default layout)' : ''),
      r.machines,
      r.machinesPerOperator > 0 ? r.machinesPerOperator : '—',
      r.operators.toFixed(2),
      r.fracturePerTon != null ? r.fracturePerTon.toFixed(2) : '—',
      r.defectPerTon != null ? r.defectPerTon.toFixed(2) : '—',
      r.diesPerTon != null ? r.diesPerTon.toFixed(2) : '—',
      r.frequencyRemark ?? '—',
    ]);
    const totalRow = [
      `Total${search ? ' (Filtered)' : ''}`,
      filteredMachines,
      '—',
      filteredOperators.toFixed(2),
      '—',
      '—',
      '—',
      '—',
    ];
    const tsv = [headers.join('\t'), ...bodyRows.map((row) => row.join('\t')), totalRow.join('\t')].join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy table to clipboard:', err);
    }
  };

  const renderSortTh = (label: string, key: SortKey, title?: string, alignRight?: boolean) => {
    const active = sortKey === key;
    return (
      <th
        onClick={() => handleSort(key)}
        className={`sortable-th ${active ? 'is-sorted' : ''} ${alignRight ? 'align-right' : ''}`}
        title={title ?? `Click to sort by ${label}`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleSort(key);
          }
        }}
      >
        <div className={`th-content ${alignRight ? 'is-right' : ''}`}>
          <span>{label}</span>
          <span className="sort-arrow" aria-hidden="true">
            {active ? (sortAsc ? '▲' : '▼') : '⇅'}
          </span>
        </div>
      </th>
    );
  };

  const renderRemarkBadge = (remark?: string) => {
    if (!remark) return <span className="freq-badge freq-badge-none">—</span>;
    if (remark === 'Historical') {
      return (
        <span className="freq-badge freq-badge-historical" title="Frequency rate taken from historical MES data">
          Historical
        </span>
      );
    }
    if (remark === 'Manual (Fallback)') {
      return (
        <span
          className="freq-badge freq-badge-fallback"
          title="Historical mode selected, but no historical record found in MES. Fallback to manual WL_Products rate."
        >
          Manual (Fallback)
        </span>
      );
    }
    return (
      <span className="freq-badge freq-badge-manual" title="Manual frequency mode active (WL_Products)">
        Manual
      </span>
    );
  };

  return createPortal(
    <div className="modal-overlay om-detail-overlay" onClick={onClose}>
      <div
        className="om-detail theoretical-operators-dialog theoretical-operators-dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Theoretical Operator Required"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="om-detail-header">
          <div>
            <span className="om-detail-eyebrow">Production Setup</span>
            <h3>Theoretical Operator Required: {fmt(total)}</h3>
            <p>
              Σ machines ÷ # Assigned Machines per Construction Detail — # Assigned Machines is Optimize Man Occupation with this setup's
              Shift & Movement Settings, the Area's Default Layout and Optimize Step-Up (Default Values). {operatorsInSetup} operator(s) in this setup.
            </p>
          </div>
          <button type="button" className="om-detail-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ×
          </button>
        </header>
        {error && <p className="construction-selector-error">{error}</p>}
        {pending > 0 && <p className="data-manager-hint">Still calculating {pending} Construction Detail(s) — the total grows as they finish.</p>}
        {unresolved > 0 && (
          <p className="data-manager-hint">
            {unresolved} Construction Detail(s) got no # Assigned Machines (no operator work — check WL_Products spec and WL_Activities) and count as 0.
          </p>
        )}
        {withoutLayout > 0 && (
          <p className="data-manager-hint">
            {withoutLayout} Construction Detail(s) have no Default Layout for their Area — walking is estimated on a stand-in grid.
          </p>
        )}
        {activityBreakdown && (
          <div className="theoretical-operators-dialog-summary">
            <div className="dialog-summary-title">Required per Activity Family</div>
            <div className="dialog-summary-list">
              <div className="summary-item is-all">
                <span>All Task:</span>
                <span>
                  {activityBreakdown.allTask.operators !== undefined ? (
                    <strong>{fmt(activityBreakdown.allTask.operators)} Opr Required</strong>
                  ) : (
                    'calculating…'
                  )}
                </span>
              </div>
              {activityBreakdown.activities.map((a) => (
                <div key={a.key} className="summary-item">
                  <span>· {a.label}:</span>
                  <span>
                    {a.operators !== undefined ? (
                      <strong>{fmt(a.operators)} Opr Required</strong>
                    ) : (
                      'calculating…'
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="theoretical-operators-toolbar">
          <div className="theoretical-search-wrap">
            <svg
              className="theoretical-search-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="input theoretical-search-input"
              placeholder="Search Construction Detail or Remark..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search Construction Details"
            />
            {search && (
              <button
                type="button"
                className="theoretical-search-clear"
                onClick={() => setSearch('')}
                title="Clear search"
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>
          <div className="theoretical-toolbar-actions">
            <span className="theoretical-row-count">
              {filteredRows.length === rows.length
                ? `${rows.length} items`
                : `${filteredRows.length} of ${rows.length} items`}
            </span>
            <button
              type="button"
              className={`btn theoretical-copy-btn ${copied ? 'is-copied' : ''}`}
              onClick={handleCopyTable}
              title="Copy table to clipboard to paste into Excel (TSV format)"
            >
              {copied ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span>Copy Table</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div className="theoretical-operators-table-wrap">
          <table className="table theoretical-dialog-table">
            <thead>
              <tr>
                {renderSortTh(
                  search.trim()
                    ? `Construction Detail (${filteredRows.length}/${rows.length})`
                    : `Construction Detail (${rows.length})`,
                  'constructionDetail',
                )}
                {renderSortTh('Machines', 'machines', undefined, true)}
                {renderSortTh('#Assigned Machines', 'machinesPerOperator', 'Optimize Man Occupation in the Work Load Simulator', true)}
                {renderSortTh('Operators', 'operators', undefined, true)}
                {renderSortTh('Fr / Ton', 'fracturePerTon', 'Fracture / Ton rate used for simulation', true)}
                {renderSortTh('Def / Ton', 'defectPerTon', 'Defect / Ton rate used for simulation', true)}
                {renderSortTh('Dies / Ton', 'diesPerTon', 'Dies Change / Ton rate used for simulation', true)}
                {renderSortTh('Remark', 'frequencyRemark', 'Frequency rate source: Historical vs Manual (Fallback) vs Manual')}
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty-table-cell">
                    No Construction Details match "{search}"
                  </td>
                </tr>
              ) : (
                sortedRows.map((row) => (
                  <tr key={row.productId}>
                    <td className="cd-cell">
                      <span className="cd-name">{row.constructionDetail}</span>
                      {!row.hasDefaultLayout && (
                        <span className="theoretical-operators-flag" title="No Default Layout for this Area">
                          {' '}
                          · no default layout
                        </span>
                      )}
                    </td>
                    <td className="text-right">{row.machines}</td>
                    <td className="text-right">{row.machinesPerOperator > 0 ? row.machinesPerOperator : '—'}</td>
                    <td className="text-right font-medium">{fmt(row.operators)}</td>
                    <td className="text-right">{row.fracturePerTon != null ? fmt(row.fracturePerTon) : '—'}</td>
                    <td className="text-right">{row.defectPerTon != null ? fmt(row.defectPerTon) : '—'}</td>
                    <td className="text-right">{row.diesPerTon != null ? fmt(row.diesPerTon) : '—'}</td>
                    <td className="text-center">{renderRemarkBadge(row.frequencyRemark)}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr>
                <th>Total {search ? '(Filtered)' : ''}</th>
                <th className="text-right">{filteredMachines}</th>
                <th />
                <th className="text-right">{fmt(filteredOperators)}</th>
                <th colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
