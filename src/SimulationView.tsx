import { useMemo, useState } from 'react';
import type { AppConfig } from './types';
import { useSimulation } from './hooks/useSimulation';
import { LayoutCanvas } from './components/simulation/LayoutCanvas';
import { Dashboard } from './components/simulation/Dashboard';
import { Controls } from './components/simulation/Controls';
import { OutputModelSaveDialog } from './components/simulation/OutputModelSaveDialog';
import { InheritedConditionDialog } from './components/simulation/InheritedConditionDialog';
import { useAuth } from './context/auth';
import type { Mpp_wl_outputmodelses } from './generated/models/Mpp_wl_outputmodelsesModel';
import {
  createOutputModel,
  findOutputModelsForConstruction,
  formatOutputModelVersion,
  outputModelVersionNumber,
  prepareSimulationOutputModel,
  replaceOutputModel,
  type OutputModelPayload,
} from './lib/outputModel';
import { copyOutputModelRows } from './lib/outputModelExport';
import { parseMachineStartConditions, useInheritedMachineConditions } from './hooks/useInheritedMachineConditions';

interface PendingOutputModelSave {
  payload: OutputModelPayload;
  existing: Mpp_wl_outputmodelses;
  existingVersions: Mpp_wl_outputmodelses[];
  nextVersion: string;
}

export function SimulationView({
  config,
  setConfig,
  onBack,
}: {
  config: AppConfig;
  setConfig: (updater: (prev: AppConfig) => AppConfig) => void;
  onBack: () => void;
}) {
  const { state, playing, speed, controls } = useSimulation(config);
  const { user } = useAuth();
  const [savingWlm, setSavingWlm] = useState(false);
  const [savedWlm, setSavedWlm] = useState(false);
  const [saveWlmError, setSaveWlmError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<PendingOutputModelSave | null>(null);
  const [versionRemark, setVersionRemark] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [copyingOutput, setCopyingOutput] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const [copyOutputError, setCopyOutputError] = useState<string | null>(null);
  const [selectedInheritedConditionId, setSelectedInheritedConditionId] = useState('');
  const [inheritedSelectionError, setInheritedSelectionError] = useState<string | null>(null);
  const [inheritedSelectionNotice, setInheritedSelectionNotice] = useState<string | null>(null);
  const [inheritedDialogOpen, setInheritedDialogOpen] = useState(false);
  const {
    rows: inheritedConditionRows,
    loading: loadingInheritedConditions,
    error: inheritedConditionLoadError,
  } = useInheritedMachineConditions(config.selectedConstructionDetail);
  const availableInheritedConditionRows = inheritedConditionRows;
  const inheritedConditionOptions = useMemo(
    () =>
      availableInheritedConditionRows.map((row) => ({
        id: row.mpp_wl_outputmodelsid,
        label: `Version ${row.mpp_version ?? '0001'} — ${row.mpp_versionremark?.trim() || 'No remark'}`,
      })),
    [availableInheritedConditionRows],
  );
  const selectedInheritedConditionRow = useMemo(
    () =>
      availableInheritedConditionRows.find((row) => row.mpp_wl_outputmodelsid === selectedInheritedConditionId) ??
      availableInheritedConditionRows[0],
    [availableInheritedConditionRows, selectedInheritedConditionId],
  );
  const effectiveInheritedConditionId = selectedInheritedConditionRow?.mpp_wl_outputmodelsid ?? '';
  const visibleInheritedConditionError = inheritedConditionLoadError ?? inheritedSelectionError;
  const inheritedConditionHint =
    !loadingInheritedConditions &&
    !visibleInheritedConditionError &&
    Boolean(config.selectedConstructionDetail?.trim()) &&
    inheritedConditionRows.length === 0
      ? 'No saved machine start condition is available for this Construction Detail.'
      : null;

  const handleSaveWlm = async () => {
    if (savingWlm || savedWlm || pendingSave) return;
    setSavingWlm(true);
    setSaveWlmError(null);
    try {
      const initialPayload = await prepareSimulationOutputModel(config, state, user.email, { version: '0001' });
      const constructionDetail = initialPayload.mpp_constructiondetailcode?.trim();
      if (!constructionDetail) {
        throw new Error('The selected Construction Detail is unavailable, so the WLM output cannot be saved.');
      }
      const existingRows = await findOutputModelsForConstruction(constructionDetail);
      if (existingRows.length === 0) {
        await createOutputModel(initialPayload);
        setSavedWlm(true);
        return;
      }
      const latest = [...existingRows].sort(
        (left, right) => outputModelVersionNumber(right.mpp_version) - outputModelVersionNumber(left.mpp_version),
      )[0];
      const nextVersionNumber =
        Math.max(...existingRows.map((row) => outputModelVersionNumber(row.mpp_version)), 0) + 1;
      setPendingSave({
        payload: initialPayload,
        existing: latest,
        existingVersions: existingRows,
        nextVersion: formatOutputModelVersion(nextVersionNumber),
      });
      setVersionRemark('');
      setDialogError(null);
    } catch (err) {
      setSaveWlmError(err instanceof Error ? err.message : 'Failed to save WLM output model.');
    } finally {
      setSavingWlm(false);
    }
  };

  const closeSaveDialog = () => {
    if (savingWlm) return;
    setPendingSave(null);
    setVersionRemark('');
    setDialogError(null);
  };

  const handleComparisonVersionChange = (id: string) => {
    setPendingSave((current) => {
      if (!current) return current;
      const selected = current.existingVersions.find((row) => row.mpp_wl_outputmodelsid === id);
      return selected ? { ...current, existing: selected } : current;
    });
  };

  const handleReplaceExisting = async () => {
    if (!pendingSave || savingWlm) return;
    setSavingWlm(true);
    setDialogError(null);
    try {
      await replaceOutputModel(pendingSave.existing.mpp_wl_outputmodelsid, {
        ...pendingSave.payload,
        mpp_version: pendingSave.existing.mpp_version ?? '0001',
        mpp_versionremark: pendingSave.existing.mpp_versionremark,
      });
      setPendingSave(null);
      setSavedWlm(true);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Failed to replace the existing WLM output model.');
    } finally {
      setSavingWlm(false);
    }
  };

  const handleSaveNewVersion = async () => {
    if (!pendingSave || savingWlm || !versionRemark.trim()) return;
    setSavingWlm(true);
    setDialogError(null);
    try {
      await createOutputModel({
        ...pendingSave.payload,
        mpp_version: pendingSave.nextVersion,
        mpp_versionremark: versionRemark.trim(),
      });
      setPendingSave(null);
      setSavedWlm(true);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Failed to save the new WLM version.');
    } finally {
      setSavingWlm(false);
    }
  };

  const handleCopyOutput = async () => {
    if (copyingOutput) return;
    setCopyingOutput(true);
    setCopiedOutput(false);
    setCopyOutputError(null);
    try {
      const payload = await prepareSimulationOutputModel(config, state, user.email, { version: '0001' });
      await copyOutputModelRows([payload]);
      setCopiedOutput(true);
    } catch (err) {
      setCopyOutputError(err instanceof Error ? err.message : 'Failed to copy the simulation output.');
    } finally {
      setCopyingOutput(false);
    }
  };

  const handleUseInheritedCondition = () => {
    const selectedRow = selectedInheritedConditionRow;
    if (!selectedRow) return;
    try {
      const conditions = parseMachineStartConditions(selectedRow.mpp_startmachcondition);
      setConfig((prev) => ({ ...prev, initialMachineConditions: conditions }));
      setInheritedSelectionError(null);
      const stoppedCount = conditions.filter((condition) => condition.status !== 'running').length;
      const pendingTaskCount = conditions.reduce((total, condition) => total + condition.pendingTasks.length, 0);
      setInheritedSelectionNotice(
        `Version ${selectedRow.mpp_version ?? '0001'} loaded: ${conditions.length} machines, ${stoppedCount} stopped, ${pendingTaskCount} pending task(s).`,
      );
      setInheritedDialogOpen(false);
    } catch (err) {
      setInheritedSelectionNotice(null);
      setInheritedSelectionError(err instanceof Error ? err.message : 'The selected inherited machine condition is invalid.');
    }
  };

  const openInheritedConditionDialog = () => {
    setSelectedInheritedConditionId(effectiveInheritedConditionId);
    setInheritedSelectionError(null);
    setInheritedDialogOpen(true);
  };

  const closeInheritedConditionDialog = () => {
    setInheritedDialogOpen(false);
    setInheritedSelectionError(null);
  };

  const handleConfigChange = (updater: (prev: AppConfig) => AppConfig) => {
    setSavedWlm(false);
    setSaveWlmError(null);
    setCopiedOutput(false);
    setCopyOutputError(null);
    setInheritedSelectionError(null);
    setInheritedSelectionNotice(null);
    setPendingSave(null);
    setDialogError(null);
    setConfig(updater);
  };

  const handleReset = () => {
    setSavedWlm(false);
    setSaveWlmError(null);
    setCopiedOutput(false);
    setCopyOutputError(null);
    setInheritedSelectionError(null);
    setInheritedSelectionNotice(null);
    setPendingSave(null);
    setDialogError(null);
    if (config.initialMachineConditions && config.initialMachineConditions.length > 0) {
      setConfig((prev) => ({ ...prev, initialMachineConditions: undefined }));
    } else {
      controls.reset();
    }
  };

  return (
    <div className="simulation-view">
      <Controls
        playing={playing}
        speed={speed}
        onPlay={controls.play}
        onPause={controls.pause}
        onReset={handleReset}
        onSpeedChange={controls.setSpeed}
        onBack={onBack}
        finished={state.finished}
        config={config}
        setConfig={handleConfigChange}
        liveSettingsDisabled={playing || state.metrics.clockMin > 0}
        elapsedMinutes={state.metrics.clockMin}
        totalMinutes={state.metrics.shiftTimeMin}
        availableMinutes={state.metrics.availableTimeMin}
        canSaveWlm={user.role === 'admin'}
        onSaveWlm={() => void handleSaveWlm()}
        savingWlm={savingWlm || Boolean(pendingSave)}
        savedWlm={savedWlm}
        canCopyOutput={state.finished}
        onCopyOutput={() => void handleCopyOutput()}
        copyingOutput={copyingOutput}
        copiedOutput={copiedOutput}
        inheritedConditionOptions={inheritedConditionOptions}
        onOpenInheritedCondition={openInheritedConditionDialog}
        breakMessage={
          state.operator.phase === 'break'
            ? `☕ Operator is on ${state.operator.breakLabel} — ${Math.ceil(state.operator.breakRemainingMin)} minutes remaining`
            : undefined
        }
      />
      {saveWlmError && <p className="simulation-save-error" role="alert">{saveWlmError}</p>}
      {copyOutputError && <p className="simulation-save-error" role="alert">{copyOutputError}</p>}
      {inheritedSelectionNotice && <p className="simulation-save-hint">{inheritedSelectionNotice}</p>}
      {visibleInheritedConditionError && (
        <p className="simulation-save-error" role="alert">
          {visibleInheritedConditionError}
        </p>
      )}
      {loadingInheritedConditions && <p className="simulation-save-hint">Loading inherited machine conditions…</p>}
      {inheritedConditionHint && <p className="simulation-save-hint">{inheritedConditionHint}</p>}
      <div className="simulation-body">
        <LayoutCanvas
          state={state}
          area={config.spec.area}
          fullscreenControls={
            <Controls
              playing={playing}
              speed={speed}
              onPlay={controls.play}
              onPause={controls.pause}
              onReset={handleReset}
              onSpeedChange={controls.setSpeed}
              onBack={onBack}
              finished={state.finished}
              config={config}
              setConfig={handleConfigChange}
              liveSettingsDisabled={playing || state.metrics.clockMin > 0}
              elapsedMinutes={state.metrics.clockMin}
              totalMinutes={state.metrics.shiftTimeMin}
              availableMinutes={state.metrics.availableTimeMin}
              canSaveWlm={user.role === 'admin'}
              onSaveWlm={() => void handleSaveWlm()}
              savingWlm={savingWlm || Boolean(pendingSave)}
              savedWlm={savedWlm}
              canCopyOutput={state.finished}
              onCopyOutput={() => void handleCopyOutput()}
              copyingOutput={copyingOutput}
              copiedOutput={copiedOutput}
              inheritedConditionOptions={inheritedConditionOptions}
              onOpenInheritedCondition={openInheritedConditionDialog}
              breakMessage={
                state.operator.phase === 'break'
                  ? `☕ Operator is on ${state.operator.breakLabel} — ${Math.ceil(state.operator.breakRemainingMin)} minutes remaining`
                  : undefined
              }
            />
          }
        />
        <Dashboard state={state} config={config} />
      </div>
      {pendingSave && (
        <OutputModelSaveDialog
          existing={pendingSave.existing}
          existingVersions={pendingSave.existingVersions}
          draft={pendingSave.payload}
          nextVersion={pendingSave.nextVersion}
          versionRemark={versionRemark}
          onVersionRemarkChange={setVersionRemark}
          onCancel={closeSaveDialog}
          onExistingVersionChange={handleComparisonVersionChange}
          onReplace={() => void handleReplaceExisting()}
          onSaveNewVersion={() => void handleSaveNewVersion()}
          saving={savingWlm}
          error={dialogError}
        />
      )}
      {inheritedDialogOpen && (
        <InheritedConditionDialog
          constructionDetail={config.selectedConstructionDetail}
          options={inheritedConditionOptions}
          selectedId={effectiveInheritedConditionId}
          onSelect={setSelectedInheritedConditionId}
          onCancel={closeInheritedConditionDialog}
          onConfirm={handleUseInheritedCondition}
          error={inheritedSelectionError}
        />
      )}
    </div>
  );
}
