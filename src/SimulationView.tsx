import { useState } from 'react';
import type { AppConfig } from './types';
import { useSimulation } from './hooks/useSimulation';
import { LayoutCanvas } from './components/simulation/LayoutCanvas';
import { Dashboard } from './components/simulation/Dashboard';
import { Controls } from './components/simulation/Controls';
import { useAuth } from './context/AuthContext';
import { saveSimulationOutputModel } from './lib/outputModel';

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

  const handleSaveWlm = async () => {
    if (savingWlm || savedWlm) return;
    setSavingWlm(true);
    setSaveWlmError(null);
    try {
      await saveSimulationOutputModel(config, state, user.email);
      setSavedWlm(true);
    } catch (err) {
      setSaveWlmError(err instanceof Error ? err.message : 'Failed to save WLM output model.');
    } finally {
      setSavingWlm(false);
    }
  };

  const handleConfigChange = (updater: (prev: AppConfig) => AppConfig) => {
    setSavedWlm(false);
    setSaveWlmError(null);
    setConfig(updater);
  };

  const handleReset = () => {
    setSavedWlm(false);
    setSaveWlmError(null);
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
        savingWlm={savingWlm}
        savedWlm={savedWlm}
        breakMessage={
          state.operator.phase === 'break'
            ? `☕ Operator is on ${state.operator.breakLabel} — ${Math.ceil(state.operator.breakRemainingMin)} minutes remaining`
            : undefined
        }
      />
      {saveWlmError && <p className="simulation-save-error" role="alert">{saveWlmError}</p>}
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
              savingWlm={savingWlm}
              savedWlm={savedWlm}
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
    </div>
  );
}
