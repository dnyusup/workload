import { useState } from 'react';
import { useAppConfig } from '../../context/AppConfigContext';
import { useInheritedMachineConditions, parseMachineStartConditions } from '../../hooks/useInheritedMachineConditions';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

export function InheritedMachineConditionSelector() {
  const { config, setConfig } = useAppConfig();
  const [selectedId, setSelectedId] = useState('');
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [appliedMessage, setAppliedMessage] = useState<string | null>(null);
  const { rows, loading, error: loadError } = useInheritedMachineConditions(config.selectedConstructionDetail);
  const selectedRow = rows.find((row) => row.mpp_wl_outputmodelsid === selectedId) ?? rows[0];

  const useCondition = () => {
    if (!selectedRow) return;
    try {
      const conditions = parseMachineStartConditions(selectedRow.mpp_startmachcondition);
      setConfig((prev) => ({ ...prev, initialMachineConditions: conditions }));
      setSelectedId(selectedRow.mpp_wl_outputmodelsid);
      setSelectionError(null);
      const stoppedCount = conditions.filter((condition) => condition.status !== 'running').length;
      const pendingTaskCount = conditions.reduce((total, condition) => total + condition.pendingTasks.length, 0);
      setAppliedMessage(
        `Version ${selectedRow.mpp_version ?? '0001'} loaded: ${conditions.length} machines, ${stoppedCount} stopped, ${pendingTaskCount} pending task(s).`,
      );
    } catch (err) {
      setAppliedMessage(null);
      setSelectionError(err instanceof Error ? err.message : 'The selected inherited machine condition is invalid.');
    }
  };

  if (!config.selectedConstructionDetail) return null;

  return (
    <Card
      className="inherited-condition-card"
      title="Inherited Machine Condition"
      subtitle="Reuse the machine state saved in WL_Outputmodels before starting the simulation."
    >
      {loading && <p className="data-manager-hint">Loading saved machine conditions…</p>}
      {loadError && <p className="construction-selector-error">{loadError}</p>}
      {!loading && !loadError && rows.length === 0 && (
        <p className="data-manager-hint">
          No saved machine start condition is available for this Construction Detail.
        </p>
      )}
      {rows.length > 0 && (
        <div className="inherited-condition-picker">
          <select
            className="input inherited-condition-picker-select"
            value={selectedRow?.mpp_wl_outputmodelsid ?? ''}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setSelectionError(null);
            }}
            aria-label="Select inherited machine condition version"
          >
            {rows.map((row) => (
              <option key={row.mpp_wl_outputmodelsid} value={row.mpp_wl_outputmodelsid}>
                Version {row.mpp_version ?? '0001'} — {row.mpp_versionremark?.trim() || 'No remark'}
              </option>
            ))}
          </select>
          <Button variant="secondary" onClick={useCondition}>
            ↺ Use selected condition
          </Button>
        </div>
      )}
      {appliedMessage && <p className="simulation-save-hint">{appliedMessage}</p>}
      {selectionError && <p className="construction-selector-error">{selectionError}</p>}
    </Card>
  );
}
