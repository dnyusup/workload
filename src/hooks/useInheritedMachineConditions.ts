import { useEffect, useMemo, useState } from 'react';
import type { Mpp_wl_outputmodelses } from '../generated/models/Mpp_wl_outputmodelsesModel';
import { findOutputModelsForConstruction, outputModelVersionNumber } from '../lib/outputModel';
import { randomSeed } from '../lib/rng';
import type { InheritedSimulationSnapshot } from '../types';

/** Parses mpp_startmachcondition. Newer rows store an InheritedSimulationSnapshot (seed, layout,
 * walls, remarks, operatorStart, conditions); rows saved before that snapshot existed store a bare
 * MachineStartCondition[] — those fall back to no layout override and a fresh random seed, same as
 * the old inherited-conditions-only behavior. */
export function parseMachineStartConditions(value: string | undefined): InheritedSimulationSnapshot {
  const parsed = JSON.parse(value ?? '') as unknown;
  const conditions = Array.isArray(parsed)
    ? parsed
    : (parsed as InheritedSimulationSnapshot | null)?.conditions;
  if (!Array.isArray(conditions) || conditions.some((condition) => !condition?.machineId)) {
    throw new Error('The selected inherited machine condition is invalid.');
  }
  if (Array.isArray(parsed)) {
    return { seed: randomSeed(), layout: [], conditions };
  }
  const snapshot = parsed as InheritedSimulationSnapshot;
  return {
    seed: typeof snapshot.seed === 'number' ? snapshot.seed : randomSeed(),
    layout: Array.isArray(snapshot.layout) ? snapshot.layout : [],
    walls: Array.isArray(snapshot.walls) ? snapshot.walls : undefined,
    remarks: Array.isArray(snapshot.remarks) ? snapshot.remarks : undefined,
    operatorStart: snapshot.operatorStart,
    conditions,
  };
}

export function useInheritedMachineConditions(constructionDetail?: string) {
  const [rows, setRows] = useState<Mpp_wl_outputmodelses[]>([]);
  const [loadedConstructionDetail, setLoadedConstructionDetail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedDetail = constructionDetail?.trim() ?? '';

  useEffect(() => {
    if (!normalizedDetail) return;
    let cancelled = false;
    // This effect synchronizes the UI with the external Dataverse query lifecycle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    findOutputModelsForConstruction(normalizedDetail)
      .then((outputModels) => {
        if (cancelled) return;
        const rowsWithConditions = outputModels
          .filter((row) => row.mpp_startmachcondition?.trim())
          .sort(
            (left, right) =>
              outputModelVersionNumber(right.mpp_version) - outputModelVersionNumber(left.mpp_version),
          );
        setRows(rowsWithConditions);
        setLoadedConstructionDetail(normalizedDetail);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setRows([]);
        setLoadedConstructionDetail(normalizedDetail);
        setError(err instanceof Error ? err.message : 'Failed to load inherited machine conditions.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [normalizedDetail]);

  const availableRows = useMemo(
    () => (loadedConstructionDetail === normalizedDetail ? rows : []),
    [loadedConstructionDetail, normalizedDetail, rows],
  );

  return {
    rows: availableRows,
    loading: loading && Boolean(normalizedDetail),
    error: loadedConstructionDetail === normalizedDetail ? error : null,
  };
}
