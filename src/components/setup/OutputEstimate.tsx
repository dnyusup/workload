import type { ReactNode } from 'react';
import type { AppConfig } from '../../types';
import { forecastOutputSummary, type SingleOperatorForecast } from '../../lib/singleOperatorUtilization';
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

export function OutputEstimate({
  config,
  forecast,
  headerControls,
}: {
  config: AppConfig;
  forecast: SingleOperatorForecast;
  /** Rendered to the right of the "Output Estimate" heading. */
  headerControls?: ReactNode;
}) {
  const summary = forecastOutputSummary(config, forecast);
  const {
    plannedMachineMinutes,
    waitingMinutes,
    totalDowntimeMinutes,
    availabilityPercent: availability,
  } = summary.downtime;
  const estimatedSpools = summary.spools;
  const tonage = summary.tonage;
  const outputOee = summary.outputOeePercent;
  const manHourPerTon = summary.manHourPerTon;
  const machHoursPerTon = summary.machHoursPerTon;
  const idleMinutes = summary.idleMinutes;

  const activityByKey = new Map(forecast.activityContributions.map((contribution) => [contribution.key, contribution]));
  const handlingContributions = forecast.activityContributions.filter(
    (contribution) => contribution.key !== 'rpc' && contribution.handlingMinutes > 0,
  );
  const downtimeContributions = forecast.activityContributions.filter((contribution) => contribution.downtimeMinutes > 0);
  // Shown separately, right above Idle, same position as the actual simulation's Man Occupation card.
  const rpcContribution = activityByKey.get('rpc');

  return (
    <div className="output-estimate">
      <div className="output-estimate-heading">
        <div>
          <h3>Output Estimate</h3>
          <p>Estimasi deterministik berdasarkan Forecast Man Occupation dan setup saat ini</p>
        </div>
        {headerControls}
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
            <strong>{fmt(summary.fracturePerTon)}</strong>
          </div>
          <div className="metric-row" title="Estimasi total Dies Change dibagi tonage">
            <span>Dies/Ton (estimate)</span>
            <strong>{fmt(summary.diesPerTon)}</strong>
          </div>
          <div className="metric-row" title="Estimasi total Defect Repairing dibagi tonage">
            <span>Defect/Ton (estimate)</span>
            <strong>{fmt(summary.defectPerTon)}</strong>
          </div>
        </Card>

        <Card title="Man Occupation" className="output-estimate-card">
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
            <span>Man Occupation</span>
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
          {rpcContribution && rpcContribution.handlingMinutes > 0 && (
            <div className="metric-row small">
              <span>{rpcContribution.label}</span>
              <span>
                {fmtTime(rpcContribution.handlingMinutes)} ({percentage(rpcContribution.handlingMinutes, forecast.availableMinutes)}%)
              </span>
            </div>
          )}
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
