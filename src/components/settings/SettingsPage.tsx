import { useEffect, useMemo, useState } from 'react';
import type { FrequencyMode, TaskPriorityMode, WaitingModel } from '../../types';
import { BUILT_IN_DEFAULTS, loadDefaultValues, saveDefaultValues, type DefaultValues, type FrequencyDateRangeType } from '../../lib/defaultValuesStore';
import { computeFrequencyDateRange, generateDaxQuery, type DateRangeParts } from '../../lib/frequencyCatalog';
import { generateRejectShortDax } from '../../lib/rejectShortCatalog';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { DateInput, NumberInput, OptionalNumberInput, SelectInput, TextInput } from '../ui/Field';
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
  { value: 'historical', label: 'Historical (MES Data)' },
];

const DATE_RANGE_OPTIONS: { value: FrequencyDateRangeType; label: string }[] = [
  { value: 'last7Days', label: 'Last 7 Days' },
  { value: 'last14Days', label: 'Last 14 Days' },
  { value: 'last30Days', label: 'Last 30 Days' },
  { value: 'last3Months', label: 'Last 3 Months' },
  { value: 'last6Months', label: 'Last 6 Months' },
  { value: 'last1Year', label: 'Last 1 Year' },
  { value: 'custom', label: 'Custom (Select Start & End Date)' },
];

function formatDateRangeBadge(type: FrequencyDateRangeType): string {
  const match = DATE_RANGE_OPTIONS.find((opt) => opt.value === type);
  return match ? match.label.split(' (')[0] : 'Last 7 Days';
}

function formatDaxFilterSnippet(plant: string, computedRange: DateRangeParts, reasonCode?: string): string {
  const safePlant = plant.trim() || 'PTBI';
  const reasonLine = reasonCode ? `\nTREATAS({"${reasonCode}"}, DimReasonCode[Code]),` : '';
  return `-- Filter Plant
TREATAS({"${safePlant}"}, DimPlantRegion[PlantName]),${reasonLine}

-- 2. FILTER DATE BETWEEN (START DATE & END DATE)
FILTER(
    ALL(DimDate[Date]), 
    DimDate[Date] >= DATE(${computedRange.startParts.year}, ${computedRange.startParts.month}, ${computedRange.startParts.day}) && DimDate[Date] <= DATE(${computedRange.endParts.year}, ${computedRange.endParts.month}, ${computedRange.endParts.day})
)`;
}

/** Shared Plant & Date Range inputs + active range preview used for Power BI MES Data sources. */
function PowerBiDateRangeRows({
  plant,
  onPlantChange,
  dateRangeType,
  onDateRangeTypeChange,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
  computedRange,
}: {
  plant: string;
  onPlantChange: (v: string) => void;
  dateRangeType: FrequencyDateRangeType;
  onDateRangeTypeChange: (v: FrequencyDateRangeType) => void;
  startDate: string;
  onStartDateChange: (v: string) => void;
  endDate: string;
  onEndDateChange: (v: string) => void;
  computedRange: DateRangeParts;
}) {
  return (
    <>
      <SettingRow
        label="Plant Name (Power BI DimPlantRegion)"
        tooltip="Plant name filtered with TREATAS in Power BI Semantic Model (e.g. PTBI)."
      >
        <TextInput value={plant} placeholder="PTBI" onChange={onPlantChange} />
      </SettingRow>
      <SettingRow
        label="Date Range Filter (DimDate)"
        tooltip="Date range filter mode for DAX query. If selecting Custom, specify Start Date and End Date below."
      >
        <SelectInput
          value={dateRangeType}
          options={DATE_RANGE_OPTIONS}
          onChange={(v) => onDateRangeTypeChange(v as FrequencyDateRangeType)}
        />
      </SettingRow>
      {dateRangeType === 'custom' ? (
        <>
          <SettingRow label="Start Date">
            <DateInput value={startDate} onChange={onStartDateChange} />
          </SettingRow>
          <SettingRow label="End Date">
            <DateInput value={endDate} onChange={onEndDateChange} />
          </SettingRow>
        </>
      ) : (
        <SettingRow label="Active Calculated Date Range">
          <div className="frequency-active-date-pill">
            <span className="frequency-date-tag">📅 {computedRange.startDate}</span>
            <span className="frequency-date-separator">to</span>
            <span className="frequency-date-tag">📅 {computedRange.endDate}</span>
            <span className="frequency-date-badge-type">{formatDateRangeBadge(dateRangeType)}</span>
          </div>
        </SettingRow>
      )}
    </>
  );
}

/** Modal popup showing the live DAX filter snippet & complete query for a Power BI MES source. */
function DaxPreviewModal({
  title,
  snippet,
  fullQuery,
  copied,
  onCopy,
  onClose,
}: {
  title: string;
  snippet: string;
  fullQuery: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop frequency-dax-overlay" onClick={onClose}>
      <div
        className="frequency-dax-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '760px', width: '92vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            padding: '16px 20px',
            borderBottom: '1px solid #1e293b',
            background: '#0b1120',
          }}
        >
          <div>
            <span style={{ color: '#38bdf8', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Power BI DAX Query Preview
            </span>
            <h3 style={{ margin: '4px 0 2px', fontSize: '1.15rem', color: '#f8fafc', fontWeight: 600 }}>{title}</h3>
            <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8' }}>
              This filter is automatically injected into Power Automate &amp; Semantic Model
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} title="Close dialog">
            ✕
          </button>
        </div>

        <div style={{ padding: '16px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#94a3b8', marginBottom: '6px' }}>
              Active Plant &amp; Date Filter Snippet
            </div>
            <pre className="frequency-settings-dax-code" style={{ margin: 0 }}>{snippet}</pre>
          </div>

          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#94a3b8', marginBottom: '6px' }}>
              Complete DAX Query
            </div>
            <pre className="frequency-settings-dax-code" style={{ margin: 0, maxHeight: '300px', overflowY: 'auto' }}>{fullQuery}</pre>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            padding: '12px 20px',
            borderTop: '1px solid #1e293b',
            background: '#0b1120',
          }}
        >
          <Button variant="secondary" onClick={onCopy} title="Copy complete DAX query according to current settings">
            {copied ? '✓ DAX Copied!' : '📋 Copy DAX Query'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

function DefaultValuesCard() {
  const [saved, setSaved] = useState<DefaultValues | null>(null);
  const [draft, setDraft] = useState<DefaultValues>(BUILT_IN_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copiedDax, setCopiedDax] = useState(false);
  const [copiedRejectShortDax, setCopiedRejectShortDax] = useState(false);
  const [daxModalTarget, setDaxModalTarget] = useState<'frequency' | 'rejectShort' | null>(null);

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
    | 'defaultDiesPerTon'
    | 'defaultWwdPoLength1'
    | 'maxIdealDemandPercent';
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
    return formatDaxFilterSnippet(draft.frequencyPlant, computedRange);
  }, [draft.frequencyPlant, computedRange]);

  const handleCopyDax = () => {
    void navigator.clipboard.writeText(fullDaxQuery);
    setCopiedDax(true);
    setTimeout(() => setCopiedDax(false), 2500);
  };

  const computedRejectShortRange = useMemo(() => {
    return computeFrequencyDateRange(
      draft.rejectShortDateRangeType,
      draft.rejectShortStartDate,
      draft.rejectShortEndDate,
    );
  }, [draft.rejectShortDateRangeType, draft.rejectShortStartDate, draft.rejectShortEndDate]);

  const fullRejectShortDaxQuery = useMemo(() => {
    return generateRejectShortDax({
      plant: draft.rejectShortPlant?.trim() || 'PTBI',
      startParts: computedRejectShortRange.startParts,
      endParts: computedRejectShortRange.endParts,
    });
  }, [draft.rejectShortPlant, computedRejectShortRange]);

  const rejectShortDaxFilterSnippet = useMemo(() => {
    return formatDaxFilterSnippet(draft.rejectShortPlant, computedRejectShortRange, '1233');
  }, [draft.rejectShortPlant, computedRejectShortRange]);

  const handleCopyRejectShortDax = () => {
    void navigator.clipboard.writeText(fullRejectShortDaxQuery);
    setCopiedRejectShortDax(true);
    setTimeout(() => setCopiedRejectShortDax(false), 2500);
  };

  const isInvalidMaxIdealDemand = draft.manOcc100Percent && (draft.maxIdealDemandPercent == null || draft.maxIdealDemandPercent <= 100);

  const save = async () => {
    if (draft.manOcc100Percent) {
      const maxDemand = draft.maxIdealDemandPercent;
      if (maxDemand == null || !Number.isFinite(maxDemand) || maxDemand <= 100) {
        setError('Max Ideal Demand (%) must be greater than 100%.');
        return;
      }
    }
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
          <Button variant="primary" onClick={save} disabled={!dirty || saving || isInvalidMaxIdealDemand}>
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
          <SettingGroup title="Historical Frequency & Power BI (MES Data)">
            <SettingRow
              label="Default Frequency Source"
              tooltip="Default frequency source when selecting a Construction Detail in Work Load Simulator and Production Model. Users can override directly per scenario."
            >
              <SelectInput
                value={draft.frequencyMode}
                options={FREQUENCY_MODE_OPTIONS}
                onChange={(v) => set('frequencyMode', v)}
              />
            </SettingRow>
            <PowerBiDateRangeRows
              plant={draft.frequencyPlant}
              onPlantChange={(v) => set('frequencyPlant', v)}
              dateRangeType={draft.frequencyDateRangeType}
              onDateRangeTypeChange={(v) => set('frequencyDateRangeType', v)}
              startDate={draft.frequencyStartDate}
              onStartDateChange={(v) => set('frequencyStartDate', v)}
              endDate={draft.frequencyEndDate}
              onEndDateChange={(v) => set('frequencyEndDate', v)}
              computedRange={computedRange}
            />
            <SettingRow
              label="Default Fr / Ton Fallback"
              tooltip="Fallback Fracture/Ton rate if product specification has no frequency in WL_Products or MES_Frequency (0 = no fallback)."
            >
              <NumberInput
                value={draft.defaultFracturePerTon}
                min={0}
                onChange={(v) => setNumber('defaultFracturePerTon', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default Def / Ton Fallback"
              tooltip="Fallback Defect/Ton rate if not found in WL_Products or MES_Frequency."
            >
              <NumberInput
                value={draft.defaultDefectPerTon}
                min={0}
                onChange={(v) => setNumber('defaultDefectPerTon', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default Dies / Ton Fallback"
              tooltip="Fallback Dies/Ton rate if not found in WL_Products or MES_Frequency."
            >
              <NumberInput
                value={draft.defaultDiesPerTon}
                min={0}
                onChange={(v) => setNumber('defaultDiesPerTon', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default WW PO Length 1 (kg)"
              tooltip="Default Pay-Off Weight 1 (kg) specifically used for Area WW machines imported from MES Actual Output (where PO Weight is not present in MES). In Area WW, Pay-Off is weight-based (kilograms)."
            >
              <NumberInput
                value={draft.defaultWwdPoLength1}
                min={0}
                onChange={(v) => setNumber('defaultWwdPoLength1', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default BA PO Length 1 (kg)"
              tooltip="Default Pay-Off Weight 1 (kg) for Area BA. In Area BA, Pay-Off is weight-based (kilograms). Leave blank/null for no default value."
            >
              <OptionalNumberInput
                value={draft.defaultBaPoLength1}
                min={0}
                placeholder="null (blank)"
                onChange={(v) => set('defaultBaPoLength1', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default CA PO Length 1 (kg)"
              tooltip="Default Pay-Off Weight 1 (kg) for Area CA. In Area CA, Pay-Off is weight-based (kilograms). Leave blank/null for no default value."
            >
              <OptionalNumberInput
                value={draft.defaultCaPoLength1}
                min={0}
                placeholder="null (blank)"
                onChange={(v) => set('defaultCaPoLength1', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default IS PO Length 1 (kg)"
              tooltip="Default Pay-Off Weight 1 (kg) for Area IS. In Area IS, Pay-Off is weight-based (kilograms). Leave blank/null for no default value."
            >
              <OptionalNumberInput
                value={draft.defaultIsPoLength1}
                min={0}
                placeholder="null (blank)"
                onChange={(v) => set('defaultIsPoLength1', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default IP PO Length 1 (kg)"
              tooltip="Default Pay-Off Weight 1 (kg) for Area IP. In Area IP, Pay-Off is weight-based (kilograms). Leave blank/null for no default value."
            >
              <OptionalNumberInput
                value={draft.defaultIpPoLength1}
                min={0}
                placeholder="null (blank)"
                onChange={(v) => set('defaultIpPoLength1', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default BU PO Length 1 (m)"
              tooltip="Default Pay-Off Length 1 (meters) for Area BU. Leave blank/null if no default value is desired (requires manual setup in WL_Products)."
            >
              <OptionalNumberInput
                value={draft.defaultBuPoLength1}
                min={0}
                placeholder="null (blank)"
                onChange={(v) => set('defaultBuPoLength1', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default CB PO Length 1 (m)"
              tooltip="Default Pay-Off Length 1 (meters) for Area CB. Leave blank/null if no default value is desired (requires manual setup in WL_Products)."
            >
              <OptionalNumberInput
                value={draft.defaultCbPoLength1}
                min={0}
                placeholder="null (blank)"
                onChange={(v) => set('defaultCbPoLength1', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default SP PO Length 1 (m)"
              tooltip="Default Pay-Off Length 1 (meters) for Area SP. Leave blank/null if no default value is desired (requires manual setup in WL_Products)."
            >
              <OptionalNumberInput
                value={draft.defaultSpPoLength1}
                min={0}
                placeholder="null (blank)"
                onChange={(v) => set('defaultSpPoLength1', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default CH PO Length 1 (m)"
              tooltip="Default Pay-Off Length 1 (meters) for Area CH. Leave blank/null if no default value is desired (requires manual setup in WL_Products)."
            >
              <OptionalNumberInput
                value={draft.defaultChPoLength1}
                min={0}
                placeholder="null (blank)"
                onChange={(v) => set('defaultChPoLength1', v)}
              />
            </SettingRow>
            <SettingRow
              label="Default CR PO Length 1 (% SpoolLength)"
              tooltip="Default Pay-Off Length 1 for Area CR expressed as % of SpoolLength (e.g. 200 = 200% × SpoolLength, 50 = 50% × SpoolLength). Leave blank/null if no default value is desired (requires manual setup in WL_Products)."
            >
              <OptionalNumberInput
                value={draft.defaultCrPoLength1}
                min={0}
                placeholder="null (blank)"
                onChange={(v) => set('defaultCrPoLength1', v)}
              />
            </SettingRow>
            <SettingRow label="DAX Query (MES_Frequency)">
              <Button variant="secondary" onClick={() => setDaxModalTarget('frequency')}>
                🔍 View DAX Query
              </Button>
            </SettingRow>
          </SettingGroup>

          <SettingGroup title="Reject Short & Power BI (MES Data)">
            <SettingRow
              label="Default CR PO Length Source"
              tooltip="Default Pay-Off Length 1 source for Area CR in new Production Setups: Manual (WL_Products / % SpoolLength) or Historical AVG Meter/Spool from MES_RejectShort."
            >
              <SelectInput
                value={draft.poLengthCrSource}
                options={FREQUENCY_MODE_OPTIONS}
                onChange={(v) => set('poLengthCrSource', v)}
              />
            </SettingRow>
            <PowerBiDateRangeRows
              plant={draft.rejectShortPlant}
              onPlantChange={(v) => set('rejectShortPlant', v)}
              dateRangeType={draft.rejectShortDateRangeType}
              onDateRangeTypeChange={(v) => set('rejectShortDateRangeType', v)}
              startDate={draft.rejectShortStartDate}
              onStartDateChange={(v) => set('rejectShortStartDate', v)}
              endDate={draft.rejectShortEndDate}
              onEndDateChange={(v) => set('rejectShortEndDate', v)}
              computedRange={computedRejectShortRange}
            />
            <SettingRow label="DAX Query (MES_RejectShort)">
              <Button variant="secondary" onClick={() => setDaxModalTarget('rejectShort')}>
                🔍 View DAX Query
              </Button>
            </SettingRow>
          </SettingGroup>

          {daxModalTarget === 'frequency' && (
            <DaxPreviewModal
              title="Live DAX Filter Preview (MES_Frequency)"
              snippet={daxFilterSnippet}
              fullQuery={fullDaxQuery}
              copied={copiedDax}
              onCopy={handleCopyDax}
              onClose={() => setDaxModalTarget(null)}
            />
          )}
          {daxModalTarget === 'rejectShort' && (
            <DaxPreviewModal
              title="Live DAX Filter Preview (MES_RejectShort)"
              snippet={rejectShortDaxFilterSnippet}
              fullQuery={fullRejectShortDaxQuery}
              copied={copiedRejectShortDax}
              onCopy={handleCopyRejectShortDax}
              onClose={() => setDaxModalTarget(null)}
            />
          )}

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
              label="Man Occ 100%"
              tooltip="Yes: Optimize Man Occupation adjusts #machine assigned to ensure Man Occupation reaches 100% (adds 1 more machine if Man Occ < 100%, provided candidate Ideal Demand stays below Max Ideal Demand). Also impacts Theoretical Operator Required in Production Setup. No: standard optimization procedure."
            >
              <Toggle checked={draft.manOcc100Percent} onChange={(v) => set('manOcc100Percent', v)} ariaLabel="Man Occ 100%" />
            </SettingRow>
            {draft.manOcc100Percent && (
              <SettingRow
                label="Max Ideal Demand (%)"
                tooltip="When Man Occ 100% is Yes, adding 1 more machine to reach 100% Man Occupation is only allowed if that candidate's Ideal Demand is below this maximum percentage (default 120%). If Ideal Demand is greater than or equal to this limit, it remains at the lower machine count (cannot step up). Value must be greater than 100%."
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <NumberInput
                    value={draft.maxIdealDemandPercent}
                    min={100.1}
                    step={1}
                    onChange={(v) => setNumber('maxIdealDemandPercent', v)}
                  />
                  {draft.maxIdealDemandPercent <= 100 && (
                    <span style={{ color: '#ef4444', fontSize: '0.75rem', fontWeight: 500 }}>
                      Validation: value must be &gt; 100%
                    </span>
                  )}
                </div>
              </SettingRow>
            )}
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
                disabled={draft.manOcc100Percent}
                title={draft.manOcc100Percent ? 'Not used while Man Occ 100% is Yes' : undefined}
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
