import { useEffect, useMemo, useState } from 'react';
import type { FrequencyMode, TaskPriorityMode, WaitingModel } from '../../types';
import { BUILT_IN_DEFAULTS, loadDefaultValues, saveDefaultValues, type DefaultValues, type FrequencyDateRangeType } from '../../lib/defaultValuesStore';
import { computeFrequencyDateRange, generateDaxQuery } from '../../lib/frequencyCatalog';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { DateInput, NumberInput, SelectInput, TextInput } from '../ui/Field';
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

const FREQUENCY_MODE_OPTIONS: { value: FrequencyMode; label: string }[] = [
  { value: 'manual', label: 'Manual (WL_Products)' },
  { value: 'historical', label: 'Historical (WL_Frequency Power BI)' },
];

const DATE_RANGE_OPTIONS: { value: FrequencyDateRangeType; label: string }[] = [
  { value: 'last7Days', label: '7 Hari Terakhir (Last 7 Days)' },
  { value: 'last14Days', label: '14 Hari Terakhir (Last 14 Days)' },
  { value: 'last30Days', label: '30 Hari Terakhir (Last 30 Days)' },
  { value: 'custom', label: 'Kustom (Pilih Tanggal Awal & Akhir)' },
];

function DefaultValuesCard() {
  const [saved, setSaved] = useState<DefaultValues | null>(null);
  const [draft, setDraft] = useState<DefaultValues>(BUILT_IN_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copiedDax, setCopiedDax] = useState(false);

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

  type NumberKey =
    | 'shiftTime'
    | 'lunchTime'
    | 'lunchStartAt'
    | 'meetingTime'
    | 'meetingStartAt'
    | 'rpc'
    | 'walkingSpeed'
    | 'minRemainForDoffPriority'
    | 'defaultFracturePerTon'
    | 'defaultDefectPerTon'
    | 'defaultDiesPerTon';
  const setNumber = (key: NumberKey, value: number) => set(key, Number.isFinite(value) ? value : 0);

  const computedRange = useMemo(() => {
    return computeFrequencyDateRange(draft.frequencyDateRangeType, draft.frequencyStartDate, draft.frequencyEndDate);
  }, [draft.frequencyDateRangeType, draft.frequencyStartDate, draft.frequencyEndDate]);

  const fullDaxQuery = useMemo(() => {
    return generateDaxQuery({
      plant: draft.frequencyPlant?.trim() || 'PTBI',
      startParts: computedRange.startParts,
      endParts: computedRange.endParts,
    });
  }, [draft.frequencyPlant, computedRange]);

  const daxFilterSnippet = useMemo(() => {
    const plant = draft.frequencyPlant?.trim() || 'PTBI';
    return `-- Filter Plant
TREATAS({"${plant}"}, DimPlantRegion[PlantName]),

-- 2. FILTER DATE BETWEEN (ANTARA TANGGAL AWAL & TANGGAL AKHIR)
FILTER(
    ALL(DimDate[Date]), 
    DimDate[Date] >= DATE(${computedRange.startParts.year}, ${computedRange.startParts.month}, ${computedRange.startParts.day}) && DimDate[Date] <= DATE(${computedRange.endParts.year}, ${computedRange.endParts.month}, ${computedRange.endParts.day})
)`;
  }, [draft.frequencyPlant, computedRange]);

  const handleCopyDax = () => {
    void navigator.clipboard.writeText(fullDaxQuery);
    setCopiedDax(true);
    setTimeout(() => setCopiedDax(false), 2500);
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
          <SettingGroup title="Historical Frequency & Power BI (WL_Frequency)">
            <SettingRow
              label="Default Frequency Source"
              tooltip="Sumber frekuensi default saat memilih Construction Detail di Workload Simulator dan Production Model. Pengguna tetap dapat mengubahnya langsung per skenario."
            >
              <SelectInput
                value={draft.frequencyMode}
                options={FREQUENCY_MODE_OPTIONS}
                onChange={(v) => set('frequencyMode', v)}
              />
            </SettingRow>
            <SettingRow
              label="Plant Name (Power BI DimPlantRegion)"
              tooltip="Nama Plant yang difilter dengan TREATAS di Semantic Model Power BI (contoh: PTBI)."
            >
              <TextInput
                value={draft.frequencyPlant}
                placeholder="PTBI"
                onChange={(v) => set('frequencyPlant', v)}
              />
            </SettingRow>
            <SettingRow
              label="Filter Rentang Tanggal (DimDate)"
              tooltip="Mode filter rentang tanggal pada query DAX. Jika memilih Kustom, tentukan Tanggal Awal & Tanggal Akhir di bawah."
            >
              <SelectInput
                value={draft.frequencyDateRangeType}
                options={DATE_RANGE_OPTIONS}
                onChange={(v) => set('frequencyDateRangeType', v as FrequencyDateRangeType)}
              />
            </SettingRow>
            {draft.frequencyDateRangeType === 'custom' ? (
              <>
                <SettingRow label="Tanggal Awal (Start Date)">
                  <DateInput
                    value={draft.frequencyStartDate}
                    onChange={(v) => set('frequencyStartDate', v)}
                  />
                </SettingRow>
                <SettingRow label="Tanggal Akhir (End Date)">
                  <DateInput
                    value={draft.frequencyEndDate}
                    onChange={(v) => set('frequencyEndDate', v)}
                  />
                </SettingRow>
              </>
            ) : (
              <SettingRow label="Rentang Tanggal Aktif (Kalkulasi)">
                <div className="frequency-active-date-pill">
                  <span className="frequency-date-tag">📅 {computedRange.startDate}</span>
                  <span className="frequency-date-separator">s/d</span>
                  <span className="frequency-date-tag">📅 {computedRange.endDate}</span>
                  <span className="frequency-date-badge-type">
                    {draft.frequencyDateRangeType === 'last14Days'
                      ? '14 Hari Terakhir'
                      : draft.frequencyDateRangeType === 'last30Days'
                      ? '30 Hari Terakhir'
                      : '7 Hari Terakhir'}
                  </span>
                </div>
              </SettingRow>
            )}
            <SettingRow
              label="Default Fr / Ton Fallback"
              tooltip="Nilai cadangan Fracture/Ton jika suatu spesifikasi produk tidak memiliki data frekuensi di WL_Products maupun WL_Frequency (0 = tanpa fallback)."
            >
              <NumberInput
                value={draft.defaultFracturePerTon}
                min={0}
                onChange={(v) => setNumber('defaultFracturePerTon', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default Def / Ton Fallback"
              tooltip="Nilai cadangan Defect/Ton jika tidak ditemukan di WL_Products maupun WL_Frequency."
            >
              <NumberInput
                value={draft.defaultDefectPerTon}
                min={0}
                onChange={(v) => setNumber('defaultDefectPerTon', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default Dies / Ton Fallback"
              tooltip="Nilai cadangan Dies/Ton jika tidak ditemukan di WL_Products maupun WL_Frequency."
            >
              <NumberInput
                value={draft.defaultDiesPerTon}
                min={0}
                onChange={(v) => setNumber('defaultDiesPerTon', v)}
              />
            </SettingRow>
          </SettingGroup>

          {/* Live DAX Filter Preview Box */}
          <div className="frequency-settings-dax-box">
            <div className="frequency-settings-dax-header">
              <div>
                <span className="frequency-settings-dax-title">🔍 Live DAX Filter Preview</span>
                <span className="frequency-settings-dax-sub">Filter ini otomatis di-inject ke Power Automate & Semantic Model</span>
              </div>
              <div className="frequency-settings-dax-actions">
                <Button
                  variant="secondary"
                  onClick={handleCopyDax}
                  title="Salin query DAX lengkap sesuai setting saat ini"
                >
                  {copiedDax ? '✓ DAX Tersalin!' : '📋 Salin Query DAX'}
                </Button>
              </div>
            </div>
            <pre className="frequency-settings-dax-code">
              {daxFilterSnippet}
            </pre>
          </div>

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
