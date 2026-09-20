import { Button } from '../ui/Button';

export function InheritedConditionDialog({
  constructionDetail,
  options,
  selectedId,
  onSelect,
  onCancel,
  onConfirm,
  error,
}: {
  constructionDetail?: string;
  options: Array<{ id: string; label: string }>;
  selectedId: string;
  onSelect: (id: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  error: string | null;
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-dialog inherited-condition-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inherited-condition-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="inherited-condition-title">Use inherited machine condition</h3>
        <p className="data-manager-hint">
          Select the saved machine condition version for Construction Detail{' '}
          <strong>{constructionDetail || '—'}</strong>.
        </p>
        <div className="inherited-condition-options">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`inherited-condition-option ${selectedId === option.id ? 'is-selected' : ''}`}
              onClick={() => onSelect(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {error && <p className="construction-selector-error">{error}</p>}
        <div className="modal-actions">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={onConfirm} disabled={!selectedId}>
            Use selected version
          </Button>
        </div>
      </div>
    </div>
  );
}
