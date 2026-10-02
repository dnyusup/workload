import { useEffect, useState } from 'react';
import type { TaskPriorityMode } from '../../types';
import { BUILT_IN_DEFAULTS, loadDefaultValues, saveDefaultValues, type DefaultValues } from '../../lib/defaultValuesStore';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Field, NumberInput, SelectInput } from '../ui/Field';

const TASK_PRIORITY_OPTIONS: { value: TaskPriorityMode; label: string }[] = [
  { value: 'nearest', label: 'Nearest Task' },
  { value: 'quickest', label: 'Quickest Task' },
];

const NUMBER_FIELDS: { key: Exclude<keyof DefaultValues, 'taskPriority'>; label: string; min: number }[] = [
  { key: 'shiftTime', label: 'Shift Time (min)', min: 0 },
  { key: 'lunchTime', label: 'Lunch Time (min)', min: 0 },
  { key: 'lunchStartAt', label: 'Lunch starts at minute', min: 0 },
  { key: 'meetingTime', label: 'Meeting Time (min)', min: 0 },
  { key: 'meetingStartAt', label: 'Meeting starts at minute', min: 0 },
  { key: 'rpc', label: 'RPC %', min: 0 },
  { key: 'walkingSpeed', label: 'Walking Speed (m/min)', min: 0 },
  { key: 'pixelsPerMeter', label: 'Layout Scale (px/meter)', min: 1 },
];

function DefaultValuesCard() {
  const [saved, setSaved] = useState<DefaultValues | null>(null);
  const [draft, setDraft] = useState<DefaultValues>(BUILT_IN_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadDefaultValues()
      .then((values) => {
        if (cancelled) return;
        setSaved(values);
        setDraft(values);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load WL_DefaultValues.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  const set = <K extends keyof DefaultValues>(key: K, value: DefaultValues[K]) => {
    setMessage(null);
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await saveDefaultValues(draft);
      setSaved(draft);
      setMessage('Default values saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save default values.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Default Values"
      subtitle="Starting values for new Production Setups, and for the Work Load Simulator setup each time a Construction Detail is picked"
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
      ) : (
        <>
          <div className="grid-2">
            <Field label="Task Priority">
              <SelectInput value={draft.taskPriority} options={TASK_PRIORITY_OPTIONS} onChange={(v) => set('taskPriority', v)} />
            </Field>
            {NUMBER_FIELDS.map(({ key, label, min }) => (
              <Field key={key} label={label}>
                <NumberInput value={draft[key]} min={min} onChange={(v) => set(key, Number.isFinite(v) ? v : 0)} />
              </Field>
            ))}
          </div>
          {message && <p className="data-manager-hint">{message}</p>}
        </>
      )}
    </Card>
  );
}

/** Setting — admin-only. Each group of settings is its own card. */
export function SettingsPage() {
  return (
    <div className="settings-page">
      <DefaultValuesCard />
    </div>
  );
}
