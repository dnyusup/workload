import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProductionSetup } from '../../types';
import { updateProductionSetupHeader, type ProductionSetupSummary } from '../../lib/productionSetupsStore';
import { Office365UsersService } from '../../generated/services/Office365UsersService';
import type { User } from '../../generated/models/Office365UsersModel';
import { Button } from '../ui/Button';

interface ShareProductionSetupDialogProps {
  setup: ProductionSetupSummary | ProductionSetup;
  onClose: () => void;
  onSuccess: (updatedSharedEmail: string) => void;
}

export function ShareProductionSetupDialog({ setup, onClose, onSuccess }: ShareProductionSetupDialogProps) {
  const initialEmails = (setup.sharedEmail ?? '')
    .split(/[,;\s]+/)
    .map((e: string) => e.trim().toLowerCase())
    .filter(Boolean);

  const [emails, setEmails] = useState<string[]>(initialEmails);
  const [inputVal, setInputVal] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saving, onClose]);

  const runSearch = (term: string) => {
    const q = term.trim();
    if (!q || q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    Office365UsersService.SearchUser(q, 6)
      .then((res) => {
        if (searchSeq.current !== seq) return;
        setSearchResults(res.success && res.data ? res.data : []);
      })
      .catch(() => {
        if (searchSeq.current === seq) setSearchResults([]);
      })
      .finally(() => {
        if (searchSeq.current === seq) setSearching(false);
      });
  };

  const handleInputChange = (val: string) => {
    setInputVal(val);
    setError(null);
    runSearch(val);
  };

  const addEmail = (rawEmail: string) => {
    const clean = rawEmail.trim().toLowerCase();
    if (!clean) return;
    if (!clean.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    if (emails.includes(clean)) {
      setError(`"${clean}" is already in the share list.`);
      return;
    }
    setEmails((prev) => [...prev, clean]);
    setInputVal('');
    setSearchResults([]);
    setError(null);
  };

  const removeEmail = (emailToRemove: string) => {
    setEmails((prev) => prev.filter((e) => e !== emailToRemove));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const joined = emails.join(';');
    try {
      await updateProductionSetupHeader(setup.id, { sharedEmail: joined });
      onSuccess(joined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save shared users.');
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-overlay om-detail-overlay" onClick={() => !saving && onClose()}>
      <div
        className="om-detail share-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Share Production Setup"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '540px' }}
      >
        <header className="om-detail-header">
          <div>
            <span className="om-detail-eyebrow">Production Setup Sharing</span>
            <h3>Share Setup: {setup.name}</h3>
            <p style={{ margin: '4px 0 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>
              Shared contributors will have <strong>read-only</strong> access to this setup and can duplicate it to their own workspace.
            </p>
          </div>
          <button
            type="button"
            className="om-detail-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px 0' }}>
          {/* Add email input with autocomplete */}
          <div style={{ position: 'relative' }}>
            <label style={{ display: 'block', fontSize: '0.78rem', color: '#cbd5e1', marginBottom: '6px', fontWeight: 600 }}>
              Add contributor by name or email:
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                ref={inputRef}
                className="input"
                style={{ flex: 1 }}
                placeholder="e.g. name or user@bekaert.com…"
                value={inputVal}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchResults.length > 0) {
                      const first = searchResults[0];
                      const mail = first.Mail ?? first.UserPrincipalName ?? '';
                      if (mail) addEmail(mail);
                    } else if (inputVal.trim()) {
                      addEmail(inputVal);
                    }
                  }
                }}
                disabled={saving}
              />
              <Button
                variant="secondary"
                type="button"
                onClick={() => addEmail(inputVal)}
                disabled={saving || !inputVal.trim()}
              >
                + Add
              </Button>
            </div>

            {/* Dropdown autocomplete results */}
            {searchResults.length > 0 && (
              <ul
                className="share-autocomplete-list"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  marginTop: '4px',
                  background: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)',
                  maxHeight: '180px',
                  overflowY: 'auto',
                  zIndex: 20,
                  listStyle: 'none',
                  padding: '4px',
                }}
              >
                {searchResults.map((user, idx) => {
                  const mail = (user.Mail ?? user.UserPrincipalName ?? '').trim();
                  return (
                    <li
                      key={user.Id ?? mail ?? idx}
                      style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        borderRadius: '6px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
                        fontSize: '0.82rem',
                        transition: 'background 0.15s ease',
                      }}
                      className="share-autocomplete-item"
                      onClick={() => addEmail(mail)}
                    >
                      <strong style={{ color: '#f8fafc' }}>{user.DisplayName || mail}</strong>
                      <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{mail}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {searching && (
              <span style={{ position: 'absolute', right: '90px', top: '35px', fontSize: '0.72rem', color: '#94a3b8' }}>
                Searching…
              </span>
            )}
          </div>

          {/* List of currently shared users */}
          <div>
            <label style={{ display: 'block', fontSize: '0.78rem', color: '#cbd5e1', marginBottom: '8px', fontWeight: 600 }}>
              Shared with ({emails.length}):
            </label>
            {emails.length === 0 ? (
              <div
                style={{
                  padding: '20px',
                  background: 'rgba(15, 23, 42, 0.5)',
                  border: '1px dashed #334155',
                  borderRadius: '8px',
                  textAlign: 'center',
                  color: '#64748b',
                  fontSize: '0.82rem',
                }}
              >
                Not shared with anyone yet. Enter an email above to share.
              </div>
            ) : (
              <div
                style={{
                  maxHeight: '220px',
                  overflowY: 'auto',
                  border: '1px solid #1e293b',
                  borderRadius: '8px',
                  background: '#0b1120',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {emails.map((email) => (
                  <div
                    key={email}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      borderBottom: '1px solid #1e293b',
                      fontSize: '0.82rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span
                        style={{
                          width: '26px',
                          height: '26px',
                          borderRadius: '50%',
                          background: 'rgba(56, 189, 248, 0.15)',
                          color: '#38bdf8',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 700,
                          fontSize: '0.75rem',
                        }}
                      >
                        {email[0]?.toUpperCase() ?? '@'}
                      </span>
                      <span style={{ color: '#f1f5f9', fontFamily: 'monospace' }}>{email}</span>
                      <span
                        style={{
                          fontSize: '0.68rem',
                          background: 'rgba(56, 189, 248, 0.12)',
                          color: '#38bdf8',
                          border: '1px solid rgba(56, 189, 248, 0.25)',
                          padding: '1px 6px',
                          borderRadius: '4px',
                        }}
                      >
                        Read-only
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeEmail(email)}
                      disabled={saving}
                      title={`Remove ${email}`}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#ef4444',
                        cursor: 'pointer',
                        padding: '4px 8px',
                        fontSize: '0.9rem',
                        borderRadius: '4px',
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <p className="construction-selector-error" style={{ margin: 0 }}>
              {error}
            </p>
          )}
        </div>

        <div className="operator-start-actions" style={{ marginTop: '8px' }}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
