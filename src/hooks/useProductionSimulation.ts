import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProductionSetup, ProductionSimulationState } from '../types';
import { ProductionSimulationEngine } from '../lib/productionSimulationEngine';
import type { ResolvedConstruction } from '../lib/productionConstructionResolver';

/** Caps how often the engine snapshot is pushed into React state (and so how often the canvas
 * re-renders every machine/operator). At real-factory scale (~1500 machines, ~80 operators) both
 * `engine.tick()` and `engine.getState()` (which shallow-copies every machine/operator) are
 * O(machines + operators) — running that plus a full SVG diff on every animation frame (~60/s) is
 * far more update-rate than the UI actually needs. Ticking the sim logic less often than the
 * display refresh rate doesn't lose accuracy: each call still advances by however much wall time
 * has actually elapsed since the last one. */
const STATE_UPDATE_INTERVAL_MS = 80;

/** Bigger setups re-render thousands of SVG nodes per snapshot, so they refresh the screen less
 * often. Simulation accuracy is unaffected — the engine still ticks every animation frame. */
function stateUpdateIntervalMs(machineCount: number): number {
  if (machineCount > 1000) return 250;
  if (machineCount > 400) return 150;
  return STATE_UPDATE_INTERVAL_MS;
}

export function useProductionSimulation(setup: ProductionSetup, resolved: Map<string, ResolvedConstruction>, resolveErrors: string[]) {
  const makeEngine = useCallback(
    () => new ProductionSimulationEngine(setup, resolved, resolveErrors),
    [setup, resolved, resolveErrors],
  );
  // Lazy useState so the engine is built once on mount — `useRef(makeEngine())` evaluated its
  // argument on EVERY render, constructing (and discarding) a whole engine each time the throttled
  // state update re-rendered, ~10ms apiece at ~1500 machines.
  const [initialEngine] = useState(makeEngine);
  const engineRef = useRef<ProductionSimulationEngine>(initialEngine);
  const [state, setState] = useState<ProductionSimulationState>(() => initialEngine.getState());
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const lastRenderTsRef = useRef<number | null>(null);
  const updateIntervalMs = stateUpdateIntervalMs(setup.layout.length);

  const reset = useCallback(() => {
    engineRef.current = makeEngine();
    setState(engineRef.current.getState());
    setPlaying(false);
    lastTsRef.current = null;
    lastRenderTsRef.current = null;
  }, [makeEngine]);

  useEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, resolved, resolveErrors]);

  useEffect(() => {
    if (!playing) {
      lastTsRef.current = null;
      return;
    }
    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const wallDeltaSec = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      const simDeltaMin = wallDeltaSec * speed * 2;
      engineRef.current.tick(simDeltaMin);
      // Ticking happens every frame (cheap — see the engine's O(machines+operators) sub-step
      // cost), but pushing a fresh snapshot into React is throttled: getState() copies every
      // machine/operator, and the canvas re-diffs all of them, so doing that on every single
      // animation frame is far more update-rate than the eye can use at real-factory scale.
      if (lastRenderTsRef.current == null || ts - lastRenderTsRef.current >= updateIntervalMs) {
        lastRenderTsRef.current = ts;
        const next = engineRef.current.getState();
        setState(next);
        if (next.finished) {
          setPlaying(false);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, speed, updateIntervalMs]);

  const controls = useMemo(
    () => ({
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
      reset,
      setSpeed,
    }),
    [reset],
  );

  return { state, playing, speed, controls };
}
