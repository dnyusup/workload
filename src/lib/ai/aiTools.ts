import type { AiToolDefinition } from '../../types/ai';
import type { ProductionSetup } from '../../types';
import type { ResolvedConstruction } from '../productionConstructionResolver';
import {
  computeSetupKpiMetrics,
  optimizeMachineAllocation,
  type OptimizationResult,
  type SetupKpiMetrics,
} from './aiOptimizer';

export const COPILOT_TOOLS: AiToolDefinition[] = [
  {
    name: 'get_current_setup_summary',
    description:
      'Retrieves the configuration summary of the currently active production setup (setup name, machine count, operator count, current OEE, MHPT, and Man Occupation).',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'diagnose_setup_performance',
    description:
      'Diagnoses operational bottlenecks for the current setup: largest downtime components (waiting for operator vs doffing vs repairs), operator workload distribution, and MHPT labor efficiency.',
    parameters: {
      type: 'object',
      properties: {
        focusArea: {
          type: 'string',
          description: 'Focus area for diagnosis: "all", "oee", "mhpt", or "man_occupation"',
        },
      },
    },
  },
  {
    name: 'optimize_machine_assignments',
    description:
      'Calculates the optimal machine-to-operator assignments balancing high equipment OEE vs efficient labor MHPT. Generates Before vs After comparisons and ensures contiguous physical row allocations.',
    parameters: {
      type: 'object',
      properties: {
        targetManOcc: {
          type: 'number',
          description: 'Target average Man Occupation percentage (recommended 80 - 90, default 85%).',
        },
        minOperators: {
          type: 'number',
          description: 'Minimum number of operators to evaluate.',
        },
        maxOperators: {
          type: 'number',
          description: 'Maximum number of operators to evaluate.',
        },
      },
    },
  },
  {
    name: 'apply_proposed_assignment',
    description:
      'Applies the proposed machine-to-operator allocation directly to the active setup in the application.',
    parameters: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Confirmation to apply allocation (must be true).',
        },
      },
      required: ['confirm'],
    },
  },
];

export interface CopilotToolContext {
  setup: ProductionSetup | null;
  resolvedConstructions: Map<string, ResolvedConstruction>;
  onApplyAssignments?: (result: OptimizationResult) => Promise<void> | void;
  lastOptimizationResult?: OptimizationResult | null;
  setLastOptimizationResult?: (result: OptimizationResult | null) => void;
}

export async function executeCopilotTool(
  name: string,
  args: Record<string, unknown>,
  ctx: CopilotToolContext,
): Promise<{ result: unknown; isError?: boolean }> {
  const { setup, resolvedConstructions } = ctx;

  if (!setup) {
    return {
      result: {
        error: 'No active production setup is currently open. Please open a Production Setup first.',
      },
      isError: true,
    };
  }

  switch (name) {
    case 'get_current_setup_summary': {
      const metrics: SetupKpiMetrics = computeSetupKpiMetrics(setup, resolvedConstructions);
      return {
        result: {
          setupId: setup.id,
          setupName: setup.name,
          shiftMinutes: setup.shiftTime,
          machineCount: metrics.machineCount,
          operatorCount: metrics.operatorCount,
          oee: `${metrics.oee}%`,
          availability: `${metrics.availability}%`,
          mhptTotal: `${metrics.mhptTotal} h/ton`,
          mhptFp: `${metrics.mhptFp} h/ton`,
          totalTon: `${metrics.totalTon} ton`,
          fpTon: `${metrics.fpTon} ton`,
          avgManOcc: `${metrics.avgManOcc}%`,
          manOccRange: `${metrics.minManOcc}% - ${metrics.maxManOcc}%`,
          waitingDowntimeShare: `${metrics.waitingPercent}%`,
        },
      };
    }

    case 'diagnose_setup_performance': {
      const metrics = computeSetupKpiMetrics(setup, resolvedConstructions);
      const diagnostics: string[] = [];

      // Analyze OEE & Waiting
      if (metrics.waitingPercent > 12) {
        diagnostics.push(
          `⚠️ Machine Queue Bottleneck: Machines lose ${metrics.waitingPercent}% running time waiting for operator attention, reducing actual OEE to ${metrics.oee}%.`,
        );
      } else {
        diagnostics.push(
          `✓ Good Machine Utilization: Operator wait time is only ${metrics.waitingPercent}%, OEE maintained at ${metrics.oee}%.`,
        );
      }

      // Analyze MHPT & Labor efficiency
      if (metrics.avgManOcc < 70) {
        diagnostics.push(
          `⚠️ Labor Cost Inefficiency: Average operator occupation is only ${metrics.avgManOcc}%. MHPT is high (${metrics.mhptTotal} h/ton) due to excess operators. Operator count can be streamlined.`,
        );
      } else if (metrics.avgManOcc > 92) {
        diagnostics.push(
          `⚠️ Operator Overload: Operator workload is very high at ${metrics.avgManOcc}%. High risk of fatigue and delayed doffing/repairs.`,
        );
      } else {
        diagnostics.push(
          `✓ Balanced Operator Workload: Average occupation is ${metrics.avgManOcc}%, within the ideal range (80% - 90%).`,
        );
      }

      // Analyze Imbalance
      const spread = Number((metrics.maxManOcc - metrics.minManOcc).toFixed(1));
      if (spread > 20) {
        diagnostics.push(
          `⚠️ Operator Workload Imbalance: Gap between busiest operator (${metrics.maxManOcc}%) and lowest (${metrics.minManOcc}%) is ${spread}%. Rebalancing is recommended.`,
        );
      }

      return {
        result: {
          setupName: setup.name,
          currentKpis: metrics,
          findings: diagnostics,
          recommendation:
            'Use the "optimize_machine_assignments" tool to calculate machine-to-operator assignments with the best OEE vs MHPT balance.',
        },
      };
    }

    case 'optimize_machine_assignments': {
      const targetManOcc = typeof args.targetManOcc === 'number' ? args.targetManOcc : 85;
      const minOperators = typeof args.minOperators === 'number' ? args.minOperators : undefined;
      const maxOperators = typeof args.maxOperators === 'number' ? args.maxOperators : undefined;

      const optResult = optimizeMachineAllocation({
        setup,
        resolved: resolvedConstructions,
        targetManOcc,
        minOperators,
        maxOperators,
      });

      if (ctx.setLastOptimizationResult) {
        ctx.setLastOptimizationResult(optResult);
      }

      return {
        result: {
          summary: optResult.tradeoffSummary,
          before: {
            operators: optResult.currentMetrics.operatorCount,
            oee: `${optResult.currentMetrics.oee}%`,
            mhptTotal: `${optResult.currentMetrics.mhptTotal} h/ton`,
            totalTon: `${optResult.currentMetrics.totalTon} ton`,
            avgManOcc: `${optResult.currentMetrics.avgManOcc}%`,
            spread: `${(optResult.currentMetrics.maxManOcc - optResult.currentMetrics.minManOcc).toFixed(1)}%`,
          },
          recommended: {
            operators: optResult.recommendedOperatorCount,
            oee: `${optResult.bestMetrics.oee}%`,
            mhptTotal: `${optResult.bestMetrics.mhptTotal} h/ton`,
            totalTon: `${optResult.bestMetrics.totalTon} ton`,
            avgManOcc: `${optResult.bestMetrics.avgManOcc}%`,
            spread: `${(optResult.bestMetrics.maxManOcc - optResult.bestMetrics.minManOcc).toFixed(1)}%`,
          },
          alternativeScenarios: optResult.alternativeScenarios,
          promptUser:
            'Ask the user whether they would like to apply this machine allocation to the setup now.',
        },
      };
    }

    case 'apply_proposed_assignment': {
      const confirm = Boolean(args.confirm);
      if (!confirm) {
        return {
          result: { error: 'Confirmation not given. Set confirm: true to apply allocation.' },
          isError: true,
        };
      }

      if (!ctx.lastOptimizationResult) {
        return {
          result: {
            error:
              'No optimization calculation found. Please run "optimize_machine_assignments" first before applying.',
          },
          isError: true,
        };
      }

      if (ctx.onApplyAssignments) {
        await ctx.onApplyAssignments(ctx.lastOptimizationResult);
        return {
          result: {
            success: true,
            message: `Machine allocation successfully applied to setup "${setup.name}" with ${ctx.lastOptimizationResult.recommendedOperatorCount} operators!`,
          },
        };
      }

      return {
        result: {
          error: 'Application handler not available in the current view.',
        },
        isError: true,
      };
    }

    default:
      return {
        result: { error: `Tool "${name}" is not recognized.` },
        isError: true,
      };
  }
}
