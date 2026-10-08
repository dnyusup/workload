import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TheoreticalOperatorRow } from '../../lib/theoreticalOperators';

const fmt = (value: number, digits = 2) => value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Theoretical Operator Required for the setup's planned machines, pinned on the layout canvas;
 * click it for the per-Construction Detail breakdown. */
export function TheoreticalOperatorsBadge({
  total,
  rows,
  pending,
  unresolved,
  operatorsInSetup,
  loading,
  error,
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
}) {
  const [open, setOpen] = useState(false);
  const plannedMachines = rows.reduce((sum, row) => sum + row.machines, 0);
  if (plannedMachines === 0 && pending === 0 && !error) return null;
  const working = loading || pending > 0;

  return (
    <>
      <button
        type="button"
        className={`theoretical-operators-badge${error ? ' has-error' : ''}`}
        onClick={() => setOpen(true)}
        title={
          error ??
          'Each planned machine needs 1 ÷ (# Assigned Machines) of an operator, where # Assigned Machines is what Optimize Man Occupation finds for its Construction Detail in the Work Load Simulator (Default Values, the Area\'s Default Layout, Optimize Step-Up). Click for the breakdown.'
        }
      >
        <span className="theoretical-operators-label">Theoretical Operator Required</span>
        <strong>{error ? '—' : fmt(total)}</strong>
        <span className="theoretical-operators-meta">
          {working ? `calculating${pending > 0 ? ` ${pending} more` : ''}…` : `${operatorsInSetup} in setup`}
        </span>
      </button>
      {open && (
        <TheoreticalOperatorsDialog
          total={total}
          rows={rows}
          pending={pending}
          unresolved={unresolved}
          operatorsInSetup={operatorsInSetup}
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
  error,
  onClose,
}: {
  total: number;
  rows: TheoreticalOperatorRow[];
  pending: number;
  unresolved: number;
  operatorsInSetup: number;
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
              Σ machines ÷ # Assigned Machines per Construction Detail — # Assigned Machines is Optimize Man Occupation in the Work Load
              Simulator (Default Values, the Area's Default Layout, Optimize Step-Up). {operatorsInSetup} operator(s) in this setup.
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
