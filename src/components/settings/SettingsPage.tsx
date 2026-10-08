import { useEffect, useState } from 'react';
import type { TaskPriorityMode, WaitingModel } from '../../types';
import { BUILT_IN_DEFAULTS, loadDefaultValues, saveDefaultValues, type DefaultValues } from '../../lib/defaultValuesStore';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { NumberInput, SelectInput } from '../ui/Field';
import { Toggle } from '../ui/Toggle';
import { DOFF_PRIORITY_TOOLTIP } from '../ui/doffPriorityText';
import { DefaultLayoutsCard } from './DefaultLayoutsCard';
import { SettingGroup, SettingRow } from './SettingRow';

const TASK_PRIORITY_OPTIONS: { value: TaskPriorityMode; label: string }[] = [
  { value: 'nearest', label: 'Nearest Task' },
  { value: 'quickest', label: 'Quickest Task' },
];

const WAITING_MODEL_OPTIONS: { value: WaitingModel; label: string }[] = [
  { value: 'none', label: 'None (backlog only)' },
  { value: 'wright', label: "Wright's formula" },
  { value: 'finiteSource', label: 'Finite source (M/M/1//N)' },
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

  type NumberKey = 'shiftTime' | 'lunchTime' | 'lunchStartAt' | 'meetingTime' | 'meetingStartAt' | 'rpc' | 'walkingSpeed' | 'minRemainForDoffPriority';
  const setNumber = (key: NumberKey, value: number) => set(key, Number.isFinite(value) ? value : 0);

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
          <SettingGroup title="Shift & Breaks">
            <SettingRow label="Shift Time (min)">
              <NumberInput value={draft.shiftTime} min={0} onChange={(v) => setNumber('shiftTime', v)} />
            </SettingRow>
            <SettingRow label="Lunch Time (min)">
              <NumberInput value={draft.lunchTime} min={0} onChange={(v) => setNumber('lunchTime', v)} />
            </SettingRow>
            <SettingRow label="Lunch Starts at Minute">
              <NumberInput value={draft.lunchStartAt} min={0} onChange={(v) => setNumber('lunchStartAt', v)} />
            </SettingRow>
            <SettingRow label="Meeting Time (min)">
              <NumberInput value={draft.meetingTime} min={0} onChange={(v) => setNumber('meetingTime', v)} />
            </SettingRow>
            <SettingRow label="Meeting Starts at Minute">
              <NumberInput value={draft.meetingStartAt} min={0} onChange={(v) => setNumber('meetingStartAt', v)} />
            </SettingRow>
          </SettingGroup>
          <SettingGroup title="Operator">
            <SettingRow label="Task Priority">
              <SelectInput value={draft.taskPriority} options={TASK_PRIORITY_OPTIONS} onChange={(v) => set('taskPriority', v)} />
            </SettingRow>
            <SettingRow label="RPC (%)">
              <NumberInput value={draft.rpc} min={0} onChange={(v) => setNumber('rpc', v)} />
            </SettingRow>
            <SettingRow label="Walking Speed (m/min)">
              <NumberInput value={draft.walkingSpeed} min={0} onChange={(v) => setNumber('walkingSpeed', v)} />
            </SettingRow>
            <SettingRow label="Doff Priority" tooltip={DOFF_PRIORITY_TOOLTIP}>
              <Toggle checked={draft.doffPriority} onChange={(v) => set('doffPriority', v)} ariaLabel="Doff Priority" />
            </SettingRow>
            <SettingRow label="Min Remain Task for Doff Priority (min)">
              <NumberInput
                value={draft.minRemainForDoffPriority}
                min={0}
                readOnly={!draft.doffPriority}
                onChange={(v) => setNumber('minRemainForDoffPriority', v)}
              />
            </SettingRow>
          </SettingGroup>
          <SettingGroup title="Forecast & Optimize">
            <SettingRow
              label="Use Waiting Model"
              tooltip="Yes: forecasts estimate machines waiting because they need the operator at the same time, with the Waiting Model below (Admins can change it per setup). No: no waiting model anywhere — forecasts and Optimize work as None (machines only wait for the backlog), and the Waiting Model field and its calculation are hidden in the Work Load Simulator and Production Setup."
            >
              <Toggle checked={draft.useWaitingModel} onChange={(v) => set('useWaitingModel', v)} ariaLabel="Use Waiting Model" />
            </SettingRow>
            <SettingRow
              label="Waiting Model"
              tooltip="How the Work Load Simulator forecast estimates machines waiting because they need the operator at the same time (machine interference)."
            >
              <SelectInput
                value={draft.waitingModel}
                options={WAITING_MODEL_OPTIONS}
                onChange={(v) => set('waitingModel', v)}
                disabled={!draft.useWaitingModel}
                title={draft.useWaitingModel ? undefined : 'Not used while Use Waiting Model is No'}
              />
            </SettingRow>
            <SettingRow
              label="Optimize Step-Up Below (%)"
              tooltip="Optimize Man Occupation finds the most machines the operator keeps up with (Forecast Man Occupation ≤ 100%). If that count still leaves Forecast Man Occupation below this value, it takes one more machine, even though that leaves a backlog. 0 turns it off."
            >
              <NumberInput
                value={draft.optimizeStepUpBelow}
                min={0}
                onChange={(v) => set('optimizeStepUpBelow', Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0)}
              />
            </SettingRow>
          </SettingGroup>
          {message && <p className="data-manager-hint">{message}</p>}
        </>
      )}
    </Card>
  );
}

const SETTING_SECTIONS = [
  { key: 'values', label: 'Default Values' },
  { key: 'layouts', label: 'Default Layouts' },
] as const;

type SettingSection = (typeof SETTING_SECTIONS)[number]['key'];

/** Setting — admin-only. One tab per section; both stay mounted so switching keeps unsaved edits. */
export function SettingsPage() {
  const [section, setSection] = useState<SettingSection>('values');
  return (
    <div className="settings-page">
      <div className="settings-tabs" role="tablist" aria-label="Setting sections">
        {SETTING_SECTIONS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={section === tab.key}
            className={section === tab.key ? 'active' : ''}
            onClick={() => setSection(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" hidden={section !== 'values'}>
        <DefaultValuesCard />
      </div>
      <div role="tabpanel" hidden={section !== 'layouts'}>
        <DefaultLayoutsCard />
      </div>
    </div>
  );
}
