import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/** Full-screen progress or loading overlay for operations that must not be interrupted
 * (e.g. CSV import, setup duplication, or syncing frequency from MES Power BI).
 * While mounted, the whole app under #root is made `inert` — not just covered — so it can't be
 * clicked OR reached with Tab/Enter, and closing/reloading the tab asks for confirmation. */
export function BlockingProgressOverlay({
  title,
  message,
  done,
  total,
}: {
  title: string;
  message?: string;
  done?: number;
  total?: number;
}) {
  useEffect(() => {
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    const confirmLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', confirmLeave);
    return () => {
      root?.removeAttribute('inert');
      window.removeEventListener('beforeunload', confirmLeave);
    };
  }, []);

  const hasProgress = typeof done === 'number' && typeof total === 'number';
  const percent = hasProgress && total > 0 ? Math.min(100, (done / total) * 100) : 0;

  return createPortal(
    <div className="blocking-progress-overlay" role="alertdialog" aria-modal="true" aria-busy="true" aria-label={title}>
      <div
        className="blocking-progress-panel"
        style={hasProgress ? undefined : { textAlign: 'center', alignItems: 'center' }}
      >
        <strong>{title}</strong>
        {hasProgress ? (
          <>
            <div className="blocking-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
              <div className="blocking-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <span className="blocking-progress-count">
              {done} / {total} ({Math.round(percent)}%)
            </span>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '12px 0' }}>
            <div className="frequency-spinner" />
            {message && (
              <span className="blocking-progress-hint" style={{ fontSize: '0.85rem', color: '#cbd5e1' }}>
                {message}
              </span>
            )}
          </div>
        )}
        <span className="blocking-progress-hint">
          Please wait — don&apos;t close or reload this page until it finishes.
        </span>
      </div>
    </div>,
    document.body,
  );
}
