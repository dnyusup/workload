import { useState } from 'react';
import { useAuth } from '../../context/auth';
import type { AppConfig, WaitingModel } from '../../types';
import { DEFAULT_WAITING_MODEL, type SingleOperatorForecast } from '../../lib/singleOperatorUtilization';
import { Button } from '../ui/Button';
import { Field, NumberInput } from '../ui/Field';
import { ForecastCalculationDialog } from './ForecastCalculationDialog';
import { WaitingModelInfoDialog } from './WaitingModelInfoDialog';

/** # Assigned Machines + its Forecast Man Occupation badge (with its fx calculation) + Optimize —
 * shown beside the Output Estimate heading, since that's what the machine count directly drives. */
export function AssignedMachinesControl({
  config,
  machHandled,
  forecast,
  onChange,
  onWaitingModelChange,
  onOptimize,
}: {
  config: AppConfig;
  machHandled: number;
  forecast: SingleOperatorForecast;
  onChange: (machHandled: number) => void;
  onWaitingModelChange: (model: WaitingModel) => void;
  onOptimize: () => void;
}) {
  const waitingModel = config.operator.waitingModel ?? DEFAULT_WAITING_MODEL;
  // Default Values can switch the waiting model off: then there's nothing to pick (forecast = None).
  const showWaitingModel = config.operator.useWaitingModel !== false;
  const canChangeWaitingModel = useAuth().user.role === 'admin';
  const [showCalculation, setShowCalculation] = useState(false);
  const [showModelInfo, setShowModelInfo] = useState(false);
  const highBacklogAtCapacity =
    forecast.forecastUtilizationPercent >= 100 && forecast.forecastWaitingMinutes > 5;

  return (
    <div className="assigned-machines-control">
      <Field label="# Assigned Machines">
        <NumberInput value={machHandled} min={0} onChange={onChange} />
      </Field>
      <div
        className={`setup-forecast-utilization ${
          highBacklogAtCapacity
            ? 'setup-forecast-utilization-above-target'
            : forecast.forecastUtilizationPercent >= 90
            ? 'setup-forecast-utilization-under-target'
            : forecast.forecastUtilizationPercent >= 80
              ? 'setup-forecast-utilization-blue'
              : 'setup-forecast-utilization-orange'
        }`}
        title={`Ideal demand ${forecast.utilizationPercent.toFixed(1)}%. Forecast includes ${forecast.forecastServiceMinutes.toFixed(1)} min handling and ${forecast.forecastWalkingMinutes.toFixed(1)} min walking. Machines wait ${forecast.machineWaitingMinutes.toFixed(1)} min for the operator (${forecast.interferencePercent.toFixed(1)}% of planned production).`}
      >
        <span>Forecast Man Occupation</span>
        <strong>{forecast.forecastUtilizationPercent.toFixed(1)}%</strong>
      </div>
      <Button
        type="button"
        variant="ghost"
        className="forecast-fx-button"
        onClick={() => setShowCalculation(true)}
        title="Show how the Forecast Man Occupation is calculated"
        aria-label="Show Forecast Man Occupation calculation"
      >
        <i>f</i>x
      </Button>
      {showWaitingModel && (
      <select
        className="input waiting-model-select"
        value={waitingModel}
        onChange={(e) => onWaitingModelChange(e.target.value as WaitingModel)}
        disabled={!canChangeWaitingModel}
        aria-label="Waiting model"
        title={`${canChangeWaitingModel ? '' : 'Only Admin can change the waiting model — follows Setting → Default Values. '}How the forecast estimates machines waiting for the operator: now ${forecast.interferencePercent.toFixed(1)}% of planned production.`}
      >
        <option value="none">None</option>
        <option value="wright">Wright</option>
        <option value="finiteSource">Finite source</option>
      </select>
      )}
      {showWaitingModel && (
      <Button
        type="button"
        variant="ghost"
        className="waiting-model-info-button"
        onClick={() => setShowModelInfo(true)}
        title="What each waiting model means, and its formula"
        aria-label="Waiting model information"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7.5v.01" />
        </svg>
      </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        className="optimize-utilization-button"
        onClick={onOptimize}
        title="Recalculate assigned machines: the most machines the operator can keep up with (Forecast Man Occupation up to 100%, no backlog), plus one more when that still leaves Man Occupation below Default Values' Optimize Step-Up Below"
        aria-label="Optimize man occupation"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 19h16M6 16V9m6 7V5m6 11v-4" />
          <path d="m4 6 4-2 4 2 4-3 4 2" />
        </svg>
        Optimize Man Occupation
      </Button>
      {showCalculation && <ForecastCalculationDialog config={config} forecast={forecast} onClose={() => setShowCalculation(false)} />}
      {showWaitingModel && showModelInfo && <WaitingModelInfoDialog selected={waitingModel} onClose={() => setShowModelInfo(false)} />}
    </div>
  );
}
