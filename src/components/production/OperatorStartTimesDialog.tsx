import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProductionOperator, ProductionSetup } from '../../types';
import { updateProductionOperatorStartTimes } from '../../lib/productionSetupsStore';
import { Button } from '../ui/Button';

type StartTimes = Pick<ProductionOperator, 'lunchStartAt' | 'meetingStartAt'>;

function parseMinute(value: string): number | undefined {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

/** Per-operator Lunch/Meeting start minute. A blank cell follows the setup's own start time. */
export function OperatorStartTimesDialog({
  setup,
  onSaved,
  onClose,
}: {
  setup: ProductionSetup;
  onSaved: (operators: ProductionOperator[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, StartTimes>>(() =>
    Object.fromEntries(setup.operators.map((op) => [op.id, { lunchStartAt: op.lunchStartAt, meetingStartAt: op.meetingStartAt }])),
  );
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const changedIds = useMemo(
    () =>
      setup.operators
        .filter((op) => draft[op.id]?.lunchStartAt !== op.lunchStartAt || draft[op.id]?.meetingStartAt !== op.meetingStartAt)
        .map((op) => op.id),
    [setup.operators, draft],
  );

  const visibleOperators = setup.operators.filter((op) => op.label.toLowerCase().includes(search.trim().toLowerCase()));

  const setTime = (id: string, key: keyof StartTimes, value: string) =>
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id], [key]: parseMinute(value) } }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const id of changedIds) {
        await updateProductionOperatorStartTimes(id, draft[id]);
      }
      onSaved(setup.operators.map((op) => ({ ...op, ...draft[op.id] })));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save operator start times.');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-overlay om-detail-overlay" onClick={() => !saving && onClose()}>
      <div
        className="om-detail operator-start-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Operator break start times"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="om-detail-header">
          <div>
            <span className="om-detail-eyebrow">Operators</span>
            <h3>Custom Lunch / Meeting start</h3>
            <p>
              Leave a cell blank to follow the setup ({setup.lunchStartAt} / {setup.meetingStartAt} min). Durations always follow
              the setup.
            </p>
          </div>
          <button type="button" className="om-detail-close" onClick={onClose} disabled={saving} aria-label="Close" title="Close (Esc)">
            ×
          </button>
        </header>

        {setup.operators.length === 0 ? (
          <p className="data-manager-hint">No operators yet.</p>
        ) : (
          <>
            <input className="input" placeholder="Search operator…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="operator-start-table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Operator</th>
                    <th>Lunch starts at minute</th>
                    <th>Meeting starts at minute</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOperators.map((op) => (
                    <tr key={op.id}>
                      <td>{op.label}</td>
                      <td>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          placeholder={`${setup.lunchStartAt} (setup)`}
                          value={draft[op.id]?.lunchStartAt ?? ''}
                          onChange={(e) => setTime(op.id, 'lunchStartAt', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          placeholder={`${setup.meetingStartAt} (setup)`}
                          value={draft[op.id]?.meetingStartAt ?? ''}
                          onChange={(e) => setTime(op.id, 'meetingStartAt', e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {error && <p className="construction-selector-error">{error}</p>}
        <div className="operator-start-actions">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={saving || changedIds.length === 0}>
            {saving ? 'Saving…' : `Save${changedIds.length > 0 ? ` (${changedIds.length})` : ''}`}
          </Button>
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
