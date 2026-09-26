import { useEffect } from 'react';
import { percentageForDisplay } from '../../lib/outputModel';
import {
  formatOutputModelValue,
  outputModelColumnLabel,
  type OutputModelKey,
  type OutputModelRecord,
} from '../../lib/outputModelColumns';

const DETAIL_SECTIONS: { title: string; keys: OutputModelKey[]; wide?: boolean }[] = [
  {
    title: 'Product & Construction',
    keys: ['mpp_construction', 'mpp_areacode', 'mpp_machinecode', 'mpp_productcode', 'mpp_tensilegroup', 'mpp_spooltype', 'mpp_laylength', 'mpp_spoollength', 'mpp_nofwires', 'mpp_speed', 'mpp_lineardensity'],
  },
  {
    title: 'Frequency & Loading',
    keys: ['mpp_fractureperton', 'mpp_defectperton', 'mpp_diesperton', 'mpp_polength1', 'mpp_polength2', 'mpp_polength3'],
  },
  {
    title: 'Machine Spec',
    keys: ['mpp_twistperminute', 'mpp_linearspeeds', 'mpp_spoolweight', 'mpp_runtimeperspool'],
  },
  {
    title: 'Operator Setup',
    keys: ['mpp_taskpriority', 'mpp_shifttime', 'mpp_lunchtime', 'mpp_lunchstarttime', 'mpp_meetingtime', 'mpp_meetingstarttime', 'mpp_numberofmachinesassigned'],
  },
  {
    title: 'Actual Rates',
    keys: ['mpp_actualfractureperton', 'mpp_actualdefectperton', 'mpp_actualdiesperton'],
  },
];

const DETAIL_KPIS: OutputModelKey[] = [
  'mpp_plannedmanoccupation',
  'mpp_actualmanoccupation',
  'mpp_plannedmachineefficiency',
  'mpp_actualmachineefficiency',
  'mpp_tonspershift',
  'mpp_totalspoolcount',
  'mpp_manhoursperton',
  'mpp_machinehoursperton',
];

/** Man-occupation split, in the order it's worked (service, walking, others, idle). */
const OCCUPATION_PARTS: { key: OutputModelKey; color: string }[] = [
  { key: 'mpp_doffingtime', color: '#3987e5' },
  { key: 'mpp_loadingtime', color: '#9085e9' },
  { key: 'mpp_fracturerepairingtime', color: '#e66767' },
  { key: 'mpp_defectrepairingtime', color: '#c98500' },
  { key: 'mpp_dieschangetime', color: '#d55181' },
  { key: 'mpp_walkingtime', color: '#199e70' },
  { key: 'mpp_othertime', color: '#94a3b8' },
  { key: 'mpp_idle', color: '#475569' },
];

/** One-page detail of a saved output model — every column, grouped, opened by double-clicking a
 * row. Closes on ×, Esc, or a click outside the dialog. */
export function OutputModelDetailDialog({
  row,
  onClose,
  eyebrow,
}: {
  row: OutputModelRecord;
  onClose: () => void;
  /** Small heading above the title; defaults to the saved version. */
  eyebrow?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const value = (key: OutputModelKey) => formatOutputModelValue(row[key], key);
  const occupation = OCCUPATION_PARTS.map((part) => ({
    ...part,
    label: outputModelColumnLabel(part.key),
    percent: typeof row[part.key] === 'number' ? Math.max(0, percentageForDisplay(row[part.key] as number)) : 0,
  }));
  const occupationTotal = occupation.reduce((sum, part) => sum + part.percent, 0) || 1;

  return (
    <div className="modal-overlay om-detail-overlay" onClick={onClose}>
      <div
        className="om-detail"
        role="dialog"
        aria-modal="true"
        aria-label={`Output model ${row.mpp_constructiondetailcode ?? ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="om-detail-header">
          <div>
            <span className="om-detail-eyebrow">{eyebrow ?? `Output model · Version ${value('mpp_version')}`}</span>
            <h3>{value('mpp_constructiondetailcode')}</h3>
            <p>
              {row.mpp_versionremark ? `${row.mpp_versionremark} · ` : ''}
              {row.mpp_updatedon ? `Updated ${value('mpp_updatedon')} by ${value('mpp_updatedby')}` : 'Not saved yet'}
            </p>
          </div>
          <button type="button" className="om-detail-close" onClick={onClose} aria-label="Close details" title="Close (Esc)">
            ×
          </button>
        </header>

        <section className="om-detail-kpis">
          {DETAIL_KPIS.map((key) => (
            <div key={key} className="om-detail-kpi">
              <span>{outputModelColumnLabel(key)}</span>
              <strong>{value(key)}</strong>
            </div>
          ))}
        </section>

        <div className="om-detail-body">
          <div className="om-detail-sections">
            {DETAIL_SECTIONS.map((section) => (
              <section key={section.title} className="om-detail-section">
                <h4>{section.title}</h4>
                <dl>
                  {section.keys.map((key) => (
                    <div key={key}>
                      <dt>{outputModelColumnLabel(key)}</dt>
                      <dd>{value(key)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>

          <section className="om-detail-section om-detail-occupation">
            <h4>Man Occupation Breakdown</h4>
            <div className="om-detail-stack" aria-hidden="true">
              {occupation.map((part) =>
                part.percent > 0 ? (
                  <span
                    key={part.key}
                    style={{ width: `${(part.percent / occupationTotal) * 100}%`, background: part.color }}
                    title={`${part.label}: ${part.percent.toFixed(2)}%`}
                  />
                ) : null,
              )}
            </div>
            <dl>
              {occupation.map((part) => (
                <div key={part.key}>
                  <dt>
                    <span className="om-detail-swatch" style={{ background: part.color }} />
                    {part.label}
                  </dt>
                  <dd>{value(part.key)}</dd>
                </div>
              ))}
            </dl>
            <div className="om-detail-condition">
              <span>{outputModelColumnLabel('mpp_startmachcondition')}</span>
              <strong>{value('mpp_startmachcondition')}</strong>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
