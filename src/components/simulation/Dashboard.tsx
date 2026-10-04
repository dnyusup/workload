import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppConfig, DowntimeReason, SimulationState } from '../../types';
import { deriveMachineSpec } from '../../lib/calculations';
import { calculateSingleOperatorForecast, forecastOutputSummary } from '../../lib/singleOperatorUtilization';
import { Card } from '../ui/Card';
import { useFillToWindowBottom } from '../../hooks/useFillToWindowBottom';

function fmt(v: number) {
  return Math.round(v * 10) / 10;
}

function fmtTime(min: number) {
  const totalMinutes = Math.round(min);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m}m`;
}

/** The setup's forecast for the same line, shown after the actual value for comparison. */
function Est({ children }: { children: ReactNode }) {
  return <span className="metric-est" title="Forecast for the full shift (Output Estimate)"> / ~{children}</span>;
}

const FORECAST_NOTE = '/ ~ = forecast for the full shift';

function runningMinutesFromTimeline(machines: SimulationState['machines']) {
  return machines.reduce(
    (total, machine) =>
      total +
      machine.timeline.reduce((machineTotal, segment) => {
        const isRunning = segment.kind === 'running' || segment.kind.startsWith('running:');
        return isRunning ? machineTotal + Math.max(0, segment.endMin - segment.startMin) : machineTotal;
      }, 0),
    0,
  );
}

const defaultDowntimeLabels: Record<string, string> = {
  doffing: 'Doffing',
  loading: 'Loading',
  fractureRepairing: 'Fracture Repairing',
  waiting: 'Waiting for Operator',
};

const downtimeColors: Record<string, string> = {
  doffing: '#38bdf8',
  loading: '#a78bfa',
  fractureRepairing: '#f87171',
  waiting: '#fbbf24',
};

function colorForDowntime(key: string, index: number) {
  const palette = ['#38bdf8', '#a78bfa', '#f87171', '#c084fc', '#2dd4bf', '#fb923c', '#facc15'];
  return downtimeColors[key] ?? palette[index % palette.length];
}

const MIN_DASHBOARD_WIDTH = 280;
const MAX_DASHBOARD_WIDTH_RATIO = 0.6;

export function Dashboard({
  state,
  config,
  onWidthChange,
}: {
  state: SimulationState;
  config: AppConfig;
  /** Dragging the panel's left edge reports the new width (px) for the layout to apply. */
  onWidthChange?: (width: number) => void;
}) {
  // Reaches the bottom of the window even when the canvas column is shorter (e.g. zoomed out).
  const { ref: dashboardOuterRef, minHeight: dashboardMinHeight } = useFillToWindowBottom<HTMLDivElement>();
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Starts from whatever width the panel has now (the CSS default until it's first dragged).
    resizeRef.current = { startX: e.clientX, startWidth: dashboardOuterRef.current?.getBoundingClientRect().width ?? 360 };
    setResizing(true);
  };
  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || !onWidthChange) return;
    // Dragging the left edge leftwards widens the panel.
    const maxWidth = Math.max(MIN_DASHBOARD_WIDTH, window.innerWidth * MAX_DASHBOARD_WIDTH_RATIO);
    onWidthChange(Math.min(maxWidth, Math.max(MIN_DASHBOARD_WIDTH, drag.startWidth - (e.clientX - drag.startX))));
  };
  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    resizeRef.current = null;
    setResizing(false);
  };
  const { metrics, machines, log } = state;
  const forecast = useMemo(() => calculateSingleOperatorForecast(config), [config]);
  const fc = useMemo(() => forecastOutputSummary(config, forecast), [config, forecast]);
  const forecastHandling = new Map(forecast.activityContributions.map((c) => [c.key, c.handlingMinutes]));
  /** Forecast share of the operator's net available time, like the actual rows' (%). */
  const forecastPct = (minutes: number) => (forecast.availableMinutes > 0 ? (minutes / forecast.availableMinutes) * 100 : 0);
  /** Forecast occurrences per activity, at the forecast's OEE (same events as the fx calculation). */
  const firstDoffKeys = new Set(config.activities.filter((a) => a.frequencyType === 'FirstDoffOnShift').map((a) => a.key));
  const forecastEvents = new Map(
    forecast.breakdown.activities.map((step) => [
      step.key,
      // Once per machine per shift, however long the machine runs.
      firstDoffKeys.has(step.key) ? step.events : step.events * forecast.breakdown.scale,
    ]),
  );
  const forecastSpoolsPerMachine = forecast.breakdown.expectedSpoolsPerMachine * forecast.breakdown.scale;
  const forecastDowntime = new Map<string, number>([
    ...fc.downtime.activityDowntime.map((row) => [row.key, row.minutes] as [string, number]),
    ['waiting', fc.downtime.waitingMinutes],
  ]);
  const busyMin = metrics.walkingMin + metrics.servicingMin;
  const workedElapsed = Math.max(0, metrics.clockMin - metrics.breakElapsedMin);
  const utilization = workedElapsed > 0 ? (busyMin / workedElapsed) * 100 : 0;
  const utilizationPct = (minutes: number) => (workedElapsed > 0 ? (minutes / workedElapsed) * 100 : 0);
  const avgWait = metrics.totalWaitCount > 0 ? metrics.totalWaitMin / metrics.totalWaitCount : 0;
  const queue = machines.filter((m) => m.status === 'needs-service');

  const plannedProductionMin = metrics.assignedMachineCount * metrics.clockMin;
  const totalDowntimeMin = Object.values(metrics.downtimeByReason).reduce((a, b) => a + b, 0);
  const availability = plannedProductionMin > 0 ? ((plannedProductionMin - totalDowntimeMin) / plannedProductionMin) * 100 : 100;
  const oee = Math.max(0, Math.min(100, availability));

  // Output: what was actually produced this shift, and how efficiently the scheduled machine-time
  // converted into finished spools (excludes any machine time still mid-spool, not yet a full unit).
  // A spool only really counts as "output" once it's been doffed (collected off the machine) — using
  // completedByActivity.doffing instead of raw production count also keeps this in sync with the
  // Doffing count shown under Completed Activities, including the initial-backlog Doffing tasks
  // some machines start the shift with (leftover from before the shift, serviced during it).
  const totalSpools = metrics.completedByActivity.doffing ?? 0;
  const spoolWeightKg = deriveMachineSpec(config.spec).spoolWeight;
  const tonage = (totalSpools * spoolWeightKg) / 1000;
  const shiftHours = metrics.shiftTimeMin / 60;
  const manHourPerTon = tonage > 0 ? shiftHours / tonage : 0;
  const scheduledMachineMin = metrics.assignedMachineCount * metrics.shiftTimeMin;
  const producedMachineMin = totalSpools * metrics.runtimePerSpoolMin;
  const outputOee = scheduledMachineMin > 0 ? (producedMachineMin / scheduledMachineMin) * 100 : 0;
  const scheduledMachineHours = metrics.assignedMachineCount * shiftHours;
  const machHoursPerTon = tonage > 0 ? scheduledMachineHours / tonage : 0;
  const totalRunningMachineMin = runningMinutesFromTimeline(machines);
  const runningTimeSpools = metrics.runtimePerSpoolMin > 0
    ? totalRunningMachineMin / metrics.runtimePerSpoolMin
    : 0;
  const runningTimeTonage = (runningTimeSpools * spoolWeightKg) / 1000;
  const runningTimeOee = scheduledMachineMin > 0 ? (totalRunningMachineMin / scheduledMachineMin) * 100 : 0;
  const runningTimeManHourPerTon = runningTimeTonage > 0 ? shiftHours / runningTimeTonage : 0;
  const runningTimeMachHoursPerTon = runningTimeTonage > 0 ? scheduledMachineHours / runningTimeTonage : 0;
  const totalFractureCount = Object.entries(metrics.completedByActivity)
    .filter(([key]) => key === 'fractureRepairing' || key.startsWith('fractureRepairing-'))
    .reduce((sum, [, count]) => sum + count, 0);
  const actualFracturePerTon = tonage > 0 ? totalFractureCount / tonage : 0;
  const actualDiesPerTon = tonage > 0 ? metrics.diesChanged / tonage : 0;
  const totalDefectRepairingCount = Object.entries(metrics.completedByActivity)
    .filter(([key]) => key === 'defectRepairing' || key.startsWith('defectRepairing-'))
    .reduce((sum, [, count]) => sum + count, 0);
  const actualDefectPerTon = tonage > 0 ? totalDefectRepairingCount / tonage : 0;
  const runningTimeFracturePerTon = runningTimeTonage > 0 ? totalFractureCount / runningTimeTonage : 0;
  const runningTimeDiesPerTon = runningTimeTonage > 0 ? metrics.diesChanged / runningTimeTonage : 0;
  const runningTimeDefectPerTon = runningTimeTonage > 0 ? totalDefectRepairingCount / runningTimeTonage : 0;

  const rpcMin = Object.entries(metrics.servicingByActivity)
    .filter(([key]) => key.startsWith('rpc:'))
    .reduce((total, [, minutes]) => total + Math.max(0, minutes), 0);

  const downtimeEntries = (Object.keys(metrics.downtimeByReason) as DowntimeReason[])
    .map((key, index) => ({
      key,
      label: config.activities.find((activity) => activity.key === key)?.label ?? defaultDowntimeLabels[key] ?? key,
      value: metrics.downtimeByReason[key],
      color: colorForDowntime(key, index),
    }))
    .sort((a, b) => b.value - a.value);
  const maxDowntime = downtimeEntries[0]?.value ?? 0;

  return (
    <div className="dashboard-scroll-outer" ref={dashboardOuterRef} style={dashboardMinHeight ? { minHeight: dashboardMinHeight } : undefined}>
    {onWidthChange && (
      <div
        className={`dashboard-resize-handle${resizing ? ' active' : ''}`}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        title="Drag to resize the panel"
        aria-hidden="true"
      />
    )}
    <div className="dashboard">
      <Card
        title="Output (Running Time)"
        subtitle={`Estimated from total machine running time; spool quantity can be decimal · ${FORECAST_NOTE}`}
      >
        <div className="metric-row">
          <span>#Spool (running time)</span>
          <strong>
            {fmt(runningTimeSpools)}
            <Est>{fmt(fc.spools)}</Est>
          </strong>
        </div>
        <div className="metric-row">
          <span>Total running time</span>
          <strong>
            {fmt(totalRunningMachineMin)} min
            <Est>{fmt(fc.downtime.producedMachineMinutes)} min</Est>
          </strong>
        </div>
        <div className="metric-row">
          <span>Tonage</span>
          <strong>
            {fmt(runningTimeTonage)} ton
            <Est>{fmt(fc.tonage)} ton</Est>
          </strong>
        </div>
        <div className="metric-row">
          <span>OEE (running time)</span>
          <strong>
            {fmt(runningTimeOee)}%
            <Est>{fmt(fc.outputOeePercent)}%</Est>
          </strong>
        </div>
        <div className="metric-row">
          <span>Manhour/ton</span>
          <strong>
            {fmt(runningTimeManHourPerTon)}
            <Est>{fmt(fc.manHourPerTon)}</Est>
          </strong>
        </div>
        <div className="metric-row">
          <span>Machhours/ton</span>
          <strong>
            {fmt(runningTimeMachHoursPerTon)}
            <Est>{fmt(fc.machHoursPerTon)}</Est>
          </strong>
        </div>
        <div className="metric-row" title="Total Fracture Repairing dibagi tonage dari running time">
          <span>Fracture/Ton (running time)</span>
          <strong>
            {fmt(runningTimeFracturePerTon)}
            <Est>{fmt(fc.fracturePerTon)}</Est>
          </strong>
        </div>
        <div className="metric-row" title="Total Dies Change events dibagi tonage dari running time">
          <span>Dies/Ton (running time)</span>
          <strong>
            {fmt(runningTimeDiesPerTon)}
            <Est>{fmt(fc.diesPerTon)}</Est>
          </strong>
        </div>
        <div className="metric-row" title="Total Defect Repairing dibagi tonage dari running time">
          <span>Defect/Ton (running time)</span>
          <strong>
            {fmt(runningTimeDefectPerTon)}
            <Est>{fmt(fc.defectPerTon)}</Est>
          </strong>
        </div>
      </Card>

      <Card title="Output" subtitle={`Actual finished spools this shift — OEE here excludes machine time still mid-spool · ${FORECAST_NOTE}`}>
        <div className="metric-row">
          <span>#Spool</span>
          <strong>
            {totalSpools}
            <Est>{fmt(fc.spools)}</Est>
          </strong>
        </div>
        <div className="metric-row">
          <span>Tonage</span>
          <strong>
            {fmt(tonage)} ton
            <Est>{fmt(fc.tonage)} ton</Est>
          </strong>
        </div>
        <div className="metric-row">
          <span>OEE (finished spool)</span>
          <strong>
            {fmt(outputOee)}%
            <Est>{fmt(fc.outputOeePercent)}%</Est>
          </strong>
        </div>
        <div className="metric-row">
          <span>Manhour/ton</span>
          <strong>
            {fmt(manHourPerTon)}
            <Est>{fmt(fc.manHourPerTon)}</Est>
          </strong>
        </div>
        <div className="metric-row">
          <span>Machhours/ton</span>
          <strong>
            {fmt(machHoursPerTon)}
            <Est>{fmt(fc.machHoursPerTon)}</Est>
          </strong>
        </div>
        <div className="metric-row" title="Total Fracture Repairing ÷ Tonage">
          <span>Fracture/Ton (actual)</span>
          <strong>
            {fmt(actualFracturePerTon)}
            <Est>{fmt(fc.fracturePerTon)}</Est>
          </strong>
        </div>
        <div className="metric-row" title="Total Dies Change events ÷ Tonage">
          <span>Dies/Ton (actual)</span>
          <strong>
            {fmt(actualDiesPerTon)}
            <Est>{fmt(fc.diesPerTon)}</Est>
          </strong>
        </div>
        <div className="metric-row" title="Total Defect Repairing events ÷ Tonage">
          <span>Defect/Ton (actual)</span>
          <strong>
            {fmt(actualDefectPerTon)}
            <Est>{fmt(fc.defectPerTon)}</Est>
          </strong>
        </div>
      </Card>

      <Card title="Man Occupation" subtitle={`Calculated against net working time (excluding lunch/meeting) · ${FORECAST_NOTE}`}>
        <div className="util-bar">
          <div className="util-segment util-walk" style={{ width: `${(metrics.walkingMin / (workedElapsed || 1)) * 100}%` }} />
          <div className="util-segment util-service" style={{ width: `${(metrics.servicingMin / (workedElapsed || 1)) * 100}%` }} />
        </div>
        <div className="metric-row">
          <span>Man Occupation</span>
          <strong>
            {fmt(utilization)}%
            <Est>{fmt(forecast.forecastUtilizationPercent)}%</Est>
          </strong>
        </div>
        <div className="metric-row small">
          <span>Walking</span>
          <span>
            {fmtTime(metrics.walkingMin)} ({fmt(utilizationPct(metrics.walkingMin))}%)
            <Est>
              {fmtTime(forecast.forecastWalkingMinutes)} ({fmt(forecastPct(forecast.forecastWalkingMinutes))}%)
            </Est>
          </span>
        </div>
        <div className="metric-row small">
          <span>Total handle</span>
          <span>
            {fmtTime(metrics.servicingMin)} ({fmt(utilizationPct(metrics.servicingMin))}%)
            <Est>
              {fmtTime(forecast.forecastServiceMinutes)} ({fmt(forecastPct(forecast.forecastServiceMinutes))}%)
            </Est>
          </span>
        </div>
        {config.activities.map((activity) => (
          <div className="metric-row small" key={`service-${activity.key}`}>
            <span>Handle: {activity.label}</span>
            <span>
              {fmtTime(metrics.servicingByActivity[activity.key] ?? 0)} (
              {fmt(utilizationPct(metrics.servicingByActivity[activity.key] ?? 0))}%)
              <Est>
                {fmtTime(forecastHandling.get(activity.key) ?? 0)} ({fmt(forecastPct(forecastHandling.get(activity.key) ?? 0))}%)
              </Est>
            </span>
          </div>
        ))}
        {(metrics.servicingByActivity.service ?? 0) > 1e-9 && (
          <div className="metric-row small">
            <span>Unclassified handle</span>
            <span>
              {fmtTime(metrics.servicingByActivity.service)} ({fmt(utilizationPct(metrics.servicingByActivity.service))}%)
            </span>
          </div>
        )}
        {rpcMin > 1e-9 && (
          <div className="metric-row small">
            <span>Others (RPC)</span>
            <span>
              {fmtTime(rpcMin)} ({fmt(utilizationPct(rpcMin))}%)
              <Est>
                {fmtTime(forecastHandling.get('rpc') ?? 0)} ({fmt(forecastPct(forecastHandling.get('rpc') ?? 0))}%)
              </Est>
            </span>
          </div>
        )}
        <div className="metric-row small">
          <span>Idle</span>
          <span>
            {fmtTime(metrics.idleMin)} ({fmt(utilizationPct(metrics.idleMin))}%)
            <Est>
              {fmtTime(fc.idleMinutes)} ({fmt(forecastPct(fc.idleMinutes))}%)
            </Est>
          </span>
        </div>
      </Card>

      <Card
        title="OEE & Downtime"
        className="dashboard-oee-card"
        subtitle={`Availability across assigned machines (Performance & Quality assumed at 100%) · ${FORECAST_NOTE}`}
      >
        <div className="oee-gauge-row">
          <div className="oee-gauge">
            <span className="oee-value">{fmt(oee)}%</span>
            <span className="oee-caption">OEE (Availability)</span>
            <span className="oee-forecast" title="Forecast for the full shift (Output Estimate)">~{fmt(fc.downtime.availabilityPercent)}% forecast</span>
          </div>
          <div className="metric-col">
            <div className="metric-row small">
              <span>Planned production</span>
              <span>
                {fmt(plannedProductionMin)} machine-minutes
                <Est>{fmt(fc.downtime.plannedMachineMinutes)}</Est>
              </span>
            </div>
            <div className="metric-row small">
              <span>Total downtime</span>
              <span>
                {fmt(totalDowntimeMin)} machine-minutes
                <Est>{fmt(fc.downtime.totalDowntimeMinutes)}</Est>
              </span>
            </div>
          </div>
        </div>
        <div className="downtime-bars">
          {downtimeEntries.map((d) => {
            const pct = plannedProductionMin > 0 ? (d.value / plannedProductionMin) * 100 : 0;
            const barPct = maxDowntime > 0 ? (d.value / maxDowntime) * 100 : 0;
            return (
              <div key={d.key} className="downtime-row">
                <span className="downtime-label">{d.label}</span>
                <div className="downtime-bar-track">
                  <div className="downtime-bar-fill" style={{ width: `${barPct}%`, background: d.color }} />
                </div>
                <span className="downtime-value">
                  {fmt(d.value)}m ({fmt(pct)}%)
                  <Est>
                    {fmt(forecastDowntime.get(d.key) ?? 0)}m (
                    {fmt(fc.downtime.plannedMachineMinutes > 0 ? ((forecastDowntime.get(d.key) ?? 0) / fc.downtime.plannedMachineMinutes) * 100 : 0)}%)
                  </Est>
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title="Completed Activities"
        subtitle={`vs forecast (~${fmt(forecastSpoolsPerMachine)} spools/machine per shift at ${fmt(forecast.breakdown.scale * 100)}% OEE)`}
      >
        {config.activities.map((activity) => (
          <div className="metric-row" key={activity.key}>
            <span>{activity.label}</span>
            <strong>
              {metrics.completedByActivity[activity.key] ?? 0}
              <Est>{fmt(forecastEvents.get(activity.key) ?? metrics.expectedEventsByActivity[activity.key] ?? 0)}</Est>
            </strong>
          </div>
        ))}
        <div className="metric-row">
          <span>Average wait time</span>
          <strong>{fmt(avgWait)} min</strong>
        </div>
      </Card>

      <Card title={`Queue (${queue.length})`}>
        {queue.length === 0 && <p className="empty-hint">No machines waiting.</p>}
        <ul className="queue-list">
          {queue.map((m) => (
            <li key={m.id}>
              <span>Machine {m.label}</span>
              <span className="queue-tasks">{m.pendingTasks.map((t) => t.label).join(', ')}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Activity Log">
        <div className="event-log">
          {[...log].reverse().slice(0, 30).map((e) => (
            <div key={e.id} className="log-row">
              <span className="log-time">{fmtTime(e.timeMin)}</span>
              <span>{e.message}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
    </div>
  );
}
