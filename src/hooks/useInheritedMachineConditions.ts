import { useEffect, useMemo, useState } from 'react';
import type { Mpp_wl_outputmodelses } from '../generated/models/Mpp_wl_outputmodelsesModel';
import { findOutputModelsForConstruction, outputModelVersionNumber } from '../lib/outputModel';
import type { MachineStartCondition } from '../types';

export function parseMachineStartConditions(value: string | undefined): MachineStartCondition[] {
  const conditions = JSON.parse(value ?? '') as MachineStartCondition[];
  if (!Array.isArray(conditions) || conditions.some((condition) => !condition.machineId)) {
    throw new Error('The selected inherited machine condition is invalid.');
  }
  return conditions;
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
