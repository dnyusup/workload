import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Mpp_wl_productses } from '../../generated/models/Mpp_wl_productsesModel';
import type { AppConfig } from '../../types';
import { runBatchSimulation, type BatchLogEntry } from '../../lib/batchSimulation';
import { Button } from '../ui/Button';

type StatusFilter = 'all' | BatchLogEntry['status'];

const STATUS_LABEL: Record<BatchLogEntry['status'], string> = { success: 'Success', failed: 'Failed', cancelled: 'Cancelled' };

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const escape = (value: string | number) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const blob = new Blob([rows.map((row) => row.map(escape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Runs Batch Simulation for the given Construction Details: a progress bar while it runs, then
 * the log of every item — success, or why it failed — with Export CSV. */
export function BatchSimulationDialog({
  products,
  base,
  updatedBy,
  onClose,
}: {
  products: Mpp_wl_productses[];
  base: AppConfig;
  updatedBy: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<(BatchLogEntry | undefined)[]>(() => new Array(products.length).fill(undefined));
  const [phase, setPhase] = useState<'running' | 'done' | 'error'>('running');
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const cancelledRef = useRef(false);
  const [startedAt] = useState(() => performance.now());
  const [now, setNow] = useState(() => performance.now());

  // Start once: products/base are a snapshot taken when the button was clicked.
  useEffect(() => {
    // Per run, so a second mount (React StrictMode) never shares or cancels the first one's state.
    const run = { alive: true };
    runBatchSimulation({
      products,
      base,
      updatedBy,
      isCancelled: () => !run.alive || cancelledRef.current,
      onItemDone: (entry, index) => {
        if (!run.alive) return;
        setEntries((prev) => {
          const next = [...prev];
          next[index] = entry;
          return next;
        });
      },
    })
      .then(() => run.alive && setPhase('done'))
      .catch((err) => {
        if (!run.alive) return;
        setFatalError(err instanceof Error ? err.message : 'Batch Simulation could not start.');
        setPhase('error');
      });
    return () => {
      run.alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== 'running') return;
    const timer = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const done = entries.filter(Boolean) as BatchLogEntry[];
  const counts = {
    success: done.filter((entry) => entry.status === 'success').length,
    failed: done.filter((entry) => entry.status === 'failed').length,
    cancelled: done.filter((entry) => entry.status === 'cancelled').length,
  };
  const total = products.length;
  const elapsed = now - startedAt;
  const remaining = done.length > 0 && phase === 'running' ? (elapsed / done.length) * (total - done.length) : 0;
  const percent = total > 0 ? (done.length / total) * 100 : 0;

  const visible = useMemo(() => done.filter((entry) => filter === 'all' || entry.status === filter), [done, filter]);

  const cancel = () => {
    cancelledRef.current = true;
    setCancelling(true);
  };

  const close = () => {
    if (phase === 'running' && !window.confirm('Stop the batch? Items already saved stay in WL_Outputmodels.')) return;
    cancelledRef.current = true;
    onClose();
  };

  const exportLog = () => {
    const header = ['Construction Detail', 'Area', 'Status', 'Result', 'Machines', 'Forecast Man Occupation %', 'Actual Man Occupation %', 'Ton/Shift', 'Forecast OEE %', 'Actual OEE %', 'Forecast MHPT', 'Actual MHPT', 'Message', 'Seconds'];
    const rows = done.map((entry) => [
      entry.constructionDetail,
      entry.area,
      STATUS_LABEL[entry.status],
      entry.action ?? '',
      entry.machines ?? '',
      entry.forecastManOccupation !== undefined ? entry.forecastManOccupation.toFixed(1) : '',
      entry.actualManOccupation !== undefined ? entry.actualManOccupation.toFixed(1) : '',
      entry.tonPerShift !== undefined ? entry.tonPerShift.toFixed(3) : '',
      entry.forecastOee !== undefined ? entry.forecastOee.toFixed(1) : '',
      entry.actualOee !== undefined ? entry.actualOee.toFixed(1) : '',
      entry.forecastMhpt !== undefined ? entry.forecastMhpt.toFixed(3) : '',
      entry.actualMhpt !== undefined ? entry.actualMhpt.toFixed(3) : '',
      entry.message,
      (entry.durationMs / 1000).toFixed(1),
    ]);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadCsv(`batch-simulation-${stamp}.csv`, [header, ...rows]);
  };

  return createPortal(
    <div className="modal-overlay om-detail-overlay">
      <div className="om-detail batch-dialog" role="dialog" aria-modal="true" aria-label="Batch Simulation">
        <header className="om-detail-header">
          <div>
            <span className="om-detail-eyebrow">WL_Products</span>
            <h3>Batch Simulation</h3>
            <p>
              {total} Construction Detail(s) · Default Values and each Area's Default Layout · Optimize Man Occupation · results saved to
              WL_Outputmodels as version 0001. Keep this page open until it finishes.
            </p>
          </div>
          <button type="button" className="om-detail-close" onClick={close} aria-label="Close" title="Close">
            ×
          </button>
        </header>

        {fatalError ? (
          <p className="construction-selector-error">{fatalError}</p>
        ) : (
          <>
            <div className="batch-progress" aria-live="polite">
              <div className="batch-progress-track">
                <div className="batch-progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="batch-progress-stats">
                <strong>
                  {done.length} / {total}
                </strong>
                <span className="batch-stat-success">{counts.success} success</span>
                <span className="batch-stat-failed">{counts.failed} failed</span>
                {counts.cancelled > 0 && <span>{counts.cancelled} cancelled</span>}
                <span>
                  {formatDuration(elapsed)}
                  {phase === 'running' && done.length > 0 ? ` · about ${formatDuration(remaining)} left` : ''}
                </span>
              </div>
            </div>

            {phase === 'running' ? (
              <div className="batch-actions">
                <Button variant="danger" onClick={cancel} disabled={cancelling}>
                  {cancelling ? 'Stopping after the current item…' : 'Cancel'}
                </Button>
              </div>
            ) : (
              <>
                <div className="batch-actions">
                  <select className="input batch-filter" value={filter} onChange={(e) => setFilter(e.target.value as StatusFilter)}>
                    <option value="all">All ({done.length})</option>
                    <option value="success">Success ({counts.success})</option>
                    <option value="failed">Failed ({counts.failed})</option>
                    {counts.cancelled > 0 && <option value="cancelled">Cancelled ({counts.cancelled})</option>}
                  </select>
                  <Button variant="secondary" onClick={exportLog} disabled={done.length === 0}>
                    Export CSV
                  </Button>
                  <Button variant="primary" onClick={onClose}>
                    Close
                  </Button>
                </div>
                <div className="batch-log-wrap">
                  <table className="table batch-log">
                    <thead>
                      <tr>
                        <th>Construction Detail</th>
                        <th>Area</th>
                        <th>Status</th>
                        <th>Machines</th>
                        <th>Forecast MO</th>
                        <th>Actual MO</th>
                        <th>Ton/Shift</th>
                        <th title="Machine efficiency (OEE) from the forecast">Forecast OEE</th>
                        <th title="Machine efficiency (OEE) of the simulated shift">Actual OEE</th>
                        <th title="Man hours per ton from the forecast">Forecast MHPT</th>
                        <th title="Man hours per ton of the simulated shift">Actual MHPT</th>
                        <th>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((entry) => (
                        <tr key={`${entry.productId}-${entry.constructionDetail}`}>
                          <td>{entry.constructionDetail || '—'}</td>
                          <td>{entry.area || '—'}</td>
                          <td>
                            <span className={`batch-status batch-status-${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
                          </td>
                          <td>{entry.machines ?? '—'}</td>
                          <td>{entry.forecastManOccupation !== undefined ? `${entry.forecastManOccupation.toFixed(1)}%` : '—'}</td>
                          <td>{entry.actualManOccupation !== undefined ? `${entry.actualManOccupation.toFixed(1)}%` : '—'}</td>
                          <td>{entry.tonPerShift !== undefined ? entry.tonPerShift.toFixed(2) : '—'}</td>
                          <td>{entry.forecastOee !== undefined ? `${entry.forecastOee.toFixed(1)}%` : '—'}</td>
                          <td>{entry.actualOee !== undefined ? `${entry.actualOee.toFixed(1)}%` : '—'}</td>
                          <td>{entry.forecastMhpt !== undefined ? entry.forecastMhpt.toFixed(2) : '—'}</td>
                          <td>{entry.actualMhpt !== undefined ? entry.actualMhpt.toFixed(2) : '—'}</td>
                          <td className="batch-message">{entry.message}</td>
                        </tr>
                      ))}
                      {visible.length === 0 && (
                        <tr>
                          <td colSpan={12} className="data-manager-hint">
                            Nothing here.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
