import { useEffect, useState } from 'react';
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
                    {activityBreakdown.allTask.forecastUtilizationPercent.toFixed(2)}% (ideal{' '}
                    {activityBreakdown.allTask.utilizationPercent.toFixed(2)}%)
                    {activityBreakdown.allTask.operators !== undefined ? (
                      <strong className="activity-opr"> - {fmt(activityBreakdown.allTask.operators)} Opr Required</strong>
                    ) : (
                      <span className="activity-opr-pending"> - calculating…</span>
                    )}
                  </span>
                </div>
                {activityBreakdown.activities.map((act) => (
                  <div key={act.key} className="theoretical-operators-activity-row">
                    <span className="activity-bullet">·</span>
                    <span className="activity-label">{act.label}:</span>
                    <span className="activity-metrics">
                      {act.forecastUtilizationPercent.toFixed(2)}% (ideal {act.utilizationPercent.toFixed(2)}%)
                      {act.operators !== undefined ? (
                        <strong className="activity-opr"> - {fmt(act.operators)} Opr Required</strong>
                      ) : (
                        <span className="activity-opr-pending"> - calculating…</span>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const machines = rows.reduce((sum, row) => sum + row.machines, 0);
  const withoutLayout = rows.filter((row) => !row.hasDefaultLayout).length;

  return createPortal(
    <div className="modal-overlay om-detail-overlay" onClick={onClose}>
      <div className="om-detail theoretical-operators-dialog" role="dialog" aria-modal="true" aria-label="Theoretical Operator Required" onClick={(e) => e.stopPropagation()}>
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
                  {activityBreakdown.allTask.forecastUtilizationPercent.toFixed(2)}% (ideal{' '}
                  {activityBreakdown.allTask.utilizationPercent.toFixed(2)}%)
                  {activityBreakdown.allTask.operators !== undefined ? (
                    <strong> - {fmt(activityBreakdown.allTask.operators)} Opr Required</strong>
                  ) : (
                    ' - calculating…'
                  )}
                </span>
              </div>
              {activityBreakdown.activities.map((a) => (
                <div key={a.key} className="summary-item">
                  <span>· {a.label}:</span>
                  <span>
                    {a.forecastUtilizationPercent.toFixed(2)}% (ideal {a.utilizationPercent.toFixed(2)}%)
                    {a.operators !== undefined ? (
                      <strong> - {fmt(a.operators)} Opr Required</strong>
                    ) : (
                      ' - calculating…'
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="theoretical-operators-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Construction Detail</th>
                <th>Machines</th>
                <th title="Optimize Man Occupation in the Work Load Simulator">#Assigned Machines</th>
                <th>Operators</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.productId}>
                  <td>
                    {row.constructionDetail}
                    {!row.hasDefaultLayout && (
                      <span className="theoretical-operators-flag" title="No Default Layout for this Area">
                        {' '}
                        · no default layout
                      </span>
                    )}
                  </td>
                  <td>{row.machines}</td>
                  <td>{row.machinesPerOperator > 0 ? row.machinesPerOperator : '—'}</td>
                  <td>{fmt(row.operators)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Total</th>
                <th>{machines}</th>
                <th />
                <th>{fmt(total)}</th>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
