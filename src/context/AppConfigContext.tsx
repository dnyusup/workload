import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { AppConfig } from '../types';
import { AppConfigContext } from './appConfig';
import { defaultActivities, deriveMachineSpec, ensureCoreActivities } from '../lib/calculations';
import { generatePairedGrid } from '../lib/gridLayout';

const STORAGE_KEY = 'workload-sim-config-v1';

const defaultSpec = {
  area: '',
  layLength: 12,
  noOfWires: 1,
  speed: 6000,
  spoolLength: 8000,
  linearDensity: 1.17,
  fracturePerTon: 2,
  diesPerTon: 0,
  defectsPerTon: 0,
};

function defaultLayout() {
  const layout = generatePairedGrid(2, 10, 60, 60);
  const last = layout[layout.length - 1];
  if (last) last.type = 'bfx';
  return layout;
}

function defaultConfig(): AppConfig {
  const derived = deriveMachineSpec(defaultSpec);
  const layout = defaultLayout();
  return {
    spec: defaultSpec,
    operator: {
      machHandled: 20,
      shiftTime: 480,
      lunchTime: 30,
      lunchStartAt: 240,
      meetingTime: 15,
      meetingStartAt: 420,
      taskPriority: 'quickest',
    },
    activities: defaultActivities(derived.spoolWeight, defaultSpec.fracturePerTon),
    movement: { walkingSpeed: 60, pixelsPerMeter: 20 },
    layout,
    assignedMachineIds: layout.slice(0, 20).map((m) => m.id),
  };
}

function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppConfig;
      // Backfill fields added after this config may have been saved.
      parsed.layout = (parsed.layout ?? []).map((m) => ({
        ...m,
        orientation: m.orientation ?? 'normal',
        pairSide: m.pairSide ?? 'single',
      }));
      parsed.operator = {
        ...parsed.operator,
        lunchStartAt: parsed.operator?.lunchStartAt ?? 240,
        meetingStartAt: parsed.operator?.meetingStartAt ?? 420,
        taskPriority: parsed.operator?.taskPriority ?? 'quickest',
      };
      parsed.spec = { ...defaultSpec, ...parsed.spec, area: parsed.spec?.area ?? '' };
      // Configs saved before explicit machine assignment existed relied on "first N machines in
      // layout order" — preserve that as the initial assignment so they keep running exactly as
      // before, instead of suddenly losing their assignment and failing the new Start validation.
      const layoutIds = new Set(parsed.layout.map((m) => m.id));
      const validAssigned = (parsed.assignedMachineIds ?? []).filter((id) => layoutIds.has(id));
      parsed.assignedMachineIds =
        parsed.assignedMachineIds === undefined
          ? parsed.layout.slice(0, Math.max(0, Math.floor(parsed.operator.machHandled))).map((m) => m.id)
          : validAssigned;
      const restoredActivities = (parsed.activities ?? []).map((a) => ({
        ...a,
        numeratorAuto: a.numeratorAuto ?? a.key === 'fractureRepairing',
        machCondition: a.machCondition ?? 'stop',
      }));
      // Doffing/Loading/Fracture Repairing are core activities the sim depends on — restore any
      // that were previously removed (e.g. from before removal was blocked in the UI) instead of
      // leaving the config permanently missing them.
      const derived = deriveMachineSpec(parsed.spec ?? defaultSpec);
      parsed.activities = ensureCoreActivities(
        restoredActivities,
        derived.spoolWeight,
        parsed.spec?.fracturePerTon ?? defaultSpec.fracturePerTon,
      );
      return parsed;
    }
  } catch {
    // ignore corrupt storage
  }
  return defaultConfig();
}

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<AppConfig>(() => loadConfig());

  const setConfig = useCallback((updater: (prev: AppConfig) => AppConfig) => {
    setConfigState((prev) => {
      const next = updater(prev);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore quota errors
      }
      return next;
    });
  }, []);

  const resetToDefault = useCallback(() => setConfig(() => defaultConfig()), [setConfig]);

  const value = useMemo(() => ({ config, setConfig, resetToDefault }), [config, setConfig, resetToDefault]);

  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}
