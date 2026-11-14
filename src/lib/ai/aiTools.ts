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
      'Mendapatkan ringkasan konfigurasi setup yang sedang dibuka di layar (nama setup, jumlah mesin, operator, OEE saat ini, MHPT, dan Man Occupation).',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'diagnose_setup_performance',
    description:
      'Mendiagnosa bottleneck operasional dari setup saat ini: porsi downtime terbesar (menunggu operator vs doffing vs repairing), keseimbangan beban antar operator, dan inefisiensi MHPT.',
    parameters: {
      type: 'object',
      properties: {
        focusArea: {
          type: 'string',
          description: 'Area fokus diagnosa: "all", "oee", "mhpt", atau "man_occupation"',
        },
      },
    },
  },
  {
    name: 'optimize_machine_assignments',
    description:
      'Mencari pembagian mesin ke operator yang paling optimum dengan menyeimbangkan OEE tinggi vs MHPT efisien. Menghasilkan perbandingan Before vs After serta alokasi mesin yang berdampingan (kontigu).',
    parameters: {
      type: 'object',
      properties: {
        targetManOcc: {
          type: 'number',
          description: 'Target rata-rata Man Occupation (rekomendasi 80 - 90, default 85%).',
        },
        minOperators: {
          type: 'number',
          description: 'Batas minimal jumlah operator yang ingin diuji.',
        },
        maxOperators: {
          type: 'number',
          description: 'Batas maksimal jumlah operator yang ingin diuji.',
        },
      },
    },
  },
  {
    name: 'apply_proposed_assignment',
    description:
      'Menerapkan alokasi mesin ke operator hasil optimasi langsung ke setup aktif di aplikasi.',
    parameters: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Konfirmasi apakah yakin ingin menerapkan alokasi ini (harus true).',
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
        error: 'Tidak ada setup produksi aktif yang sedang dibuka. Buka menu Production Setup terlebih dahulu.',
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
          `⚠️ Bottleneck Antrian Mesin: Mesin kehilangan ${metrics.waitingPercent}% waktu berjalan karena harus antri menunggu operator. Ini menurunkan OEE aktual ke ${metrics.oee}%.`,
        );
      } else {
        diagnostics.push(
          `✓ Utilisasi Mesin Baik: Waktu tunggu operator hanya ${metrics.waitingPercent}%, OEE terjaga di ${metrics.oee}%.`,
        );
      }

      // Analyze MHPT & Labor efficiency
      if (metrics.avgManOcc < 70) {
        diagnostics.push(
          `⚠️ Inefisiensi Biaya Tenaga Kerja: Rata-rata kesibukan operator hanya ${metrics.avgManOcc}%. MHPT tinggi (${metrics.mhptTotal} h/ton) karena terlalu banyak operator untuk jumlah mesin saat ini. Jumlah operator dapat dirampingkan.`,
        );
      } else if (metrics.avgManOcc > 92) {
        diagnostics.push(
          `⚠️ Operator Overload: Kesibukan operator sangat tinggi di ${metrics.avgManOcc}%. Risiko kelelahan dan keterlambatan doffing/perbaikan sangat besar.`,
        );
      } else {
        diagnostics.push(
          `✓ Beban Operator Seimbang: Rata-rata kesibukan ${metrics.avgManOcc}%, masuk dalam rentang ideal (80% - 90%).`,
        );
      }

      // Analyze Imbalance
      const spread = Number((metrics.maxManOcc - metrics.minManOcc).toFixed(1));
      if (spread > 20) {
        diagnostics.push(
          `⚠️ Ketimpangan Beban Operator: Selisih beban antara operator tersibuk (${metrics.maxManOcc}%) dan terendah (${metrics.minManOcc}%) mencapai ${spread}%. Perlu pemerataan alokasi mesin.`,
        );
      }

      return {
        result: {
          setupName: setup.name,
          currentKpis: metrics,
          findings: diagnostics,
          recommendation:
            'Gunakan tool "optimize_machine_assignments" untuk menghitung alokasi pembagian mesin yang paling seimbang antara OEE dan MHPT.',
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
            'Tanyakan kepada user apakah ingin langsung menerapkan (apply) alokasi mesin ini ke setup sekarang.',
        },
      };
    }

    case 'apply_proposed_assignment': {
      const confirm = Boolean(args.confirm);
      if (!confirm) {
        return {
          result: { error: 'Konfirmasi belum diberikan. Set confirm: true untuk menerapkan alokasi.' },
          isError: true,
        };
      }

      if (!ctx.lastOptimizationResult) {
        return {
          result: {
            error:
              'Belum ada hasil optimasi yang dihitung. Jalankan "optimize_machine_assignments" terlebih dahulu sebelum menerapkan.',
          },
          isError: true,
        };
      }

      if (ctx.onApplyAssignments) {
        await ctx.onApplyAssignments(ctx.lastOptimizationResult);
        return {
          result: {
            success: true,
            message: `Alokasi mesin berhasil diterapkan ke setup "${setup.name}" dengan ${ctx.lastOptimizationResult.recommendedOperatorCount} operator!`,
          },
        };
      }

      return {
        result: {
          error: 'Handler penerapan alokasi tidak tersedia di tampilan saat ini.',
        },
        isError: true,
      };
    }

    default:
      return {
        result: { error: `Tool "${name}" tidak dikenali.` },
        isError: true,
      };
  }
}
