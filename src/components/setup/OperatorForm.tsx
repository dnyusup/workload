import type { OperatorConfig, TaskPriorityMode } from '../../types';
import { availableTimeMinutes } from '../../lib/calculations';
import type { SingleOperatorForecast } from '../../lib/singleOperatorUtilization';
import { Card } from '../ui/Card';
import { Field, NumberInput, SelectInput } from '../ui/Field';

const TASK_PRIORITY_OPTIONS: { value: TaskPriorityMode; label: string }[] = [
  { value: 'nearest', label: 'Nearest Task' },
  { value: 'quickest', label: 'Quickest Task' },
];

export function OperatorForm({
  operator,
  forecast,
  onChange,
}: {
  operator: OperatorConfig;
  forecast: SingleOperatorForecast;
  onChange: (next: OperatorConfig) => void;
}) {
  const set = <K extends keyof OperatorConfig>(key: K) => (v: OperatorConfig[K]) => onChange({ ...operator, [key]: v });
  const available = availableTimeMinutes(operator.shiftTime, operator.lunchTime, operator.meetingTime);

  return (
    <Card title="Operator Activities" subtitle="Work capacity and number of assigned machines">
      <div className="grid-2">
        <Field
          label="Task Priority"
          hint="Nearest Task: always go to the closest machine in queue. Quickest Task: go to whichever queued task (walk + service time) finishes soonest."
        >
          <SelectInput value={operator.taskPriority} options={TASK_PRIORITY_OPTIONS} onChange={set('taskPriority')} />
        </Field>
        <Field label="# Assigned Machines">
          <NumberInput value={operator.machHandled} min={0} onChange={set('machHandled')} />
          <div
            className={`setup-forecast-utilization ${
              forecast.forecastUtilizationPercent >= 100
                ? 'setup-forecast-utilization-overload'
                : forecast.forecastUtilizationPercent >= 85
                  ? 'setup-forecast-utilization-above-target'
                  : 'setup-forecast-utilization-under-target'
            }`}
            title={`Ideal demand ${forecast.utilizationPercent.toFixed(1)}%. Forecast includes ${forecast.forecastServiceMinutes.toFixed(1)} min handling and ${forecast.forecastWalkingMinutes.toFixed(1)} min walking. ${forecast.forecastWaitingMinutes.toFixed(1)} min expected backlog.`}
          >
            <span>Forecast utilization</span>
            <strong>{forecast.forecastUtilizationPercent.toFixed(1)}%</strong>
          </div>
        </Field>
        <Field label="Shift Time (min)">
          <NumberInput value={operator.shiftTime} onChange={set('shiftTime')} />
        </Field>
        <Field label="Lunch Time (min)">
          <NumberInput value={operator.lunchTime} onChange={set('lunchTime')} />
        </Field>
        <Field label="Lunch starts at minute" hint="Lunch break position within the shift">
          <NumberInput value={operator.lunchStartAt} min={0} onChange={set('lunchStartAt')} />
        </Field>
        <Field label="Meeting Time (min)">
          <NumberInput value={operator.meetingTime} onChange={set('meetingTime')} />
        </Field>
        <Field label="Meeting starts at minute" hint="Meeting break position within the shift">
          <NumberInput value={operator.meetingStartAt} min={0} onChange={set('meetingStartAt')} />
        </Field>
      </div>
      <div className="divider" />
      <Field
        label="Available Time (min)"
        hint="= ShiftTime - LunchTime - MeetingTime. The simulation runs for the full ShiftTime, with lunch and meeting inserted at the configured minutes."
      >
        <NumberInput value={available} readOnly />
      </Field>
    </Card>
  );
}
