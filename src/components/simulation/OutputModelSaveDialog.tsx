import type { Mpp_wl_outputmodelses } from '../../generated/models/Mpp_wl_outputmodelsesModel';
import type { OutputModelPayload } from '../../lib/outputModel';
import { percentageForDisplay } from '../../lib/outputModel';
import { Button } from '../ui/Button';

type ComparisonKey =
  | 'mpp_totalspoolcount'
  | 'mpp_tonspershift'
  | 'mpp_actualmanoccupation'
  | 'mpp_actualmachineefficiency'
  | 'mpp_manhoursperton'
  | 'mpp_machinehoursperton'
  | 'mpp_actualfractureperton'
  | 'mpp_actualdefectperton'
  | 'mpp_actualdiesperton'
  | 'mpp_doffingtime'
  | 'mpp_loadingtime'
  | 'mpp_fracturerepairingtime'
  | 'mpp_defectrepairingtime'
  | 'mpp_dieschangetime'
  | 'mpp_walkingtime'
  | 'mpp_othertime';

interface ComparisonField {
  key: ComparisonKey;
  label: string;
  percent?: boolean;
}

const COMPARISON_FIELDS: ComparisonField[] = [
  { key: 'mpp_totalspoolcount', label: 'Total Spool (Runtime)' },
  { key: 'mpp_tonspershift', label: 'Ton/Shift (Runtime)' },
  { key: 'mpp_actualmanoccupation', label: 'Actual Man Occupation', percent: true },
  { key: 'mpp_actualmachineefficiency', label: 'Actual Machine Efficiency', percent: true },
  { key: 'mpp_manhoursperton', label: 'ManHour/Ton' },
  { key: 'mpp_machinehoursperton', label: 'MachineHour/Ton' },
  { key: 'mpp_actualfractureperton', label: 'Actual Fracture/Ton' },
  { key: 'mpp_actualdefectperton', label: 'Actual Defect/Ton' },
  { key: 'mpp_actualdiesperton', label: 'Actual Dies/Ton' },
  { key: 'mpp_doffingtime', label: 'Doffing', percent: true },
  { key: 'mpp_loadingtime', label: 'Loading', percent: true },
  { key: 'mpp_fracturerepairingtime', label: 'Fracture Repairing', percent: true },
  { key: 'mpp_defectrepairingtime', label: 'Defect Repairing', percent: true },
  { key: 'mpp_dieschangetime', label: 'Dies Change', percent: true },
  { key: 'mpp_walkingtime', label: 'Walking', percent: true },
  { key: 'mpp_othertime', label: 'Others', percent: true },
];

type ComparisonSource = Partial<Record<ComparisonKey, number>>;

function numericValue(source: ComparisonSource, key: ComparisonKey) {
  const value = Number(source[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function displayValue(source: ComparisonSource, field: ComparisonField) {
  const value = numericValue(source, field.key);
  return field.percent ? `${percentageForDisplay(value).toFixed(2)}%` : value.toFixed(2);
}

function differenceValue(oldValue: ComparisonSource, newValue: ComparisonSource, field: ComparisonField) {
  const oldNumber = numericValue(oldValue, field.key);
  const newNumber = numericValue(newValue, field.key);
  const difference = field.percent
    ? percentageForDisplay(newNumber) - percentageForDisplay(oldNumber)
    : newNumber - oldNumber;
  if (Math.abs(difference) < 0.005) return '—';
  return `${difference > 0 ? '+' : ''}${difference.toFixed(2)}${field.percent ? ' pp' : ''}`;
}

export function OutputModelSaveDialog({
  existing,
  existingVersions,
  draft,
  nextVersion,
  versionRemark,
  onVersionRemarkChange,
  onCancel,
  onExistingVersionChange,
  onReplace,
  onSaveNewVersion,
  saving,
  error,
}: {
  existing: Mpp_wl_outputmodelses;
  existingVersions: Mpp_wl_outputmodelses[];
  draft: OutputModelPayload;
  nextVersion: string;
  versionRemark: string;
  onVersionRemarkChange: (value: string) => void;
  onCancel: () => void;
  onExistingVersionChange: (id: string) => void;
  onReplace: () => void;
  onSaveNewVersion: () => void;
  saving: boolean;
  error: string | null;
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-dialog output-model-save-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="output-model-save-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="output-model-save-title">Output model already exists</h3>
        <p className="data-manager-hint">
          Construction Detail <strong>{draft.mpp_constructiondetailcode}</strong> already has version{' '}
          <strong>{existing.mpp_version ?? '0001'}</strong>
          {existing.mpp_versionremark?.trim() ? ` (${existing.mpp_versionremark.trim()})` : ''}. Compare the runtime output before saving.
        </p>
        <div className="modal-field output-model-comparison-version">
          <label htmlFor="output-model-comparison-version">Compare with existing version</label>
          <select
            id="output-model-comparison-version"
            className="input"
            value={existing.mpp_wl_outputmodelsid}
            onChange={(event) => onExistingVersionChange(event.target.value)}
            disabled={saving}
          >
            {existingVersions.map((version) => (
              <option key={version.mpp_wl_outputmodelsid} value={version.mpp_wl_outputmodelsid}>
                Version {version.mpp_version ?? '0001'}
                {version.mpp_versionremark?.trim() ? ` — ${version.mpp_versionremark.trim()}` : ' — No remark'}
              </option>
            ))}
          </select>
        </div>
        <div className="output-model-comparison-wrap">
          <table className="table output-model-comparison">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Existing (v{existing.mpp_version ?? '0001'})</th>
                <th>New</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON_FIELDS.map((field) => (
                <tr key={field.key}>
                  <td>{field.label}</td>
                  <td>{displayValue(existing, field)}</td>
                  <td>{displayValue(draft, field)}</td>
                  <td>{differenceValue(existing, draft, field)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-field">
          <label htmlFor="output-model-version-remark">Version remark (required for new version)</label>
          <input
            id="output-model-version-remark"
            className="input"
            maxLength={100}
            value={versionRemark}
            onChange={(event) => onVersionRemarkChange(event.target.value)}
            placeholder="Describe what changed in this version"
            disabled={saving}
          />
        </div>
        {error && <p className="construction-selector-error">{error}</p>}
        <div className="modal-actions output-model-save-actions">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={onReplace} disabled={saving}>
            {saving ? 'Saving…' : 'Replace existing'}
          </Button>
          <Button variant="primary" onClick={onSaveNewVersion} disabled={saving || !versionRemark.trim()}>
            Save as version {nextVersion}
          </Button>
        </div>
      </div>
    </div>
  );
}
