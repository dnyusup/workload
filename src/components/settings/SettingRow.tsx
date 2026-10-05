import type { ReactNode } from 'react';

/** One "Title : field" line of a Setting section — the label column lines up across a section. */
export function SettingRow({ label, tooltip, children }: { label: string; tooltip?: string; children: ReactNode }) {
  return (
    <label className="settings-row">
      <span className="settings-row-label">
        {label}
        {tooltip && (
          <span className="field-info" title={tooltip} aria-label={tooltip}>
            ⓘ
          </span>
        )}
      </span>
      <span className="settings-row-colon" aria-hidden="true">
        :
      </span>
      <span className="settings-row-control">{children}</span>
    </label>
  );
}

/** A titled group of SettingRows inside a Setting section. */
export function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h4 className="settings-group-title">{title}</h4>
      <div className="settings-group-rows">{children}</div>
    </section>
  );
}
