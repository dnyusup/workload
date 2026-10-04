import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AppConfig } from '../../types';
import { calculateForecastDowntime, machineInterference, type SingleOperatorForecast } from '../../lib/singleOperatorUtilization';

const n = (value: number, digits = 2) =>
  Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
const min = (value: number) => `${n(value, 1)} min`;
const pct = (value: number) => `${n(value, 1)}%`;

/** A labelled value with the formula that produced it underneath. */
function Step({ label, value, formula, strong }: { label: string; value: ReactNode; formula?: ReactNode; strong?: boolean }) {
  return (
    <div className={`fx-step${strong ? ' is-strong' : ''}`}>
      <div className="fx-step-line">
        <span>{label}</span>
        <span className="fx-step-value">{value}</span>
      </div>
      {formula && <div className="fx-formula">{formula}</div>}
    </div>
  );
}

/** Step-by-step calculation behind the Workload Simulator setup's Forecast Man Occupation: the
 * operator's available time, every activity's demand, walking, and what it means for the
 * machines (Stop downtime and waiting for the operator). */
export function ForecastCalculationDialog({
  config,
  forecast,
  onClose,
}: {
  config: AppConfig;
  forecast: SingleOperatorForecast;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const b = forecast.breakdown;
  const interference = forecast.interference;
  const downtime = calculateForecastDowntime(config, forecast);
  const busy = forecast.forecastServiceMinutes + forecast.forecastWalkingMinutes;
  const idle = Math.max(0, forecast.availableMinutes - busy);
  const machines = forecast.assignedMachineCount;
  const rpcMinutes = forecast.activityContributions.find((c) => c.key === 'rpc')?.handlingMinutes ?? 0;
  const totalEvents = b.activities.reduce((total, step) => total + step.events, 0);
  // Both models from the same inputs, so the one not chosen can be compared.
  const wright = machineInterference('wright', forecast.assignedMachineCount, interference.runningMinutesPerMachine, busy);
  const finite = machineInterference('finiteSource', forecast.assignedMachineCount, interference.runningMinutesPerMachine, busy);
  const rawForecast = forecast.availableMinutes > 0 ? (busy / forecast.availableMinutes) * 100 : 0;
  const shareOfPlanned = (minutes: number) =>
    downtime.plannedMachineMinutes > 0 ? (Math.min(minutes, downtime.plannedMachineMinutes) / downtime.plannedMachineMinutes) * 100 : 0;

  return createPortal(
    <div className="modal-overlay om-detail-overlay" onClick={onClose}>
      <div
        className="om-detail fx-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Forecast Man Occupation calculation"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="om-detail-header">
          <div>
            <span className="om-detail-eyebrow">fx · Forecast Man Occupation</span>
            <h3>How the forecast is calculated</h3>
            <p>One operator handling {machines} machine(s) for one shift — deterministic, from the setup as it is now.</p>
          </div>
          <button type="button" className="om-detail-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ×
          </button>
        </header>

        <div className="om-detail-kpis">
          <div className="om-detail-kpi">
            <span>Forecast Man Occupation</span>
            <strong>{pct(forecast.forecastUtilizationPercent)}</strong>
          </div>
          <div className="om-detail-kpi">
            <span>Ideal demand</span>
            <strong>{pct(forecast.utilizationPercent)}</strong>
          </div>
          <div className="om-detail-kpi">
            <span>Handling + Walking</span>
            <strong>{min(busy)}</strong>
          </div>
          <div className="om-detail-kpi">
            <span>Available</span>
            <strong>{min(forecast.availableMinutes)}</strong>
          </div>
          <div className="om-detail-kpi">
            <span>Interference (machines wait)</span>
            <strong>{pct(forecast.interferencePercent)}</strong>
          </div>
          <div className="om-detail-kpi">
            <span>OEE Availability</span>
            <strong>{pct(downtime.availabilityPercent)}</strong>
          </div>
        </div>

        <div className="om-detail-sections">
          <section className="om-detail-section">
            <h4>1 · Operator available time</h4>
            <Step
              label="Available time"
              value={min(forecast.availableMinutes)}
              formula={`Shift ${n(b.shiftMinutes)} − Lunch ${n(b.lunchMinutes)} − Meeting ${n(b.meetingMinutes)}${
                b.otherBreakMinutes > 0 ? ` − Other ${n(b.otherBreakMinutes)}` : ''
              }`}
              strong
            />
          </section>

          <section className="om-detail-section">
            <h4>2 · Machines and production</h4>
            <Step
              label="Assigned machines"
              value={n(machines, 0)}
              formula={b.placeholderMachineCount > 0 ? `${b.layoutMachineCount} on the layout + ${b.placeholderMachineCount} stand-in (not on the layout yet)` : undefined}
            />
            <Step label="Runtime per spool" value={min(b.runtimePerSpool)} />
            <Step
              label="Stop minutes per spool"
              value={min(b.stopMinutesPerSpool)}
              formula="Σ Stop activities: time ÷ cycle (Dies: ÷ cycle × 16.5 dies/event) — RPC doesn't stop the machine"
            />
            <Step
              label="Availability after Stop activities"
              value={pct(b.stopAvailability * 100)}
              formula={`Runtime ${n(b.runtimePerSpool)} ÷ (runtime ${n(b.runtimePerSpool)} + stop ${n(b.stopMinutesPerSpool)})`}
            />
            <Step
              label="Waiting for operator per machine"
              value={min(b.waitingPerMachineMinutes)}
              formula="From section 6 — solved together with the work it causes (less production, less work, less waiting)"
            />
            <Step
              label="OEE availability"
              value={pct(b.scale * 100)}
              formula={`${pct(b.stopAvailability * 100)} × (shift ${n(b.shiftMinutes)} − waiting ${n(b.waitingPerMachineMinutes, 1)}) ÷ ${n(b.shiftMinutes)}`}
            />
            <Step
              label="Spools per machine"
              value={n(b.expectedSpoolsPerMachine * b.scale)}
              formula={`Shift ${n(b.shiftMinutes)} × OEE ${pct(b.scale * 100)} ÷ runtime ${n(b.runtimePerSpool)}`}
              strong
            />
          </section>
        </div>

        <section className="om-detail-section">
          <h4>3 · Operator activities (handling)</h4>
          <div className="fx-table-wrap">
            <table className="table fx-table">
              <thead>
                <tr>
                  <th>Activity</th>
                  <th title="Per machine, or once across the line (Fracture / Dies / Defect)">Scope</th>
                  <th title="Machine stops (Stop) or keeps running (Run) while it's done">Mach</th>
                  <th title="Spools per occurrence">Cycle</th>
                  <th title="Occurrences if machines never stopped (100% availability): shift ÷ runtime × machines ÷ cycle">Ideal events</th>
                  <th title={`Ideal events × OEE ${pct(b.scale * 100)}: spools per machine × machines ÷ cycle`}>Events</th>
                  <th>Time</th>
                  <th title={`Time × (1 + RPC ${n(b.rpcPercent)}%)`}>+ RPC</th>
                  <th title="Ideal events × time with RPC (Dies Change: dies × time with RPC) — the Ideal demand">Ideal min</th>
                  <th title="Events × time with RPC (Dies Change: dies × time with RPC)">Handling min</th>
                </tr>
              </thead>
              <tbody>
                {b.activities.map((step) => (
                  <tr key={step.key}>
                    <td>{step.label}</td>
                    <td>{step.scope === 'line' ? 'Line' : `× ${n(machines, 0)}`}</td>
                    <td>{step.stopsMachine ? 'Stop' : 'Run'}</td>
                    <td>{n(step.cycle)}</td>
                    <td title={step.quantity !== undefined ? `${n(step.quantity)} dies ÷ 16.5 per event` : undefined}>{n(step.events)}</td>
                    <td title={step.quantity !== undefined ? `${n(step.quantity * b.scale)} dies ÷ 16.5 per event` : undefined}>
                      {n(step.events * b.scale)}
                    </td>
                    <td>{n(step.timeMinutes)}</td>
                    <td>{n(step.timeWithRpcMinutes)}</td>
                    <td>{n(step.plannedMinutes, 1)}</td>
                    <td>{n(step.forecastMinutes, 1)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={4}>Total</th>
                  <th>{n(totalEvents)}</th>
                  <th>{n(totalEvents * b.scale)}</th>
                  <th colSpan={2} />
                  <th>{n(forecast.plannedMinutes, 1)}</th>
                  <th>{n(forecast.forecastServiceMinutes, 1)}</th>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="fx-note">
            Events come from the spools per machine above (already reduced by machine availability). Of the {min(forecast.forecastServiceMinutes)}{' '}
            handling, {min(rpcMinutes)} is the RPC allowance (Others (RPC) in Man Occupation). Ideal min is the same work at 100% machine
            availability (Ideal demand): handling = ideal {min(forecast.plannedMinutes)} × OEE {pct(b.scale * 100)}.
          </p>
        </section>

        <div className="om-detail-sections">
          <section className="om-detail-section">
            <h4>4 · Walking</h4>
            {b.walking.stops === 0 ? (
              <p className="fx-note">No walking: no machine needs a visit, or Walking Speed is 0.</p>
            ) : (
              <>
                <Step label="Machines on the route" value={n(b.walking.stops, 0)} formula="Ordered by distance from the operator's start point" />
                <Step label="First pass" value={`${n(b.walking.firstPassMeters, 1)} m`} formula="Start → each machine in turn" />
                <Step label="One loop back" value={`${n(b.walking.cycleMeters, 1)} m`} formula="Last machine → first machine" />
                <Step
                  label="Rounds"
                  value={n(b.walking.averageRounds)}
                  formula={`${n(b.walking.totalVisits)} visits ÷ ${n(b.walking.stops, 0)} machines (visits = the most frequent task's events)`}
                />
                <Step
                  label="Distance"
                  value={`${n(b.walking.distanceMeters, 1)} m`}
                  formula={`${n(b.walking.firstPassMeters, 1)} + (${n(b.walking.averageRounds)} − 1) × ${n(b.walking.cycleMeters, 1)}`}
                />
                <Step
                  label="Walking time"
                  value={min(forecast.forecastWalkingMinutes)}
                  formula={`${n(b.walking.distanceMeters, 1)} m ÷ ${n(b.walking.walkingSpeed)} m/min`}
                  strong
                />
              </>
            )}
          </section>

          <section className="om-detail-section">
            <h4>5 · Man occupation</h4>
            <Step label="Busy" value={min(busy)} formula={`Handling ${n(forecast.forecastServiceMinutes, 1)} + walking ${n(forecast.forecastWalkingMinutes, 1)}`} />
            <Step label="Idle" value={min(idle)} formula={`Available ${n(forecast.availableMinutes, 1)} − busy ${n(busy, 1)} (not below 0)`} />
            <Step
              label="Forecast Man Occupation"
              value={pct(forecast.forecastUtilizationPercent)}
              formula={`Busy ${n(busy, 1)} ÷ available ${n(forecast.availableMinutes, 1)} = ${pct(rawForecast)}${rawForecast > 100 ? ', capped at 100%' : ''}`}
              strong
            />
            <Step
              label="Ideal demand"
              value={pct(forecast.utilizationPercent)}
              formula={`Ideal handling ${n(forecast.plannedMinutes, 1)} ÷ available ${n(forecast.availableMinutes, 1)} (machines at 100% availability, no walking)`}
            />
            <Step
              label="Backlog"
              value={min(forecast.forecastWaitingMinutes)}
              formula={`Busy ${n(busy, 1)} − available ${n(forecast.availableMinutes, 1)} (not below 0): work the operator can't get to, so machines wait`}
            />
          </section>
        </div>

        <section className="om-detail-section">
          <h4>6 · Waiting for operator (machine interference)</h4>
          {wright.x <= 0 ? (
            <p className="fx-note">No interference: no machine or no operator work yet.</p>
          ) : (
            <>
              <div className="fx-inputs">
                <Step label="Machines (N)" value={n(wright.machines, 0)} />
                <Step
                  label="Running per machine"
                  value={min(wright.runningMinutesPerMachine)}
                  formula={`Shift ${n(b.shiftMinutes)} × OEE ${pct(b.scale * 100)}`}
                />
                <Step
                  label="Operator time per machine"
                  value={min(wright.serviceMinutesPerMachine)}
                  formula={`Busy ${n(busy, 1)} ÷ ${n(wright.machines, 0)} machines`}
                />
                <Step
                  label="X (running ÷ service)"
                  value={n(wright.x, 3)}
                  formula={`${n(wright.runningMinutesPerMachine, 1)} ÷ ${n(wright.serviceMinutesPerMachine, 1)}`}
                />
              </div>
              <div className="om-detail-sections">
                <div className={`fx-model${interference.model === 'wright' ? ' is-selected' : ''}`}>
                  <h5>
                    Wright's formula
                    {interference.model === 'wright' && <span className="waiting-info-badge">Used</span>}
                  </h5>
                  <Step label="A = 1 + X − N" value={n(wright.wrightA ?? 0, 3)} formula={`1 + ${n(wright.x, 3)} − ${n(wright.machines, 0)}`} />
                  <Step
                    label="√(A² + 2N)"
                    value={n(Math.sqrt((wright.wrightA ?? 0) ** 2 + 2 * wright.machines), 3)}
                    formula={`√(${n(wright.wrightA ?? 0, 3)}² + 2 × ${n(wright.machines, 0)})`}
                  />
                  <Step
                    label="I (% of service time)"
                    value={pct(wright.waitingPerServiceMinute * 100)}
                    formula={`50 × (${n(Math.sqrt((wright.wrightA ?? 0) ** 2 + 2 * wright.machines), 3)} − ${n(wright.wrightA ?? 0, 3)})`}
                  />
                  <Step
                    label="Interference waiting"
                    value={min(wright.minutes)}
                    formula={`${pct(wright.waitingPerServiceMinute * 100)} × busy ${n(busy, 1)}`}
                    strong
                  />
                  <Step label="As % of planned production" value={pct(shareOfPlanned(wright.minutes))} />
                </div>
                <div className={`fx-model${interference.model === 'finiteSource' ? ' is-selected' : ''}`}>
                  <h5>
                    Finite source (M/M/1//N)
                    {interference.model === 'finiteSource' && <span className="waiting-info-badge">Used</span>}
                  </h5>
                  <Step label="r = 1 ÷ X" value={n(finite.serviceRatio ?? 0, 4)} formula={`1 ÷ ${n(finite.x, 3)}`} />
                  <Step
                    label="Σ N!/(N−n)! × rⁿ"
                    value={n(finite.termSum ?? 0, 3)}
                    formula={`n = 0…${n(finite.machines, 0)}: 1 + N·r + N(N−1)·r² + …`}
                  />
                  <Step label="P0 (operator idle)" value={pct((finite.idleProbability ?? 0) * 100)} formula={`1 ÷ ${n(finite.termSum ?? 0, 3)}`} />
                  <Step label="Operator busy (1 − P0)" value={pct((finite.operatorBusyProbability ?? 0) * 100)} />
                  <Step
                    label="L (machines down)"
                    value={n(finite.averageDown ?? 0, 3)}
                    formula={`${n(finite.machines, 0)} − ${n(finite.operatorBusyProbability ?? 0, 4)} × ${n(finite.x, 3)}`}
                  />
                  <Step
                    label="Lq (machines waiting)"
                    value={n(finite.averageQueue ?? 0, 3)}
                    formula={`${n(finite.averageDown ?? 0, 3)} − ${n(finite.operatorBusyProbability ?? 0, 4)}`}
                  />
                  <Step
                    label="Waiting per service minute"
                    value={n(finite.waitingPerServiceMinute, 4)}
                    formula={`Lq ${n(finite.averageQueue ?? 0, 3)} ÷ busy ${n(finite.operatorBusyProbability ?? 0, 4)}`}
                  />
                  <Step
                    label="Interference waiting"
                    value={min(finite.minutes)}
                    formula={`${n(finite.waitingPerServiceMinute, 4)} × busy ${n(busy, 1)}`}
                    strong
                  />
                  <Step label="As % of planned production" value={pct(shareOfPlanned(finite.minutes))} />
                </div>
              </div>
              {interference.model === 'none' && (
                <p className="fx-note">Waiting model None: neither is used — they're shown for comparison only.</p>
              )}
              {interference.model !== 'none' && (
                <p className="fx-note">The model not chosen is worked out from the same inputs, for comparison only.</p>
              )}
            </>
          )}
          <div className="fx-inputs">
            <Step
              label="Waiting for Operator"
              value={min(forecast.machineWaitingMinutes)}
              formula={
                interference.model === 'none'
                  ? `Backlog ${n(forecast.forecastWaitingMinutes, 1)} (waiting model None)`
                  : `Larger of ${interference.model === 'wright' ? 'Wright' : 'finite source'} ${n(interference.minutes, 1)} and backlog ${n(
                      forecast.forecastWaitingMinutes,
                      1,
                    )}`
              }
            />
            <Step
              label="Interference %"
              value={pct(forecast.interferencePercent)}
              formula={`${n(forecast.machineWaitingMinutes, 1)} ÷ planned production ${n(downtime.plannedMachineMinutes, 1)}`}
              strong
            />
          </div>
        </section>

        <section className="om-detail-section">
          <h4>7 · Machine downtime</h4>
          <div className="om-detail-sections">
            <div>
              <Step label="Planned production" value={min(downtime.plannedMachineMinutes)} formula={`${n(machines, 0)} machines × shift ${n(b.shiftMinutes)}`} />
              {downtime.activityDowntime.map((row) => (
                <Step key={row.key} label={`Stop: ${row.label}`} value={min(row.minutes)} formula="Events × time (without RPC) — the machine is stopped while it's done" />
              ))}
              <Step label="Waiting for Operator" value={min(downtime.waitingMinutes)} formula="Section 6 (not more than planned production)" />
            </div>
            <div>
              <Step
                label="Total downtime"
                value={min(downtime.totalDowntimeMinutes)}
                formula="Σ Stop activities + waiting for operator"
              />
              <Step
                label="OEE Availability"
                value={pct(downtime.availabilityPercent)}
                formula={`(${n(downtime.plannedMachineMinutes, 1)} − ${n(downtime.totalDowntimeMinutes, 1)}) ÷ ${n(downtime.plannedMachineMinutes, 1)}`}
                strong
              />
              <Step
                label="Producing"
                value={min(downtime.producedMachineMinutes)}
                formula={`Spools ${n(forecast.expectedFinishedSpools)} × runtime ${n(b.runtimePerSpool)} — already without Stop and waiting time`}
              />
              <Step label="#Spool" value={n(downtime.estimatedSpools, 1)} formula={`Producing ${n(downtime.producedMachineMinutes, 1)} ÷ runtime ${n(b.runtimePerSpool)}`} />
            </div>
          </div>
        </section>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
