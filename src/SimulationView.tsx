import { useEffect, useMemo, useState } from 'react';
import type { AppConfig } from './types';
import { useSimulation } from './hooks/useSimulation';
import { LayoutCanvas } from './components/simulation/LayoutCanvas';
import { Dashboard } from './components/simulation/Dashboard';
import { Controls } from './components/simulation/Controls';
import { OutputModelSaveDialog } from './components/simulation/OutputModelSaveDialog';
import { useAuth } from './context/AuthContext';
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
import type { MachineStartCondition } from './types';

interface PendingOutputModelSave {
  payload: OutputModelPayload;
  existing: Mpp_wl_outputmodelses;
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
  const [inheritedConditionRows, setInheritedConditionRows] = useState<Mpp_wl_outputmodelses[]>([]);
  const [loadedConstructionDetail, setLoadedConstructionDetail] = useState('');
  const [selectedInheritedConditionId, setSelectedInheritedConditionId] = useState('');
  const [loadingInheritedConditions, setLoadingInheritedConditions] = useState(false);
  const [inheritedConditionError, setInheritedConditionError] = useState<string | null>(null);

  useEffect(() => {
    const constructionDetail = config.selectedConstructionDetail?.trim();
    if (!constructionDetail) return;
    let cancelled = false;
    // This effect synchronizes the toolbar with the external Dataverse query lifecycle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingInheritedConditions(true);
    findOutputModelsForConstruction(constructionDetail)
      .then((rows) => {
        if (cancelled) return;
        const rowsWithConditions = rows
          .filter((row) => row.mpp_startmachcondition?.trim())
          .sort(
            (left, right) =>
              outputModelVersionNumber(right.mpp_version) - outputModelVersionNumber(left.mpp_version),
          );
        setInheritedConditionRows(rowsWithConditions);
        setLoadedConstructionDetail(constructionDetail);
        setSelectedInheritedConditionId(rowsWithConditions[0]?.mpp_wl_outputmodelsid ?? '');
        setInheritedConditionError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setInheritedConditionRows([]);
        setLoadedConstructionDetail(constructionDetail);
        setSelectedInheritedConditionId('');
        setInheritedConditionError(err instanceof Error ? err.message : 'Failed to load inherited machine conditions.');
      })
      .finally(() => {
        if (!cancelled) setLoadingInheritedConditions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [config.selectedConstructionDetail]);

  const availableInheritedConditionRows = useMemo(
    () =>
      loadedConstructionDetail === config.selectedConstructionDetail?.trim() ? inheritedConditionRows : [],
    [config.selectedConstructionDetail, inheritedConditionRows, loadedConstructionDetail],
  );
  const inheritedConditionOptions = useMemo(
    () =>
      availableInheritedConditionRows.map((row) => ({
        id: row.mpp_wl_outputmodelsid,
        label: `Version ${row.mpp_version ?? '0001'} — ${row.mpp_versionremark?.trim() || 'No remark'}`,
      })),
    [availableInheritedConditionRows],
  );
  const visibleInheritedConditionError =
    loadedConstructionDetail === config.selectedConstructionDetail?.trim() ? inheritedConditionError : null;

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
    const selectedRow = availableInheritedConditionRows.find(
      (row) => row.mpp_wl_outputmodelsid === selectedInheritedConditionId,
    );
    if (!selectedRow) return;
    try {
      const conditions = JSON.parse(selectedRow.mpp_startmachcondition ?? '') as MachineStartCondition[];
      if (!Array.isArray(conditions) || conditions.some((condition) => !condition.machineId)) {
        throw new Error('The selected inherited machine condition is invalid.');
      }
      setConfig((prev) => ({ ...prev, initialMachineConditions: conditions }));
      setInheritedConditionError(null);
    } catch (err) {
      setInheritedConditionError(err instanceof Error ? err.message : 'The selected inherited machine condition is invalid.');
    }
  };

  const handleConfigChange = (updater: (prev: AppConfig) => AppConfig) => {
    setSavedWlm(false);
    setSaveWlmError(null);
    setCopiedOutput(false);
    setCopyOutputError(null);
    setPendingSave(null);
    setDialogError(null);
    setConfig(updater);
  };

  const handleReset = () => {
    setSavedWlm(false);
    setSaveWlmError(null);
    setCopiedOutput(false);
    setCopyOutputError(null);
    setPendingSave(null);
    setDialogError(null);
    controls.reset();
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
        selectedInheritedConditionId={selectedInheritedConditionId}
        onInheritedConditionChange={setSelectedInheritedConditionId}
        onUseInheritedCondition={handleUseInheritedCondition}
        breakMessage={
          state.operator.phase === 'break'
            ? `☕ Operator is on ${state.operator.breakLabel} — ${Math.ceil(state.operator.breakRemainingMin)} minutes remaining`
            : undefined
        }
      />
      {saveWlmError && <p className="simulation-save-error" role="alert">{saveWlmError}</p>}
      {copyOutputError && <p className="simulation-save-error" role="alert">{copyOutputError}</p>}
      {visibleInheritedConditionError && (
        <p className="simulation-save-error" role="alert">
          {visibleInheritedConditionError}
        </p>
      )}
      {loadingInheritedConditions && <p className="simulation-save-hint">Loading inherited machine conditions…</p>}
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
              selectedInheritedConditionId={selectedInheritedConditionId}
              onInheritedConditionChange={setSelectedInheritedConditionId}
              onUseInheritedCondition={handleUseInheritedCondition}
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
          draft={pendingSave.payload}
          nextVersion={pendingSave.nextVersion}
          versionRemark={versionRemark}
          onVersionRemarkChange={setVersionRemark}
          onCancel={closeSaveDialog}
          onReplace={() => void handleReplaceExisting()}
          onSaveNewVersion={() => void handleSaveNewVersion()}
          saving={savingWlm}
          error={dialogError}
        />
      )}
    </div>
  );
}
