import type { ProductionSetup } from '../../types';
import type { ResolvedConstruction } from '../productionConstructionResolver';
import type { OptimizationResult } from './aiOptimizer';

export interface AiOperatorSimulationMetric {
  operatorId: string;
  operatorLabel: string;
  actualManOccupation: number;
  workingPercent: number;
  walkingPercent: number;
  idlePercent: number;
  serviceMinutes: number;
  walkingMinutes: number;
  idleMinutes: number;
  machineCount: number;
  assignedMachines: string[];
}

export interface AiSimulationMetrics {
  clockMin: number;
  shiftTimeMin: number;
  clockFormatted: string;
  isComplete: boolean;
  machineCount: number;
  operatorCount: number;
  oee: number;
  availability: number;
  quality: number;
  tonageTotal: number;
  tonageFp: number;
  tonageSfp: number;
  manHourPerTon: number;
  totalDowntimeMin: number;
  waitingHandlingMinutes: number;
  waitingHandlingPercent: number;
  activityBreakdown: Array<{ activity: string; percent: number }>;
  topDowntimeReasons: Array<{ reason: string; minutes: number }>;
  operatorMetrics: AiOperatorSimulationMetric[];
}

export interface AiAppContext {
  currentPage?: string;
  setup: ProductionSetup | null;
  resolvedConstructions: Map<string, ResolvedConstruction>;
  simulationMetrics?: AiSimulationMetrics | null;
  onApplyAssignments?: (
    result: OptimizationResult,
    onProgress?: (phase: string, done: number, total: number) => void,
  ) => Promise<void> | void;
  lastOptimizationResult?: OptimizationResult | null;
  onNavigate?: (page: string) => void;
}

type Listener = (context: AiAppContext) => void;

let currentContext: AiAppContext = {
  currentPage: 'Production Setup',
  setup: null,
  resolvedConstructions: new Map(),
  simulationMetrics: null,
  lastOptimizationResult: null,
};

const listeners = new Set<Listener>();

export function setAiAppContext(partial: Partial<AiAppContext>): void {
  currentContext = { ...currentContext, ...partial };
  listeners.forEach((listener) => {
    try {
      listener(currentContext);
    } catch (err) {
      console.error('[AI Context] Listener error:', err);
    }
  });
}

export function getAiAppContext(): AiAppContext {
  return currentContext;
}

export function subscribeAiAppContext(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
