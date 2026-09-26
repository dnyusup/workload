import type { ReactNode } from 'react';
import type { AppConfig } from '../../types';
import { deriveMachineSpec, fractureRepairingDenominator } from '../../lib/calculations';
import { Button } from '../ui/Button';
import { ShiftStartField } from '../ui/ShiftStartField';
import { ShiftTimeCard } from './ShiftTimeCard';

export function Controls({
  playing,
  speed,
  onPlay,
  onPause,
  onReset,
  onSpeedChange,
  onBack,
  finished,
  config,
  setConfig,
  liveSettingsDisabled,
  elapsedMinutes,
  totalMinutes,
  availableMinutes,
  breakMessage,
  canSaveWlm,
  onSaveWlm,
  savingWlm,
  savedWlm,
  canCopyOutput,
  onViewOutput,
  viewingOutput = false,
  onCopyOutput,
  copyingOutput,
  copiedOutput,
  inheritedConditionOptions,
  onOpenInheritedCondition,
}: {
  playing: boolean;
  speed: number;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onSpeedChange: (speed: number) => void;
  onBack: () => void;
  finished: boolean;
  config: AppConfig;
  setConfig: (updater: (prev: AppConfig) => AppConfig) => void;
  /** #Mach Assigned / Fracture per Ton can only be edited right after Reset — once the shift has
   * actually started (playing or mid-shift), changing them would restart mid-way through, which is
   * confusing, so they're locked until the next Reset. */
  liveSettingsDisabled: boolean;
  elapsedMinutes: number;
  totalMinutes: number;
  availableMinutes: number;
  breakMessage?: ReactNode;
  canSaveWlm: boolean;
  onSaveWlm: () => void;
  savingWlm: boolean;
  savedWlm: boolean;
  canCopyOutput: boolean;
  /** Opens the finished run's output model in the same detail popup as WL_Outputmodels. */
  onViewOutput?: () => void;
  viewingOutput?: boolean;
  onCopyOutput: () => void;
  copyingOutput: boolean;
  copiedOutput: boolean;
  inheritedConditionOptions: Array<{ id: string; label: string }>;
  onOpenInheritedCondition: () => void;
}) {
  const handleMachHandledChange = (value: number) => {
    if (!Number.isFinite(value)) return;
    setConfig((prev) => ({ ...prev, operator: { ...prev.operator, machHandled: Math.max(0, value) } }));
  };

  const handleFracturePerTonChange = (value: number) => {
    if (!Number.isFinite(value)) return;
    setConfig((prev) => {
      const nextSpec = { ...prev.spec, fracturePerTon: value };
      const derived = deriveMachineSpec(nextSpec);
      return {
        ...prev,
        spec: nextSpec,
        // Fracture Repairing's numerator/denominator are formula-driven (Fracture/Ton, 1000/SpoolWeight)
        // — re-resolve them here the same way starting a simulation does, so the live edit actually
        // changes the fracture cycle instead of just the displayed spec value.
        activities: prev.activities.map((a) => ({
          ...a,
          numerator: a.key === 'fractureRepairing' && a.numeratorAuto ? value : a.numerator,
          denominator: a.denominatorAuto ? fractureRepairingDenominator(derived.spoolWeight) : a.denominator,
        })),
      };
    });
  };

  return (
    <div className="controls-bar">
      <Button variant="ghost" onClick={onBack}>
        &larr; Edit Setup
      </Button>
      <div className="controls-live-settings">
        <span className="controls-construction-detail">
          Construction Detail: <strong>{config.selectedConstructionDetail ?? '—'}</strong>
        </span>
        <label className="controls-live-field">
          <span title="Machines assigned to the operator">#Mach</span>
          <input
            className={`input input-sm ${liveSettingsDisabled ? 'input-readonly' : ''}`}
            type="number"
            min={0}
            value={config.operator.machHandled}
            readOnly={liveSettingsDisabled}
            onChange={(e) => handleMachHandledChange(parseInt(e.target.value, 10))}
            title={liveSettingsDisabled ? 'Click Reset to edit before starting the shift' : 'Changes here restart the simulation with the new value'}
          />
        </label>
        <label className="controls-live-field">
          <span title="Fracture per ton">Fr/Ton</span>
          <input
            className={`input input-sm ${liveSettingsDisabled ? 'input-readonly' : ''}`}
            type="number"
            min={0}
            step={0.01}
            // Shown (and, when edited here, stored) to 2 decimals.
            value={Math.round(config.spec.fracturePerTon * 100) / 100}
            readOnly={liveSettingsDisabled}
            onChange={(e) => handleFracturePerTonChange(Math.round(parseFloat(e.target.value) * 100) / 100)}
            title={liveSettingsDisabled ? 'Click Reset to edit before starting the shift' : 'Changes here restart the simulation with the new value'}
          />
        </label>
      </div>
      <ShiftTimeCard
        elapsedMinutes={elapsedMinutes}
        totalMinutes={totalMinutes}
        availableMinutes={availableMinutes}
        breakMessage={breakMessage}
      />
      {finished && <span className="finished-badge">Shift complete</span>}
      {finished && canSaveWlm && (
        <Button variant="secondary" onClick={onSaveWlm} disabled={savingWlm || savedWlm}>
          {savingWlm ? 'Saving…' : savedWlm ? 'WLM Saved' : 'Save WLM'}
        </Button>
      )}
      {finished && canCopyOutput && onViewOutput && (
        <Button
          variant="secondary"
          className="controls-icon-button"
          onClick={onViewOutput}
          disabled={viewingOutput}
          title="View output details"
          aria-label="View output details"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </Button>
      )}
      {finished && canCopyOutput && (
        <Button
          variant="secondary"
          className="controls-icon-button"
          onClick={onCopyOutput}
          disabled={copyingOutput}
          title={copiedOutput ? 'Copied' : 'Copy output (tab-separated, paste into Excel)'}
          aria-label={copiedOutput ? 'Output copied' : 'Copy output'}
        >
          {copiedOutput ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V6a2 2 0 0 1 2-2h9" />
            </svg>
          )}
        </Button>
      )}
      {!playing && !finished && inheritedConditionOptions.length > 0 && (
        <Button variant="secondary" onClick={onOpenInheritedCondition}>
          ↺ Use inherited
        </Button>
      )}
      <ShiftStartField />
      {!playing ? (
        <Button variant="primary" onClick={onPlay} disabled={finished}>
          ▶ Play
        </Button>
      ) : (
        <Button variant="primary" onClick={onPause}>
          ⏸ Pause
        </Button>
      )}
      <div className="speed-group">
        {[1, 2, 5, 10].map((s) => (
          <button
            key={s}
            className={`speed-btn ${speed === s ? 'active' : ''}`}
            onClick={() => onSpeedChange(s)}
          >
            {s}x
          </button>
        ))}
      </div>
      <Button variant="secondary" onClick={onReset}>
        ⟲ Reset
      </Button>
    </div>
  );
}
