import { useEffect, useState } from 'react';
import { loadDefaultLayouts, saveDefaultLayouts } from '../../lib/defaultValuesStore';
import { loadSavedLayouts, type SavedLayout } from '../../lib/savedLayoutsStore';
import { fetchAllPages } from '../../lib/dataversePaging';
import { Mpp_wl_productsesService } from '../../generated/services/Mpp_wl_productsesService';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';

/** Default layout per Area (WL_DefaultValues `Layout-<Area>` rows): the Work Load Simulator uses it
 * whenever a Construction Detail of that Area is picked. */
export function DefaultLayoutsCard() {
  const [areas, setAreas] = useState<string[]>([]);
  const [layouts, setLayouts] = useState<SavedLayout[]>([]);
  const [saved, setSaved] = useState<Record<string, string> | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchAllPages(Mpp_wl_productsesService.getAll, { select: ['mpp_wl_productsid', 'mpp_area'] }),
      loadSavedLayouts(),
      loadDefaultLayouts(),
    ])
      .then(([products, savedLayouts, defaults]) => {
        if (cancelled) return;
        const productAreas = products.map((product) => product.mpp_area?.trim().toUpperCase()).filter((area): area is string => !!area);
        setAreas([...new Set([...productAreas, ...Object.keys(defaults)])].sort());
        setLayouts([...savedLayouts].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
        setSaved(defaults);
        setDraft(defaults);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load default layouts.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const changedAreas = saved === null ? [] : areas.filter((area) => (draft[area] ?? '') !== (saved[area] ?? ''));
  const dirty = changedAreas.length > 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await saveDefaultLayouts(Object.fromEntries(changedAreas.map((area) => [area, draft[area] ?? ''])));
      setSaved({ ...draft });
      setMessage('Default layouts saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save default layouts.');
    } finally {
      setSaving(false);
    }
  };

  const layoutLabel = (layout: SavedLayout) => `${layout.name} (${layout.machines.length} machines)`;

  return (
    <Card
      title="Default Layouts"
      subtitle="Layout the Work Load Simulator uses for each Area when a Construction Detail is picked; machines are assigned from the top-left, two facing rows at a time"
      actions={
        <div className="data-manager-actions">
          <Button variant="ghost" onClick={() => saved && setDraft(saved)} disabled={!dirty || saving}>
            Discard
          </Button>
          <Button variant="primary" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      {error && <p className="construction-selector-error">{error}</p>}
      {loading ? (
        <p className="data-manager-hint">Loading…</p>
      ) : areas.length === 0 ? (
        <p className="data-manager-hint">No Area found in WL_Products.</p>
      ) : (
        <>
          <div className="grid-2">
            {areas.map((area) => {
              const value = draft[area] ?? '';
              const missing = value && !layouts.some((layout) => layout.id === value);
              return (
                <Field key={area} label={`Layout-${area}`}>
                  <select
                    className="input"
                    value={value}
                    onChange={(e) => {
                      setMessage(null);
                      setDraft((prev) => ({ ...prev, [area]: e.target.value }));
                    }}
                  >
                    <option value="">— None (pick a layout in the simulator) —</option>
                    {missing && <option value={value}>Missing layout ({value})</option>}
                    {layouts.map((layout) => (
                      <option key={layout.id} value={layout.id}>
                        {layoutLabel(layout)}
                      </option>
                    ))}
                  </select>
                </Field>
              );
            })}
          </div>
          {message && <p className="data-manager-hint">{message}</p>}
        </>
      )}
    </Card>
  );
}
