import { useEffect, useState } from 'react';
import type { LayoutMachine, OperatorStartPoint } from '../../types';
import {
  loadSavedLayouts,
  createSavedLayout,
  updateSavedLayout,
  deleteSavedLayout,
  type SavedLayout,
} from '../../lib/savedLayoutsStore';
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import { useAuth } from '../../context/AuthContext';
import { isOwnedByCurrentUser } from '../../lib/ownership';
import { resolveDisplayNames } from '../../lib/userDirectory';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { LayoutBuilder } from '../setup/LayoutBuilder';

export function LayoutManagerPage() {
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';
  const owns = (l: SavedLayout) => isAdmin || isOwnedByCurrentUser(l, user);
  const [layouts, setLayouts] = useState<SavedLayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creatorNames, setCreatorNames] = useState<Map<string, string>>(new Map());
  const [searchTerm, setSearchTerm] = useState('');

  // `createdbyname` from Dataverse comes back blank for records created through this app's own
  // connection — resolve real display names from the stamped creator email via Office365Users
  // instead (see userDirectory.ts), once per unique email in the loaded list.
  const creatorNameFor = (l: SavedLayout) => {
    if (l.createdByEmail) {
      if (l.createdByEmail.trim().toLowerCase() === user.email.trim().toLowerCase()) return user.displayName;
      return creatorNames.get(l.createdByEmail.trim().toLowerCase()) ?? l.createdByEmail;
    }
    return l.createdByName || 'Unknown';
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadSavedLayouts()
      .then((result) => {
        if (cancelled) return;
        setLayouts(result);
        setSelectedId(result[0]?.id ?? null);
        const emailsToResolve = result
          .map((l) => l.createdByEmail)
          .filter((email) => email && email.trim().toLowerCase() !== user.email.trim().toLowerCase());
        if (emailsToResolve.length > 0) {
          resolveDisplayNames(emailsToResolve).then((names) => {
            if (!cancelled) setCreatorNames(names);
          });
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load Layouts.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = layouts.find((l) => l.id === selectedId) ?? null;
  const filteredLayouts = layouts
    .filter((l) => {
      const q = searchTerm.trim().toLowerCase();
      if (!q) return true;
      return l.name.toLowerCase().includes(q) || creatorNameFor(l).toLowerCase().includes(q);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const addLayout = async () => {
    setBusy(true);
    setError(null);
    try {
      const layout = await createSavedLayout(`Layout ${layouts.length + 1}`, [], user.email);
      setLayouts((prev) => [...prev, layout]);
      setSelectedId(layout.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create Layout.');
    } finally {
      setBusy(false);
    }
  };

  const duplicateLayout = async (id: string) => {
    const source = layouts.find((l) => l.id === id);
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const layout = await createSavedLayout(`${source.name} Copy`, source.machines, user.email, source.operatorStart);
      setLayouts((prev) => [...prev, layout]);
      setSelectedId(layout.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to duplicate Layout.');
    } finally {
      setBusy(false);
    }
  };

  const deleteLayout = async (id: string) => {
    const layout = layouts.find((l) => l.id === id);
    if (!layout || !owns(layout)) return;
    if (!window.confirm(`Delete layout "${layout.name}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSavedLayout(id);
      setLayouts((prev) => {
        const next = prev.filter((l) => l.id !== id);
        setSelectedId((prevId) => (prevId === id ? next[0]?.id ?? null : prevId));
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete Layout.');
    } finally {
      setBusy(false);
    }
  };

  const persistName = useDebouncedCallback((id: string, name: string) => {
    updateSavedLayout(id, { name }).catch((err) => setError(err instanceof Error ? err.message : 'Failed to save name.'));
  }, 600);

  const renameLayout = (id: string, name: string) => {
    const layout = layouts.find((l) => l.id === id);
    if (!layout || !owns(layout)) return;
    setLayouts((prev) => prev.map((l) => (l.id === id ? { ...l, name, updatedAt: Date.now() } : l)));
    persistName(id, name);
  };

  // `machines` and `operatorStart` share one Dataverse column, so both are always sent together —
  // see the comment on updateSavedLayout in savedLayoutsStore.ts.
  const persistMachines = useDebouncedCallback((id: string, machines: LayoutMachine[], operatorStart: OperatorStartPoint | undefined) => {
    updateSavedLayout(id, { machines, operatorStart }).catch((err) => setError(err instanceof Error ? err.message : 'Failed to save layout.'));
  }, 800);

  const updateMachines = (id: string, machines: LayoutMachine[]) => {
    const layout = layouts.find((l) => l.id === id);
    if (!layout || !owns(layout)) return;
    setLayouts((prev) => prev.map((l) => (l.id === id ? { ...l, machines, updatedAt: Date.now() } : l)));
    persistMachines(id, machines, layout.operatorStart);
  };

  const updateOperatorStart = (id: string, operatorStart: OperatorStartPoint | null) => {
    const layout = layouts.find((l) => l.id === id);
    if (!layout || !owns(layout)) return;
    const next = operatorStart ?? undefined;
    setLayouts((prev) => prev.map((l) => (l.id === id ? { ...l, operatorStart: next, updatedAt: Date.now() } : l)));
    persistMachines(id, layout.machines, next);
  };

  return (
    <div className="layout-manager-grid">
      {error && (
        <div className="production-run-warnings" style={{ gridColumn: '1 / -1' }}>
          {error}
        </div>
      )}
      <Card
        title="Saved Layouts"
        subtitle="Create and save machine layouts to reuse in the Simulator"
        actions={
          <Button variant="secondary" onClick={addLayout} disabled={busy}>
            + New Layout
          </Button>
        }
      >
        {loading ? (
          <p className="data-manager-hint">Loading…</p>
        ) : layouts.length === 0 ? (
          <p className="data-manager-hint">No saved layouts yet. Click "+ New Layout" to create the first one.</p>
        ) : (
          <>
            <input
              className="input list-search-input"
              placeholder="Search by name or creator…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {filteredLayouts.length === 0 ? (
              <p className="data-manager-hint">No layouts match "{searchTerm}".</p>
            ) : (
              <div className="layout-list-scroll">
                <ul className="layout-list">
                  {filteredLayouts.map((l) => (
                    <li key={l.id} className={`layout-list-item ${selectedId === l.id ? 'active' : ''}`}>
                      <button
                        type="button"
                        className="layout-list-select"
                        title={`Last modified: ${new Date(l.updatedAt).toLocaleString()}`}
                        onClick={() => setSelectedId(l.id)}
                      >
                        <span className="layout-list-name">{l.name}</span>
                        <span className="layout-list-count">{l.machines.length} machines</span>
                        <span className="layout-list-count">
                          By {creatorNameFor(l)} · {new Date(l.createdAt).toLocaleString()}
                        </span>
                      </button>
                      <div className="layout-list-actions">
                        <Button variant="ghost" onClick={() => duplicateLayout(l.id)} disabled={busy}>
                          Duplicate
                        </Button>
                        {owns(l) && (
                          <Button variant="danger" onClick={() => deleteLayout(l.id)} disabled={busy}>
                            Delete
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Card>

      <div className="layout-manager-editor">
        {selected ? (
          <>
            <Card title="Layout Name" className="layout-name-card">
              <input
                className="input"
                value={selected.name}
                disabled={!owns(selected)}
                onChange={(e) => renameLayout(selected.id, e.target.value)}
              />
              {!owns(selected) && (
                <p className="data-manager-hint">
                  Created by {creatorNameFor(selected)} — view only. Use Duplicate to make your own editable copy.
                </p>
              )}
            </Card>
            <LayoutBuilder
              layout={selected.machines}
              readOnly={!owns(selected)}
              onChange={(machines) => updateMachines(selected.id, machines)}
              operatorStart={selected.operatorStart ?? null}
              onOperatorStartChange={(operatorStart) => updateOperatorStart(selected.id, operatorStart)}
            />
          </>
        ) : (
          <Card title="No Layout Selected">
            <p className="data-manager-hint">
              {loading ? 'Loading…' : 'Click "+ New Layout" to start creating a new one.'}
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
