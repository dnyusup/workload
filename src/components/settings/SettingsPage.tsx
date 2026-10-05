import { useEffect, useState } from 'react';
import type { TaskPriorityMode, WaitingModel } from '../../types';
import { BUILT_IN_DEFAULTS, loadDefaultValues, saveDefaultValues, type DefaultValues } from '../../lib/defaultValuesStore';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Field, NumberInput, SelectInput } from '../ui/Field';
import { Toggle } from '../ui/Toggle';
import { DOFF_PRIORITY_TOOLTIP } from '../ui/doffPriorityText';
import { DefaultLayoutsCard } from './DefaultLayoutsCard';

const TASK_PRIORITY_OPTIONS: { value: TaskPriorityMode; label: string }[] = [
  { value: 'nearest', label: 'Nearest Task' },
  { value: 'quickest', label: 'Quickest Task' },
];

const WAITING_MODEL_OPTIONS: { value: WaitingModel; label: string }[] = [
  { value: 'none', label: 'None (backlog only)' },
  { value: 'wright', label: "Wright's formula" },
  { value: 'finiteSource', label: 'Finite source (M/M/1//N)' },
];

const NUMBER_FIELDS: {
  key: Exclude<keyof DefaultValues, 'taskPriority' | 'doffPriority' | 'minRemainForDoffPriority' | 'waitingModel' | 'optimizeStepUpBelow'>;
  label: string;
  min: number;
}[] = [
  { key: 'shiftTime', label: 'Shift Time (min)', min: 0 },
  { key: 'lunchTime', label: 'Lunch Time (min)', min: 0 },
  { key: 'lunchStartAt', label: 'Lunch starts at minute', min: 0 },
  { key: 'meetingTime', label: 'Meeting Time (min)', min: 0 },
  { key: 'meetingStartAt', label: 'Meeting starts at minute', min: 0 },
  { key: 'rpc', label: 'RPC %', min: 0 },
  { key: 'walkingSpeed', label: 'Walking Speed (m/min)', min: 0 },
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
            <Field label="Doff Priority" tooltip={DOFF_PRIORITY_TOOLTIP}>
              <Toggle checked={draft.doffPriority} onChange={(v) => set('doffPriority', v)} ariaLabel="Doff Priority" />
            </Field>
            <Field label="Min Remain Task for Doff Priority (min)">
              <NumberInput
                value={draft.minRemainForDoffPriority}
                min={0}
                readOnly={!draft.doffPriority}
                onChange={(v) => set('minRemainForDoffPriority', Number.isFinite(v) ? v : 0)}
              />
            </Field>
            <Field
              label="Waiting Model"
              tooltip="How the Work Load Simulator forecast estimates machines waiting because they need the operator at the same time (machine interference)."
            >
              <SelectInput value={draft.waitingModel} options={WAITING_MODEL_OPTIONS} onChange={(v) => set('waitingModel', v)} />
            </Field>
            <Field
              label="Optimize Step-Up Below (%)"
              tooltip="Optimize Man Occupation finds the most machines the operator keeps up with (Forecast Man Occupation ≤ 100%). If that count still leaves Forecast Man Occupation below this value, it takes one more machine, even though that leaves a backlog. 0 turns it off."
            >
              <NumberInput
                value={draft.optimizeStepUpBelow}
                min={0}
                onChange={(v) => set('optimizeStepUpBelow', Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0)}
              />
            </Field>
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
      <DefaultLayoutsCard />
    </div>
  );
}
