import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppConfig, SimulationState } from '../types';
import { SimulationEngine } from '../lib/simulationEngine';

export function useSimulation(config: AppConfig) {
  const engineRef = useRef<SimulationEngine>(new SimulationEngine(config));
  const [state, setState] = useState<SimulationState>(() => new SimulationEngine(config).getState());
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    engineRef.current = new SimulationEngine(config);
    setState(engineRef.current.getState());
    setPlaying(false);
    lastTsRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  useEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  useEffect(() => {
    if (!playing) {
      lastTsRef.current = null;
      return;
    }

    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const wallDeltaSec = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      const simDeltaMin = wallDeltaSec * speed * 2; // 2 sim-minutes per real second at 1x
      engineRef.current.tick(simDeltaMin);
      const next = engineRef.current.getState();
      setState(next);
      if (!next.finished) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        setPlaying(false);
      }
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, speed]);

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
