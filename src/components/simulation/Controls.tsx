import type { ReactNode } from 'react';
import type { AppConfig } from '../../types';
import { deriveMachineSpec, fractureRepairingDenominator } from '../../lib/calculations';
import { Button } from '../ui/Button';
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
  onCopyOutput,
  copyingOutput,
  copiedOutput,
  inheritedConditionOptions,
  selectedInheritedConditionId,
  onInheritedConditionChange,
  onUseInheritedCondition,
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
  onCopyOutput: () => void;
  copyingOutput: boolean;
  copiedOutput: boolean;
  inheritedConditionOptions: Array<{ id: string; label: string }>;
  selectedInheritedConditionId: string;
  onInheritedConditionChange: (id: string) => void;
  onUseInheritedCondition: () => void;
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
          <span>#Mach Assigned</span>
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
          <span>Fracture/Ton</span>
          <input
            className={`input input-sm ${liveSettingsDisabled ? 'input-readonly' : ''}`}
            type="number"
            min={0}
            step="any"
            value={config.spec.fracturePerTon}
            readOnly={liveSettingsDisabled}
            onChange={(e) => handleFracturePerTonChange(parseFloat(e.target.value))}
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
      {finished && canCopyOutput && (
        <Button variant="secondary" onClick={onCopyOutput} disabled={copyingOutput}>
          {copyingOutput ? 'Copying…' : copiedOutput ? '✓ Copied' : '📋 Copy'}
        </Button>
      )}
      {!playing && !finished && inheritedConditionOptions.length > 0 && (
        <div className="inherited-condition-control">
          {inheritedConditionOptions.length > 1 && (
            <select
              className="input input-sm inherited-condition-select"
              value={selectedInheritedConditionId}
              onChange={(event) => onInheritedConditionChange(event.target.value)}
              aria-label="Select inherited machine condition version"
            >
              {inheritedConditionOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          <Button variant="secondary" onClick={onUseInheritedCondition}>
            ↺ Use inherited
          </Button>
        </div>
      )}
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
