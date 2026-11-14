import type { ProductionSetup } from '../../types';
import type { ResolvedConstruction } from '../productionConstructionResolver';
import type { OptimizationResult } from './aiOptimizer';

export interface AiAppContext {
  setup: ProductionSetup | null;
  resolvedConstructions: Map<string, ResolvedConstruction>;
  onApplyAssignments?: (result: OptimizationResult) => Promise<void> | void;
  lastOptimizationResult?: OptimizationResult | null;
}

type Listener = (context: AiAppContext) => void;

let currentContext: AiAppContext = {
  setup: null,
  resolvedConstructions: new Map(),
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
