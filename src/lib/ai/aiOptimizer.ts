import type { ProductionMachineAssignment, ProductionOperator, ProductionSetup } from '../../types';
import { calculatePlannedUtilization } from '../productionUtilization';
import { summarizeProductionForecast } from '../productionForecastSummary';
import { computeAutoAssignPlan } from '../productionAutoAssign';
import type { ResolvedConstruction } from '../productionConstructionResolver';

export interface SetupKpiMetrics {
  oee: number;
  availability: number;
  mhptTotal: number;
  mhptFp: number;
  totalTon: number;
  fpTon: number;
  operatorCount: number;
  machineCount: number;
  netManhours: number;
  avgManOcc: number;
  minManOcc: number;
  maxManOcc: number;
  waitingPercent: number;
  operatorBreakdown: Array<{
    operatorId: string;
    operatorLabel: string;
    machineCount: number;
    manOccPercent: number;
  }>;
}

export interface OptimizationResult {
  currentMetrics: SetupKpiMetrics;
  bestMetrics: SetupKpiMetrics;
  tradeoffSummary: string;
  recommendedOperatorCount: number;
  recommendedOperators: { id: string; label: string }[];
  recommendedAssignments: ProductionMachineAssignment[];
  alternativeScenarios: Array<{
    operatorCount: number;
    oee: number;
    mhptTotal: number;
    avgManOcc: number;
    description: string;
  }>;
}

/**
 * Computes exact KPI metrics for a ProductionSetup based on planned utilization
 * and full shift forecast summary.
 */
export function computeSetupKpiMetrics(
  setup: ProductionSetup,
  resolved: Map<string, ResolvedConstruction>,
): SetupKpiMetrics {
  const planned = calculatePlannedUtilization(setup, resolved);
  const forecast = summarizeProductionForecast(setup, resolved, planned);

  const netShiftMinutes = Math.max(1, setup.shiftTime - (setup.lunchTime ?? 0));
  const operatorCount = setup.operators.length;
  const netManhours = (operatorCount * netShiftMinutes) / 60;

  const totalTon = (forecast.grossTonKg ?? 0) / 1000;
  const fpTon = (forecast.fpGrossTonKg ?? 0) / 1000;

  const mhptTotal = totalTon > 0 ? Number((netManhours / totalTon).toFixed(2)) : 0;
  const mhptFp = fpTon > 0 ? Number((netManhours / fpTon).toFixed(2)) : 0;

  let totalOee = 0;
  let totalAvail = 0;
  const plannedMachines = planned.machines.filter((m) => m.availability > 0 || m.oee > 0);
  const machineCount = plannedMachines.length || setup.assignments.filter((a) => a.constructionDetailId).length || 1;

  planned.machines.forEach((m) => {
    totalOee += m.oee;
    totalAvail += m.availability;
  });

  const avgOee = plannedMachines.length > 0 ? (totalOee / plannedMachines.length) * 100 : 0;
  const avgAvail = plannedMachines.length > 0 ? (totalAvail / plannedMachines.length) * 100 : 0;

  const opBreakdown: Array<{
    operatorId: string;
    operatorLabel: string;
    machineCount: number;
    manOccPercent: number;
  }> = [];

  let sumManOcc = 0;
  let minOcc = 100;
  let maxOcc = 0;

  planned.operators.forEach((op) => {
    const occ = Number(op.forecastUtilizationPercent.toFixed(1));
    sumManOcc += occ;
    minOcc = Math.min(minOcc, occ);
    maxOcc = Math.max(maxOcc, occ);

    const mCount = setup.assignments.filter((a) => a.assignedOperatorIds?.includes(op.operatorId)).length;
    opBreakdown.push({
      operatorId: op.operatorId,
      operatorLabel: op.operatorLabel,
      machineCount: mCount,
      manOccPercent: occ,
    });
  });

  const avgManOcc = planned.operators.length > 0 ? Number((sumManOcc / planned.operators.length).toFixed(1)) : 0;
  const waitingPercent = avgAvail > 0 ? Math.max(0, Number((((avgAvail - avgOee) / avgAvail) * 100).toFixed(1))) : 0;

  return {
    oee: Number(avgOee.toFixed(1)),
    availability: Number(avgAvail.toFixed(1)),
    mhptTotal,
    mhptFp,
    totalTon: Number(totalTon.toFixed(2)),
    fpTon: Number(fpTon.toFixed(2)),
    operatorCount,
    machineCount,
    netManhours: Number(netManhours.toFixed(1)),
    avgManOcc,
    minManOcc: planned.operators.length > 0 ? Number(minOcc.toFixed(1)) : 0,
    maxManOcc: planned.operators.length > 0 ? Number(maxOcc.toFixed(1)) : 0,
    waitingPercent,
    operatorBreakdown: opBreakdown,
  };
}

/**
 * Calculates a multi-objective optimization score balancing OEE and MHPT:
 * - High OEE gives more tons
 * - Low MHPT means higher labor productivity (fewer operators per ton)
 * - Operator occupation should ideally stay in the safe zone (80% - 90%)
 * - Imbalance between operators is penalized
 */
function calculateParetoScore(metrics: SetupKpiMetrics, targetManOcc = 85): number {
  let score = 0;

  // Reward high OEE (base equipment efficiency)
  score += metrics.oee * 1.5;

  // Penalize high MHPT (labor inefficiency)
  score -= metrics.mhptTotal * 8.0;

  // Penalty for operator overload (>92% causes high risk of delays & machine starvation)
  if (metrics.avgManOcc > 90) {
    score -= (metrics.avgManOcc - 90) * 4.0;
  }
  if (metrics.maxManOcc > 98) {
    score -= (metrics.maxManOcc - 98) * 8.0;
  }

  // Penalty for operator under-utilization (<75% wastes labor hours)
  if (metrics.avgManOcc < targetManOcc - 10) {
    score -= (targetManOcc - 10 - metrics.avgManOcc) * 2.0;
  }

  // Penalty for workload imbalance (difference between max and min operator occupation)
  const imbalance = metrics.maxManOcc - metrics.minManOcc;
  score -= imbalance * 0.5;

  return score;
}

/**
 * Finds the optimum operator count and contiguous machine assignments
 * balancing OEE vs MHPT.
 */
export function optimizeMachineAllocation({
  setup,
  resolved,
  targetManOcc = 85,
  minOperators,
  maxOperators,
}: {
  setup: ProductionSetup;
  resolved: Map<string, ResolvedConstruction>;
  targetManOcc?: number;
  minOperators?: number;
  maxOperators?: number;
}): OptimizationResult {
  const currentMetrics = computeSetupKpiMetrics(setup, resolved);
  const plannedMachines = setup.assignments.filter((a) => a.constructionDetailId);

  if (plannedMachines.length === 0) {
    return {
      currentMetrics,
      bestMetrics: currentMetrics,
      tradeoffSummary: 'Setup tidak memiliki mesin yang terencana (Construction Detail kosong).',
      recommendedOperatorCount: setup.operators.length,
      recommendedOperators: setup.operators,
      recommendedAssignments: setup.assignments,
      alternativeScenarios: [],
    };
  }

  // Determine search space for operator counts
  const curCount = Math.max(1, setup.operators.length);
  const minCount = Math.max(1, minOperators ?? Math.max(1, curCount - 3));
  const maxCount = Math.max(minCount, maxOperators ?? Math.min(plannedMachines.length, curCount + 3));

  interface CandidateEvaluation {
    count: number;
    metrics: SetupKpiMetrics;
    score: number;
    operators: { id: string; label: string }[];
    assignments: ProductionMachineAssignment[];
  }

  const evaluations: CandidateEvaluation[] = [];

  for (let count = minCount; count <= maxCount; count++) {
    // Generate spatial assignment plan for this candidate count
    const plan = computeAutoAssignPlan({
      setup,
      options: {
        mode: 'multi',
        multiCount: count,
        onlyPlannedMachines: true,
      },
    });

    const candidateOperators: ProductionOperator[] = plan.operatorsToCreate.map((o, idx) => ({
      id: `ai-opr-${idx + 1}`,
      label: o.label,
    }));

    const operatorLabelToId = new Map(candidateOperators.map((o) => [o.label, o.id]));

    const candidateAssignments: ProductionMachineAssignment[] = setup.assignments.map((orig) => {
      const assigned = plan.machineAssignments.get(orig.machineId);
      if (!assigned) return orig;

      const rawLabels = assigned.assignedOperatorIds ?? [];
      const mappedIds = rawLabels.map((lbl) => operatorLabelToId.get(lbl) ?? lbl);

      return {
        ...orig,
        ...assigned,
        assignedOperatorIds: mappedIds,
      };
    });

    const candidateSetup: ProductionSetup = {
      ...setup,
      operators: candidateOperators,
      assignments: candidateAssignments,
    };

    const metrics = computeSetupKpiMetrics(candidateSetup, resolved);
    const score = calculateParetoScore(metrics, targetManOcc);

    evaluations.push({
      count,
      metrics,
      score,
      operators: candidateOperators,
      assignments: candidateAssignments,
    });
  }

  // Sort by Pareto score descending
  evaluations.sort((a, b) => b.score - a.score);
  const best = evaluations[0] ?? {
    count: curCount,
    metrics: currentMetrics,
    score: 0,
    operators: setup.operators,
    assignments: setup.assignments,
  };

  // Build trade-off explanation in Indonesian
  const deltaOee = Number((best.metrics.oee - currentMetrics.oee).toFixed(1));
  const deltaMhpt = Number((best.metrics.mhptTotal - currentMetrics.mhptTotal).toFixed(2));
  const deltaTon = Number((best.metrics.totalTon - currentMetrics.totalTon).toFixed(2));

  let tradeoffSummary = '';
  if (best.count === currentMetrics.operatorCount) {
    tradeoffSummary = `Rekomendasi mempertahankan ${best.count} operator dengan merealokasi pembagian mesin secara berdampingan (kontigu). OEE menjadi ${best.metrics.oee}% (Δ ${deltaOee >= 0 ? '+' : ''}${deltaOee}%), MHPT ${best.metrics.mhptTotal} h/ton, dan beban kerja operator seimbang di rata-rata ${best.metrics.avgManOcc}% (rentang ${best.metrics.minManOcc}% - ${best.metrics.maxManOcc}%).`;
  } else if (best.count < currentMetrics.operatorCount) {
    tradeoffSummary = `Rekomendasi efisiensi tenaga kerja: Kurangi operator dari ${currentMetrics.operatorCount} menjadi ${best.count} orang. MHPT membaik signifikan ke ${best.metrics.mhptTotal} h/ton (hemat ${Math.abs(deltaMhpt)} h/ton), sementara OEE tetap stabil di ${best.metrics.oee}% karena beban operator masih di batas aman (${best.metrics.avgManOcc}%).`;
  } else {
    tradeoffSummary = `Rekomendasi penambahan kapasitas: Tambah operator dari ${currentMetrics.operatorCount} menjadi ${best.count} orang untuk menghilangkan bottleneck antrian mesin. OEE melonjak ke ${best.metrics.oee}% (Δ +${deltaOee}%) dan output naik +${deltaTon} ton, menjaga MHPT tetap optimal di ${best.metrics.mhptTotal} h/ton.`;
  }

  const alternativeScenarios = evaluations.map((e) => {
    let desc = '';
    if (e.metrics.avgManOcc > 92) {
      desc = 'Overload risk: operator terlalu padat, mesin sering menunggu antrian.';
    } else if (e.metrics.avgManOcc < 75) {
      desc = 'Under-utilized: operator banyak idle, MHPT menjadi tinggi.';
    } else {
      desc = 'Sweet spot: keseimbangan prima antara OEE dan biaya tenaga kerja.';
    }
    return {
      operatorCount: e.count,
      oee: e.metrics.oee,
      mhptTotal: e.metrics.mhptTotal,
      avgManOcc: e.metrics.avgManOcc,
      description: desc,
    };
  });

  return {
    currentMetrics,
    bestMetrics: best.metrics,
    tradeoffSummary,
    recommendedOperatorCount: best.count,
    recommendedOperators: best.operators,
    recommendedAssignments: best.assignments,
    alternativeScenarios,
  };
}
