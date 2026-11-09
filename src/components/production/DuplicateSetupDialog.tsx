import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProductionSetup } from '../../types';
import type { ProductionSetupSummary } from '../../lib/productionSetupsStore';
import { Button } from '../ui/Button';

interface DuplicateSetupDialogProps {
  setup: ProductionSetupSummary | ProductionSetup;
  onClose: () => void;
  onDuplicate: (newName: string) => Promise<void>;
}

export function DuplicateSetupDialog({ setup, onClose, onDuplicate }: DuplicateSetupDialogProps) {
  const [name, setName] = useState(`${setup.name} (Copy)`);
  const [duplicating, setDuplicating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !duplicating) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [duplicating, onClose]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Please provide a name for the duplicated setup.');
      return;
    }
    setDuplicating(true);
    setError(null);
    try {
      await onDuplicate(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to duplicate setup.');
      setDuplicating(false);
    }
  };

  return createPortal(
    <div className="modal-overlay om-detail-overlay" onClick={() => !duplicating && onClose()}>
      <div
        className="om-detail duplicate-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Duplicate Production Setup"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '480px' }}
      >
        <header className="om-detail-header">
          <div>
            <span className="om-detail-eyebrow">Duplicate Setup</span>
            <h3>Duplicate: {setup.name}</h3>
            <p style={{ margin: '4px 0 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>
              Create a full personal copy of this setup including all layout machines, operators, assignments, and settings.
            </p>
          </div>
          <button
            type="button"
            className="om-detail-close"
            onClick={onClose}
            disabled={duplicating}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px 0' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.78rem', color: '#cbd5e1', marginBottom: '6px', fontWeight: 600 }}>
              New Setup Name:
            </label>
            <input
              ref={inputRef}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={duplicating}
              required
            />
          </div>

          {error && (
            <p className="construction-selector-error" style={{ margin: 0 }}>
              {error}
            </p>
          )}

          <div className="operator-start-actions" style={{ marginTop: '8px' }}>
            <Button variant="ghost" type="button" onClick={onClose} disabled={duplicating}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={duplicating || !name.trim()}>
              {duplicating ? 'Duplicating…' : 'Duplicate Setup'}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
