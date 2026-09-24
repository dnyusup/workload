import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/** Full-screen progress overlay for long writes that must not be interrupted (e.g. CSV import
 * saving one Dataverse row per machine). While mounted, the whole app under #root is made `inert`
 * — not just covered — so it can't be clicked OR reached with Tab/Enter, and closing/reloading the
 * tab asks for confirmation since that would stop the remaining writes part-way. */
export function BlockingProgressOverlay({ title, done, total }: { title: string; done: number; total: number }) {
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

  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;

  return createPortal(
    <div className="blocking-progress-overlay" role="alertdialog" aria-modal="true" aria-busy="true" aria-label={title}>
      <div className="blocking-progress-panel">
        <strong>{title}</strong>
        <div className="blocking-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <div className="blocking-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="blocking-progress-count">
          {done} / {total} ({Math.round(percent)}%)
        </span>
        <span className="blocking-progress-hint">Please wait — don&apos;t close or reload this page until it finishes.</span>
      </div>
    </div>,
    document.body,
  );
}
