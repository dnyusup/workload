import type { FrequencyChangeItem } from '../../lib/productionSetupFrequenciesStore';
import { Button } from '../ui/Button';

export interface FrequencySyncSummaryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  setupName: string;
  changes: FrequencyChangeItem[];
  frequencyMode?: string;
  dateRange?: { startDate?: string; endDate?: string };
}

export function FrequencySyncSummaryDialog({
  isOpen,
  onClose,
  setupName,
  changes,
  frequencyMode,
  dateRange,
}: FrequencySyncSummaryDialogProps) {
  if (!isOpen || changes.length === 0) return null;

  const newCount = changes.filter((c) => c.isNew).length;
  const updatedCount = changes.filter((c) => !c.isNew).length;

  const formatRate = (val: number) => val.toFixed(2);

  const renderRateDiff = (oldVal: number, newVal: number, isNew: boolean) => {
    if (isNew) {
      return <span className="sync-diff-new">{formatRate(newVal)}</span>;
    }
    const diff = newVal - oldVal;
    const isChanged = Math.abs(diff) > 0.0001;
    if (!isChanged) {
      return <span className="sync-diff-unchanged">{formatRate(newVal)}</span>;
    }
    return (
      <span className="sync-diff-changed">
        <span className="diff-old">{formatRate(oldVal)}</span>
        <span className="diff-arrow">→</span>
        <span className="diff-new">{formatRate(newVal)}</span>
      </span>
    );
  };

  const renderSourceDiff = (oldSource: string, newSource: string, isNew: boolean) => {
    if (isNew) {
      return <span className={`setup-freq-source-badge badge-${newSource.replace(/\s+/g, '-')}`}>{newSource}</span>;
    }
    if (oldSource === newSource) {
      return <span className={`setup-freq-source-badge badge-${newSource.replace(/\s+/g, '-')}`}>{newSource}</span>;
    }
    return (
      <span className="sync-source-changed">
        <span className={`setup-freq-source-badge badge-${oldSource.replace(/\s+/g, '-')}`}>{oldSource}</span>
        <span className="diff-arrow">→</span>
        <span className={`setup-freq-source-badge badge-${newSource.replace(/\s+/g, '-')}`}>{newSource}</span>
      </span>
    );
  };

  return (
    <div className="modal-backdrop frequency-sync-summary-overlay" onClick={onClose}>
      <div
        className="frequency-sync-summary-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="frequency-sync-summary-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="frequency-sync-summary-header">
          <div className="frequency-sync-title-area">
            <div className="frequency-sync-icon">
              <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" strokeWidth="2" fill="none">
                <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.66 0 3-4.03 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4.03-3-9s1.34-9 3-9" />
              </svg>
            </div>
            <div>
              <h3 id="frequency-sync-summary-title" className="frequency-sync-summary-title">
                Frequency Sync Summary
              </h3>
              <p className="frequency-sync-summary-subtitle">
                Setup: <strong>{setupName}</strong> ·{' '}
                {newCount > 0 && <span>{newCount} new row(s) added</span>}
                {newCount > 0 && updatedCount > 0 && ' · '}
                {updatedCount > 0 && <span>{updatedCount} row(s) updated</span>}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close setup-frequency-close-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>

        <div className="frequency-sync-context-bar">
          <span>Active Source Mode: <strong>{frequencyMode?.toUpperCase()}</strong></span>
          {frequencyMode === 'historical' && dateRange?.startDate && dateRange?.endDate && (
            <span>Range: <strong>{dateRange.startDate}</strong> to <strong>{dateRange.endDate}</strong></span>
          )}
        </div>

        <div className="frequency-sync-summary-body">
          <table className="setup-frequency-table frequency-sync-table">
            <thead>
              <tr>
                <th style={{ width: '80px' }}>Mach</th>
                <th>Construction</th>
                <th style={{ width: '90px' }}>Lay Length</th>
                <th style={{ width: '85px' }}>Tensile</th>
                <th style={{ width: '135px' }} className="text-right">Fr/T</th>
                <th style={{ width: '135px' }} className="text-right">Def/T</th>
                <th style={{ width: '135px' }} className="text-right">Dies/T</th>
                <th style={{ width: '180px' }} className="text-center">Source</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change, idx) => (
                <tr key={`${change.mach}-${change.construction}-${change.layLength}-${change.tensile}-${idx}`}>
                  <td className="mach-col">
                    <strong>{change.mach}</strong>
                  </td>
                  <td className="construction-col" title={change.construction}>
                    {change.construction}
                    {change.isNew && <span className="sync-new-tag">New</span>}
                  </td>
                  <td>{change.layLength || '—'}</td>
                  <td>{change.tensile || '—'}</td>
                  <td className="text-right">{renderRateDiff(change.oldFrt, change.newFrt, change.isNew)}</td>
                  <td className="text-right">{renderRateDiff(change.oldDeft, change.newDeft, change.isNew)}</td>
                  <td className="text-right">{renderRateDiff(change.oldDiest, change.newDiest, change.isNew)}</td>
                  <td className="text-center">{renderSourceDiff(change.oldSource, change.newSource, change.isNew)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="setup-frequency-dialog-footer">
          <div className="setup-freq-footer-info">
            <span>Rates in <strong>WL_productionsetupfrequency</strong> have been synchronized.</span>
          </div>
          <Button variant="primary" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}

