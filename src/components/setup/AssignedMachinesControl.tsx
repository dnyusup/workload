import type { SingleOperatorForecast } from '../../lib/singleOperatorUtilization';
import { Button } from '../ui/Button';
import { Field, NumberInput } from '../ui/Field';

/** # Assigned Machines + its Forecast Man Occupation badge + Optimize — shown beside the Output
 * Estimate heading, since that's what the machine count directly drives. */
export function AssignedMachinesControl({
  machHandled,
  forecast,
  onChange,
  onOptimize,
}: {
  machHandled: number;
  forecast: SingleOperatorForecast;
  onChange: (machHandled: number) => void;
  onOptimize: () => void;
}) {
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
        title={`Ideal demand ${forecast.utilizationPercent.toFixed(1)}%. Forecast includes ${forecast.forecastServiceMinutes.toFixed(1)} min handling and ${forecast.forecastWalkingMinutes.toFixed(1)} min walking. ${forecast.forecastWaitingMinutes.toFixed(1)} min expected backlog.`}
      >
        <span>Forecast Man Occupation</span>
        <strong>{forecast.forecastUtilizationPercent.toFixed(1)}%</strong>
      </div>
      <Button
        type="button"
        variant="ghost"
        className="optimize-utilization-button"
        onClick={onOptimize}
        title="Recalculate assigned machines for zero forecast backlog"
        aria-label="Optimize man occupation"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 19h16M6 16V9m6 7V5m6 11v-4" />
          <path d="m4 6 4-2 4 2 4-3 4 2" />
        </svg>
        Optimize Man Occupation
      </Button>
    </div>
  );
}
