import type { AiToolDefinition } from '../../types/ai';
import type { ProductionSetup } from '../../types';
import type { ResolvedConstruction } from '../productionConstructionResolver';
import type { AuthUser } from '../../context/auth';
import type { AiSimulationMetrics } from './aiContextStore';
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
    name: 'get_current_simulation_results',
    description:
      'Retrieves live output metrics from the current simulation run or replay (elapsed shift clock, equipment OEE, availability, quality, total tonnage FP/SFP, labor MHPT, operator timeline activity percentages, and top downtime causes).',
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
  {
    name: 'navigate_to_page',
    description:
      'Navigates the user directly to a specific page or menu in the WorkLoad application (e.g. "production", "layouts", "frequency", "actualOutput", "rejectShort", "products", "activities", "settings", "guidance").',
    parameters: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          enum: [
            'production',
            'simulator',
            'layouts',
            'products',
            'activities',
            'frequency',
            'actualOutput',
            'rejectShort',
            'outputModels',
            'users',
            'settings',
            'guidance',
          ],
          description: 'The target page to navigate to.',
        },
        reason: {
          type: 'string',
          description: 'Brief reason or explanation why we are navigating to this page.',
        },
      },
      required: ['page'],
    },
  },
];

export interface CopilotToolContext {
  user?: AuthUser;
  setup: ProductionSetup | null;
  resolvedConstructions: Map<string, ResolvedConstruction>;
  simulationMetrics?: AiSimulationMetrics | null;
  onApplyAssignments?: (
    result: OptimizationResult,
    onProgress?: (phase: string, done: number, total: number) => void,
  ) => Promise<void> | void;
  lastOptimizationResult?: OptimizationResult | null;
  setLastOptimizationResult?: (result: OptimizationResult | null) => void;
  onProgress?: (status: string) => void;
  onNavigate?: (page: string) => void;
}

export async function executeCopilotTool(
  name: string,
  args: Record<string, unknown>,
  ctx: CopilotToolContext,
): Promise<{ result: unknown; isError?: boolean }> {
  // Navigation tool does not require an active setup
  if (name === 'navigate_to_page') {
    const targetPage = String(args.page || '').trim();
    if (ctx.onNavigate && targetPage) {
      ctx.onNavigate(targetPage);
      return {
        result: {
          success: true,
          navigatedTo: targetPage,
          message: `Berhasil berpindah ke halaman ${targetPage}. ${args.reason ? `(${args.reason})` : ''}`,
        },
      };
    }
    return {
      result: {
        success: false,
        error: `Fungsi navigasi tidak tersedia untuk halaman: ${targetPage}`,
      },
      isError: true,
    };
  }

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
    case 'get_current_simulation_results': {
      if (!ctx.simulationMetrics) {
        return {
          result: {
            setupName: setup.name,
            status: 'Simulation has not been played or is not currently loaded on screen.',
            hint: 'To view live simulation metrics, play or load a simulation run/replay on the Production Simulation page.',
          },
        };
      }
      const sm = ctx.simulationMetrics;
      return {
        result: {
          setupName: setup.name,
          simulationStatus: sm.clockFormatted,
          isShiftComplete: sm.isComplete,
          machineCount: sm.machineCount,
          operatorCount: sm.operatorCount,
          equipmentOee: `${sm.oee}%`,
          availability: `${sm.availability}%`,
          quality: `${sm.quality}%`,
          totalOutput: `${sm.tonageTotal} ton`,
          finishProductTon: `${sm.tonageFp} ton`,
          semiFinishProductTon: `${sm.tonageSfp} ton`,
          laborMhpt: `${sm.manHourPerTon} h/ton`,
          totalDowntimeMinutes: sm.totalDowntimeMin,
          waitingHandlingDowntime: `${sm.waitingHandlingPercent}% (${sm.waitingHandlingMinutes} min machine waiting for operator)`,
          topMachineDowntimeCauses: sm.topDowntimeReasons.slice(0, 5).map((d) => `${d.reason}: ${d.minutes} min`),
          overallTimelineActivities: sm.activityBreakdown.map((a) => `${a.activity}: ${a.percent}%`),
          actualManOccupationPerOperator: sm.operatorMetrics.map((op) => ({
            operator: op.operatorLabel,
            actualManOccupation: `${op.actualManOccupation}%`,
            working: `${op.workingPercent}% (${op.serviceMinutes} min)`,
            walking: `${op.walkingPercent}% (${op.walkingMinutes} min)`,
            idle: `${op.idlePercent}% (${op.idleMinutes} min)`,
            machinesHandled: op.machineCount,
            assignedMachines: op.assignedMachines.join(', '),
          })),
        },
      };
    }
    case 'get_current_setup_summary': {
      const metrics: SetupKpiMetrics = computeSetupKpiMetrics(setup, resolvedConstructions);
      return {
        result: {
          setupId: setup.id,
          setupName: setup.name,
          shiftMinutes: setup.shiftTime,
          machineCount: metrics.machineCount,
          operatorCount: metrics.operatorCount,
          oeeEstimate: `${metrics.oee}%`,
          availabilityEstimate: `${metrics.availability}%`,
          mhptTotal: `${metrics.mhptTotal} h/ton`,
          mhptFp: `${metrics.mhptFp} h/ton`,
          totalTon: `${metrics.totalTon} ton`,
          fpTon: `${metrics.fpTon} ton`,
          forecastManOccupation: {
            average: `${metrics.avgManOcc}%`,
            range: `${metrics.minManOcc}% - ${metrics.maxManOcc}%`,
            operatorBreakdown: metrics.operatorBreakdown.map((op) => ({
              operator: op.operatorLabel,
              forecastManOcc: `${op.manOccPercent}%`,
              machineCount: op.machineCount,
            })),
          },
          waitingDowntimeShareEstimate: `${metrics.waitingPercent}%`,
        },
      };
    }

    case 'diagnose_setup_performance': {
      const metrics = computeSetupKpiMetrics(setup, resolvedConstructions);
      const diagnostics: string[] = [];

      // Check if actual simulation data is available on screen
      if (ctx.simulationMetrics && ctx.simulationMetrics.operatorMetrics?.length > 0) {
        const sm = ctx.simulationMetrics;
        diagnostics.push(
          `📊 Live Simulation Results: Equipment OEE is ${sm.oee}%, Total Output: ${sm.tonageTotal} ton, Labor MHPT: ${sm.manHourPerTon} h/ton.`,
        );

        if (sm.waitingHandlingPercent > 10) {
          diagnostics.push(
            `⚠️ High Machine Waiting Handling: Machines lost ${sm.waitingHandlingPercent}% time (${sm.waitingHandlingMinutes} min) stopped waiting for operators. Operator response time or travel distance is a bottleneck.`,
          );
        }

        sm.operatorMetrics.forEach((op) => {
          if (op.actualManOccupation < 70) {
            diagnostics.push(
              `⚠️ Operator ${op.operatorLabel} Underutilized: Actual Man Occupation is only ${op.actualManOccupation}% (idle ${op.idlePercent}%). Operator has capacity for more machines.`,
            );
          } else if (op.actualManOccupation > 92) {
            diagnostics.push(
              `⚠️ Operator ${op.operatorLabel} Overloaded: Actual Man Occupation is ${op.actualManOccupation}% (walking ${op.walkingPercent}%). High risk of doffing delays.`,
            );
          }
        });
      } else {
        // Fall back to pre-simulation forecast metrics
        if (metrics.waitingPercent > 12) {
          diagnostics.push(
            `⚠️ Machine Queue Bottleneck (Forecast): Machines estimated to lose ${metrics.waitingPercent}% running time waiting for operator attention, reducing OEE to ${metrics.oee}%.`,
          );
        } else {
          diagnostics.push(
            `✓ Good Machine Utilization (Forecast): Operator wait time is estimated at ${metrics.waitingPercent}%, OEE maintained at ${metrics.oee}%.`,
          );
        }

        if (metrics.avgManOcc < 70) {
          diagnostics.push(
            `⚠️ Labor Cost Inefficiency: Average Forecast Man Occupation is only ${metrics.avgManOcc}%. MHPT is high (${metrics.mhptTotal} h/ton). Operator count can be streamlined.`,
          );
        } else if (metrics.avgManOcc > 92) {
          diagnostics.push(
            `⚠️ Operator Overload: Forecast workload is very high at ${metrics.avgManOcc}%. Risk of fatigue.`,
          );
        } else {
          diagnostics.push(
            `✓ Balanced Operator Workload: Average Forecast Man Occupation is ${metrics.avgManOcc}%, within the ideal range (80% - 90%).`,
          );
        }
      }

      // Analyze Workload Imbalance
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

      const optResult = await optimizeMachineAllocation({
        setup,
        resolved: resolvedConstructions,
        targetManOcc,
        minOperators,
        maxOperators,
        onProgress: ctx.onProgress,
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

      // Security & Authorization Guard: Contribute users cannot modify setups they do not own or have edit rights for
      if (ctx.user && ctx.user.role !== 'admin') {
        const userEmail = (ctx.user.email ?? '').trim().toLowerCase();
        const isOwner = (setup.createdByEmail ?? '').trim().toLowerCase() === userEmail;
        const isShared = (setup.sharedEmail ?? '').toLowerCase().includes(userEmail);
        if (!isOwner && !isShared) {
          return {
            result: {
              error: `Permission denied: Your account (${ctx.user.email}) has Contribute access and is not the owner or authorized editor of setup "${setup.name}". Modifying other users' setups or master data requires Admin privileges.`,
            },
            isError: true,
          };
        }
      }

      if (ctx.onApplyAssignments) {
        if (ctx.onProgress) {
          ctx.onProgress('Applying machine allocation…');
        }
        await ctx.onApplyAssignments(ctx.lastOptimizationResult, (phase, done, total) => {
          if (ctx.onProgress) {
            ctx.onProgress(`⚙️ ${phase} (${done}/${total})`);
          }
        });
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
