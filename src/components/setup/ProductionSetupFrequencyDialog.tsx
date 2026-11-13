import { useState, useMemo, useEffect } from 'react';
import type { Mpp_wl_productses } from '../../generated/models/Mpp_wl_productsesModel';
import type { FrequencyMode, ProductionMachineAssignment } from '../../types';
import type { HistoricalFrequencyMap } from '../../lib/frequencyCatalog';
import {
  type SetupFrequencyItem,
  type FrequencyChangeItem,
  updateSetupFrequencyItem,
  syncSetupFrequenciesForAssignments,
  deleteSetupFrequencyItem,
} from '../../lib/productionSetupFrequenciesStore';
import { Button } from '../ui/Button';

export interface ProductionSetupFrequencyDialogProps {
  isOpen: boolean;
  onClose: () => void;
  setupId: string;
  setupName: string;
  setupAssignments: ProductionMachineAssignment[];
  products: Mpp_wl_productses[];
  frequencyMode?: FrequencyMode;
  frequencyCatalog?: HistoricalFrequencyMap | null;
  items: SetupFrequencyItem[];
  onItemsChange: (items: SetupFrequencyItem[]) => void;
  onShowSyncSummary?: (changes: FrequencyChangeItem[]) => void;
  isReadOnly?: boolean;
}

export function ProductionSetupFrequencyDialog({
  isOpen,
  onClose,
  setupId,
  setupName,
  setupAssignments,
  products,
  frequencyMode = 'manual',
  frequencyCatalog = null,
  items,
  onItemsChange,
  onShowSyncSummary,
  isReadOnly = false,
}: ProductionSetupFrequencyDialogProps) {
  const [localItems, setLocalItems] = useState<SetupFrequencyItem[]>(items);
  const [editedIds, setEditedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'adjustment' | 'historical' | 'fallback manual' | 'manual'>('all');
  const [feedback, setFeedback] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Synchronize when items from parent change
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) {
        setLocalItems(items);
        setEditedIds(new Set());
      }
    });
    return () => {
      cancelled = true;
    };
  }, [items]);

  const handleRateChange = (id: string, field: 'frt' | 'deft' | 'diest', valueStr: string) => {
    if (isReadOnly) return;
    const num = Math.max(0, parseFloat(valueStr) || 0);
    setLocalItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        return {
          ...item,
          [field]: num,
          source: 'adjustment',
          isEdited: true,
        };
      }),
    );
    setEditedIds((prev) => new Set(prev).add(id));
  };

  const handleSaveChanges = async () => {
    if (isReadOnly || editedIds.size === 0) return;
    setSaving(true);
    setFeedback(null);
    let successCount = 0;
    let failCount = 0;

    const dirtyItems = localItems.filter((item) => editedIds.has(item.id));
    for (const item of dirtyItems) {
      const ok = await updateSetupFrequencyItem(item.id, {
        frt: item.frt,
        deft: item.deft,
        diest: item.diest,
        source: item.source,
      });
      if (ok) {
        successCount++;
      } else {
        failCount++;
      }
    }

    setSaving(false);
    if (failCount === 0) {
      setEditedIds(new Set());
      setFeedback({ message: `Successfully updated ${successCount} item(s).`, type: 'success' });
      onItemsChange(localItems.map((item) => ({ ...item, isEdited: false })));
    } else {
      setFeedback({
        message: `Updated ${successCount} item(s), but ${failCount} failed. Please try again.`,
        type: 'error',
      });
    }
  };

  const handleSyncMissing = async () => {
    if (!setupId || syncing) return;
    setSyncing(true);
    setFeedback(null);
    try {
      const { items: updated, changes } = await syncSetupFrequenciesForAssignments({
        setupId,
        assignments: setupAssignments,
        products,
        frequencyMode,
        frequencyCatalog,
        existingItems: localItems,
      });
      setLocalItems(updated);
      onItemsChange(updated);
      if (changes.length > 0) {
        if (onShowSyncSummary) {
          onShowSyncSummary(changes);
        } else {
          setFeedback({ message: `Updated ${changes.length} frequency rule(s).`, type: 'success' });
        }
      } else {
        setFeedback({ message: 'All assigned construction tuples are already up to date.', type: 'success' });
      }
    } catch (err) {
      setFeedback({
        message: `Sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        type: 'error',
      });
    } finally {
      setSyncing(false);
    }
  };

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDeleteItem = async (item: SetupFrequencyItem) => {
    if (isReadOnly || deletingId) return;
    if (!window.confirm(`Delete frequency rule for "${item.mach} · ${item.construction}"?`)) return;
    setDeletingId(item.id);
    setFeedback(null);
    try {
      const ok = await deleteSetupFrequencyItem(item.id);
      if (ok) {
        const updated = localItems.filter((i) => i.id !== item.id);
        setLocalItems(updated);
        onItemsChange(updated);
        setFeedback({ message: `Deleted frequency row for ${item.construction}.`, type: 'success' });
      } else {
        setFeedback({ message: `Failed to delete row for ${item.construction}.`, type: 'error' });
      }
    } catch (err) {
      setFeedback({
        message: `Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        type: 'error',
      });
    } finally {
      setDeletingId(null);
    }
  };

  const counts = useMemo(() => {
    const c = { all: localItems.length, adjustment: 0, historical: 0, 'fallback manual': 0, manual: 0 };
    for (const item of localItems) {
      if (item.source in c) {
        c[item.source as keyof typeof c]++;
      }
    }
    return c;
  }, [localItems]);

  const filteredItems = useMemo(() => {
    let list = localItems;
    if (sourceFilter !== 'all') {
      list = list.filter((item) => item.source === sourceFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (item) =>
          item.mach.toLowerCase().includes(q) ||
          item.construction.toLowerCase().includes(q) ||
          item.layLength.toLowerCase().includes(q) ||
          item.tensile.toLowerCase().includes(q) ||
          item.source.toLowerCase().includes(q),
      );
    }
    return list;
  }, [localItems, sourceFilter, search]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop setup-frequency-overlay" onClick={onClose}>
      <div
        className="setup-frequency-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-frequency-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="setup-frequency-dialog-header">
          <div className="setup-frequency-title-area">
            <div className="setup-frequency-icon">
              <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" strokeWidth="2" fill="none">
                <path d="M3 3h18v18H3z" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
            </div>
            <div>
              <h3 id="setup-frequency-dialog-title" className="setup-frequency-dialog-title">
                Setup Frequencies (WL_productionsetupfrequency)
              </h3>
              <p className="setup-frequency-dialog-subtitle">
                Setup: <strong>{setupName}</strong> · {localItems.length} total rate rule(s)
                {editedIds.size > 0 && <span className="setup-freq-dirty-tag"> · {editedIds.size} unsaved change(s)</span>}
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

        {feedback && (
          <div className={`setup-freq-feedback-bar ${feedback.type === 'error' ? 'error' : 'success'}`}>
            <span>{feedback.message}</span>
            <button type="button" onClick={() => setFeedback(null)}>✕</button>
          </div>
        )}

        <div className="setup-frequency-dialog-toolbar">
          <div className="setup-frequency-filter-pills">
            <button
              type="button"
              className={`setup-freq-pill ${sourceFilter === 'all' ? 'active' : ''}`}
              onClick={() => setSourceFilter('all')}
            >
              All ({counts.all})
            </button>
            <button
              type="button"
              className={`setup-freq-pill pill-adjustment ${sourceFilter === 'adjustment' ? 'active' : ''}`}
              onClick={() => setSourceFilter('adjustment')}
            >
              Adjustment ({counts.adjustment})
            </button>
            <button
              type="button"
              className={`setup-freq-pill pill-historical ${sourceFilter === 'historical' ? 'active' : ''}`}
              onClick={() => setSourceFilter('historical')}
            >
              Historical ({counts.historical})
            </button>
            <button
              type="button"
              className={`setup-freq-pill pill-fallback ${sourceFilter === 'fallback manual' ? 'active' : ''}`}
              onClick={() => setSourceFilter('fallback manual')}
            >
              Fallback Manual ({counts['fallback manual']})
            </button>
            <button
              type="button"
              className={`setup-freq-pill pill-manual ${sourceFilter === 'manual' ? 'active' : ''}`}
              onClick={() => setSourceFilter('manual')}
            >
              Manual ({counts.manual})
            </button>
          </div>

          <div className="setup-frequency-toolbar-actions">
            <div className="setup-freq-search-box">
              <input
                type="text"
                placeholder="Search Mach, Construction, Lay Length..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="setup-freq-search-input"
              />
              {search && (
                <button
                  type="button"
                  className="setup-freq-search-clear"
                  onClick={() => setSearch('')}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            <Button
              variant="secondary"
              onClick={handleSyncMissing}
              disabled={syncing || isReadOnly}
              title="Generate missing frequency rows from currently assigned machines/constructions"
            >
              {syncing ? 'Syncing...' : '🔄 Sync Missing'}
            </Button>

            {editedIds.size > 0 && (
              <Button
                variant="primary"
                onClick={handleSaveChanges}
                disabled={saving || isReadOnly}
                title="Save modified frequency rates to Dataverse"
              >
                {saving ? 'Saving...' : `💾 Save Changes (${editedIds.size})`}
              </Button>
            )}
          </div>
        </div>

        <div className="setup-frequency-dialog-body">
          {filteredItems.length === 0 ? (
            <div className="setup-frequency-empty-state">
              <p>No setup frequency entries match the current filter.</p>
              {localItems.length === 0 && (
                <p className="setup-frequency-empty-hint">
                  Click <strong>Sync Missing</strong> to automatically generate rows from assigned constructions.
                </p>
              )}
            </div>
          ) : (
            <div className="setup-frequency-table-wrap">
              <table className="setup-frequency-table">
                <thead>
                  <tr>
                    <th style={{ width: '85px' }}>Mach</th>
                    <th>Construction</th>
                    <th style={{ width: '95px' }}>Lay Length</th>
                    <th style={{ width: '90px' }}>Tensile</th>
                    <th style={{ width: '105px' }} className="text-right">Fr/T</th>
                    <th style={{ width: '105px' }} className="text-right">Def/T</th>
                    <th style={{ width: '105px' }} className="text-right">Dies/T</th>
                    <th style={{ width: '135px' }} className="text-center">Frequency Source</th>
                    <th style={{ width: '60px' }} className="text-center">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => {
                    const isDirty = editedIds.has(item.id);
                    return (
                      <tr key={item.id} className={isDirty ? 'setup-freq-row-dirty' : undefined}>
                        <td className="mach-col">
                          <strong>{item.mach || '—'}</strong>
                        </td>
                        <td className="construction-col" title={item.construction}>
                          {item.construction || '—'}
                        </td>
                        <td>{item.layLength || '—'}</td>
                        <td>{item.tensile || '—'}</td>
                        <td className="text-right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={item.frt}
                            disabled={isReadOnly}
                            onChange={(e) => handleRateChange(item.id, 'frt', e.target.value)}
                            className="setup-freq-rate-input"
                          />
                        </td>
                        <td className="text-right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={item.deft}
                            disabled={isReadOnly}
                            onChange={(e) => handleRateChange(item.id, 'deft', e.target.value)}
                            className="setup-freq-rate-input"
                          />
                        </td>
                        <td className="text-right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={item.diest}
                            disabled={isReadOnly}
                            onChange={(e) => handleRateChange(item.id, 'diest', e.target.value)}
                            className="setup-freq-rate-input"
                          />
                        </td>
                        <td className="text-center">
                          <span className={`setup-freq-source-badge badge-${item.source.replace(/\s+/g, '-')}`}>
                            {item.source === 'adjustment' && 'Adjustment'}
                            {item.source === 'historical' && 'Historical'}
                            {item.source === 'fallback manual' && 'Fallback Manual'}
                            {item.source === 'manual' && 'Manual'}
                          </span>
                        </td>
                        <td className="text-center">
                          <button
                            type="button"
                            className="field-reset-btn setup-freq-del-btn"
                            title={`Delete frequency rule for ${item.mach} - ${item.construction}`}
                            aria-label="Delete rule"
                            disabled={isReadOnly || deletingId === item.id}
                            onClick={() => handleDeleteItem(item)}
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="2" fill="none">
                              <path d="M3 6h18" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="setup-frequency-dialog-footer">
          <div className="setup-freq-footer-info">
            <span>Showing {filteredItems.length} of {localItems.length} frequency rule(s)</span>
          </div>
          <div className="setup-freq-footer-actions">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            {editedIds.size > 0 && (
              <Button
                variant="primary"
                onClick={handleSaveChanges}
                disabled={saving || isReadOnly}
              >
                {saving ? 'Saving...' : `Save Changes (${editedIds.size})`}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

