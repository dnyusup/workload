import { activityCycleLength, deriveMachineSpec } from '../../lib/calculations';
import type { ActivityConfig, AppConfig } from '../../types';
import type { SingleOperatorForecast } from '../../lib/singleOperatorUtilization';
import { Card } from '../ui/Card';

function fmt(value: number) {
  return Math.round(value * 10) / 10;
}

function fmtTime(minutes: number) {
  const totalMinutes = Math.max(0, Math.round(minutes));
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function percentage(value: number, denominator: number) {
  return denominator > 0 ? fmt((value / denominator) * 100) : 0;
}

function estimatedQuantity(activity: ActivityConfig, spools: number) {
  const cycle = activityCycleLength(activity);
  return Number.isFinite(cycle) && cycle > 0 ? spools / cycle : 0;
}

export function OutputEstimate({
  config,
  forecast,
}: {
  config: AppConfig;
  forecast: SingleOperatorForecast;
}) {
  const derived = deriveMachineSpec(config.spec);
  const runtimePerSpool = derived.runtimePerSpool;
  const plannedMachineMinutes = forecast.assignedMachineCount * Math.max(0, config.operator.shiftTime);
  const machineMinutesBeforeWaiting = forecast.expectedFinishedSpools * runtimePerSpool;
  const waitingMinutes = Math.min(plannedMachineMinutes, forecast.forecastWaitingMinutes);
  const producedMachineMinutes = Math.max(0, machineMinutesBeforeWaiting - waitingMinutes);
  const estimatedSpools = runtimePerSpool > 0 ? producedMachineMinutes / runtimePerSpool : 0;
  const tonage = (estimatedSpools * derived.spoolWeight) / 1000;
  const shiftHours = Math.max(0, config.operator.shiftTime) / 60;
  const totalDowntimeMinutes = Math.min(
    plannedMachineMinutes,
    forecast.activityContributions.reduce((total, contribution) => total + contribution.downtimeMinutes, 0) + waitingMinutes,
  );
  const availability = plannedMachineMinutes > 0
    ? Math.max(0, ((plannedMachineMinutes - totalDowntimeMinutes) / plannedMachineMinutes) * 100)
    : 100;
  const outputOee = plannedMachineMinutes > 0 ? (producedMachineMinutes / plannedMachineMinutes) * 100 : 0;
  const manHourPerTon = tonage > 0 ? shiftHours / tonage : 0;
  const machHoursPerTon = tonage > 0 ? (forecast.assignedMachineCount * shiftHours) / tonage : 0;
  const idleMinutes = Math.max(
    0,
    forecast.availableMinutes - forecast.forecastServiceMinutes - forecast.forecastWalkingMinutes,
  );

  const ratePerTon = (keys: string[]) => {
    const quantity = config.activities
      .filter((activity) => keys.includes(activity.key))
      .reduce((total, activity) => total + estimatedQuantity(activity, estimatedSpools), 0);
    return tonage > 0 ? quantity / tonage : 0;
  };

  const activityByKey = new Map(forecast.activityContributions.map((contribution) => [contribution.key, contribution]));
  const handlingContributions = forecast.activityContributions.filter((contribution) => contribution.handlingMinutes > 0);
  const downtimeContributions = forecast.activityContributions.filter((contribution) => contribution.downtimeMinutes > 0);

  return (
    <div className="output-estimate">
      <div className="output-estimate-heading">
        <h3>Output Estimate</h3>
        <p>Estimasi deterministik berdasarkan forecast operator utilization dan setup saat ini</p>
      </div>
      <div className="output-estimate-grid">
        <Card title="Output" className="output-estimate-card">
          <div className="metric-row">
            <span>#Spool</span>
            <strong>{fmt(estimatedSpools)}</strong>
          </div>
          <div className="metric-row">
            <span>Tonage</span>
            <strong>{fmt(tonage)} ton</strong>
          </div>
          <div className="metric-row">
            <span>OEE</span>
            <strong>{fmt(outputOee)}%</strong>
          </div>
          <div className="metric-row">
            <span>Manhour/ton</span>
            <strong>{fmt(manHourPerTon)}</strong>
          </div>
          <div className="metric-row">
            <span>Machhours/ton</span>
            <strong>{fmt(machHoursPerTon)}</strong>
          </div>
          <div className="metric-row" title="Estimasi total Fracture Repairing dibagi tonage">
            <span>Fracture/Ton (estimate)</span>
            <strong>{fmt(ratePerTon(['fractureRepairing']))}</strong>
          </div>
          <div className="metric-row" title="Estimasi total Dies Change dibagi tonage">
            <span>Dies/Ton (estimate)</span>
            <strong>{fmt(ratePerTon(['diesChange']))}</strong>
          </div>
          <div className="metric-row" title="Estimasi total Defect Repairing dibagi tonage">
            <span>Defect/Ton (estimate)</span>
            <strong>{fmt(ratePerTon(['defectRepairing']))}</strong>
          </div>
        </Card>

        <Card title="Operator Utilization" className="output-estimate-card">
          <div className="util-bar">
            <div
              className="util-segment util-walk"
              style={{ width: `${Math.min(100, percentage(forecast.forecastWalkingMinutes, forecast.availableMinutes))}%` }}
            />
            <div
              className="util-segment util-service"
              style={{ width: `${Math.min(100, percentage(forecast.forecastServiceMinutes, forecast.availableMinutes))}%` }}
            />
          </div>
          <div className="metric-row">
            <span>Utilization</span>
            <strong>{fmt(forecast.forecastUtilizationPercent)}%</strong>
          </div>
          <div className="metric-row small">
            <span>Walking</span>
            <span>
              {fmtTime(forecast.forecastWalkingMinutes)} ({percentage(forecast.forecastWalkingMinutes, forecast.availableMinutes)}%)
            </span>
          </div>
          <div className="metric-row small">
            <span>Total handle</span>
            <span>
              {fmtTime(forecast.forecastServiceMinutes)} ({percentage(forecast.forecastServiceMinutes, forecast.availableMinutes)}%)
            </span>
          </div>
          {handlingContributions.map((contribution) => (
            <div className="metric-row small" key={`estimate-handling-${contribution.key}`}>
              <span>Handle: {contribution.label}</span>
              <span>
                {fmtTime(contribution.handlingMinutes)} ({percentage(contribution.handlingMinutes, forecast.availableMinutes)}%)
              </span>
            </div>
          ))}
          <div className="metric-row small">
            <span>Idle</span>
            <span>{fmtTime(idleMinutes)} ({percentage(idleMinutes, forecast.availableMinutes)}%)</span>
          </div>
        </Card>

        <Card title="OEE &amp; Downtime" className="output-estimate-card">
          <div className="metric-row">
            <span>OEE Availability</span>
            <strong>{fmt(availability)}%</strong>
          </div>
          <div className="metric-row small">
            <span>Planned production minutes</span>
            <span>{fmt(plannedMachineMinutes)} min</span>
          </div>
          <div className="metric-row small">
            <span>Total downtime minutes</span>
            <span>{fmt(totalDowntimeMinutes)} min</span>
          </div>
          <div className="metric-row small">
            <span>Waiting for Operator</span>
            <span>{fmt(waitingMinutes)} min ({percentage(waitingMinutes, plannedMachineMinutes)}%)</span>
          </div>
          {downtimeContributions.map((contribution) => (
            <div className="metric-row small" key={`estimate-downtime-${contribution.key}`}>
              <span>{contribution.label}</span>
              <span>
                {fmt(activityByKey.get(contribution.key)?.downtimeMinutes ?? 0)} min (
                {percentage(contribution.downtimeMinutes, plannedMachineMinutes)}%)
              </span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
