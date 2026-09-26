import { useEffect, useState } from 'react';
import type { LayoutMachine, OperatorStartPoint, LayoutWall } from '../../types';
import { loadSavedLayouts, type SavedLayout } from '../../lib/savedLayoutsStore';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';

export function LayoutSelector({
  onSelect,
}: {
  onSelect: (machines: LayoutMachine[], operatorStart?: OperatorStartPoint, walls?: LayoutWall[]) => void;
}) {
  const [layouts, setLayouts] = useState<SavedLayout[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadSavedLayouts()
      .then((result) => {
        if (!cancelled) setLayouts(result);
      })
      .catch(() => {
        // Layout selector is a convenience shortcut — silently skip if it fails to load, the
        // main "Layouts" page surfaces the real error.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (layouts.length === 0) return null;

  return (
    <Card className="layout-selector-card">
      <Field label="Load Saved Layout" hint='Created in the "Layouts" menu — selecting one will overwrite the machine layout below.'>
        <select
          className="input"
          defaultValue=""
          onChange={(e) => {
            const layout = layouts.find((l) => l.id === e.target.value);
            if (layout) onSelect(layout.machines, layout.operatorStart, layout.walls);
            e.target.value = '';
          }}
        >
          <option value="" disabled>
            Select a saved layout…
          </option>
          {layouts.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.machines.length} machines)
            </option>
          ))}
        </select>
      </Field>
    </Card>
  );
}
