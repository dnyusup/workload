import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { WaitingModel } from '../../types';

const MODELS: { value: WaitingModel; title: string; summary: string; formulas: string[]; notes: string[] }[] = [
  {
    value: 'none',
    title: 'None — backlog only',
    summary: 'Machine interference isn\'t estimated: machines only wait when the operator has more work than time.',
    formulas: ['Waiting = max(0, (handling + walking) − available time)'],
    notes: ['Zero whenever Forecast Man Occupation is below 100%, so the forecast is the most optimistic of the three.'],
  },
  {
    value: 'wright',
    title: "Wright's formula (machine interference)",
    summary:
      'The classic formula for one operator tending N machines (spinning, weaving, wire): machines still wait now and then because several need the operator at once, even when the operator isn\'t fully loaded.',
    formulas: [
      'X = running time per machine ÷ operator time per machine (handling + walking)',
      'I = 50 × ( √((1 + X − N)² + 2N) − (1 + X − N) )   — % of service time',
      'Waiting = I ÷ 100 × (handling + walking)',
    ],
    notes: [
      'N = machines assigned; running time = shift × OEE.',
      'Fits fairly regular service times; in this app it tends to come out a little lower than the simulation.',
    ],
  },
  {
    value: 'finiteSource',
    title: 'Finite source queue (M/M/1//N, "machine repairman")',
    summary:
      'Queueing theory for N machines sharing one server: every machine is either running, being serviced, or waiting for the operator.',
    formulas: [
      'r = 1 ÷ X   (service time ÷ running time)',
      'P0 = 1 ÷ Σ N! ÷ (N − n)! × rⁿ,  n = 0…N   — chance the operator is idle',
      'L = N − (1 − P0) × X   — machines down;   Lq = L − (1 − P0)   — machines waiting',
      'Waiting = Lq ÷ (1 − P0) × (handling + walking)',
    ],
    notes: [
      'Assumes random (exponential) running and service times, so it gives somewhat more waiting than Wright; in this app it is closer to the simulation at normal loads.',
    ],
  },
];

/** What each Waiting model means and the formula it uses. */
export function WaitingModelInfoDialog({ selected, onClose }: { selected: WaitingModel; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-overlay om-detail-overlay" onClick={onClose}>
      <div
        className="om-detail waiting-info-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Waiting models"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="om-detail-header">
          <div>
            <span className="om-detail-eyebrow">Waiting for operator</span>
            <h3>Waiting models</h3>
            <p>
              How the forecast estimates machines waiting for the one operator. Whichever is chosen, Waiting for Operator = the larger of
              that model's waiting and the backlog; it lowers OEE, and spools and the operator's work follow from that OEE (solved together).
            </p>
          </div>
          <button type="button" className="om-detail-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ×
          </button>
        </header>
        {MODELS.map((model) => (
          <section key={model.value} className={`om-detail-section waiting-info-model${model.value === selected ? ' is-selected' : ''}`}>
            <h4>
              {model.title}
              {model.value === selected && <span className="waiting-info-badge">Selected</span>}
            </h4>
            <p className="fx-note">{model.summary}</p>
            <ul className="waiting-info-formulas">
              {model.formulas.map((formula) => (
                <li key={formula}>
                  <code>{formula}</code>
                </li>
              ))}
            </ul>
            {model.notes.map((note) => (
              <p key={note} className="fx-note">
                {note}
              </p>
            ))}
          </section>
        ))}
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
