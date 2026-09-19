import type { AppConfig } from './types';
import { useSimulation } from './hooks/useSimulation';
import { LayoutCanvas } from './components/simulation/LayoutCanvas';
import { Dashboard } from './components/simulation/Dashboard';
import { Controls } from './components/simulation/Controls';

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

  return (
    <div className="simulation-view">
      <Controls
        playing={playing}
        speed={speed}
        onPlay={controls.play}
        onPause={controls.pause}
        onReset={controls.reset}
        onSpeedChange={controls.setSpeed}
        onBack={onBack}
        finished={state.finished}
        config={config}
        setConfig={setConfig}
        liveSettingsDisabled={playing || state.metrics.clockMin > 0}
        elapsedMinutes={state.metrics.clockMin}
        totalMinutes={state.metrics.shiftTimeMin}
        availableMinutes={state.metrics.availableTimeMin}
        breakMessage={
          state.operator.phase === 'break'
            ? `☕ Operator is on ${state.operator.breakLabel} — ${Math.ceil(state.operator.breakRemainingMin)} minutes remaining`
            : undefined
        }
      />
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
              onReset={controls.reset}
              onSpeedChange={controls.setSpeed}
              onBack={onBack}
              finished={state.finished}
              config={config}
              setConfig={setConfig}
              liveSettingsDisabled={playing || state.metrics.clockMin > 0}
              elapsedMinutes={state.metrics.clockMin}
              totalMinutes={state.metrics.shiftTimeMin}
              availableMinutes={state.metrics.availableTimeMin}
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
