import type { ProductionMachineAssignment, ProductionOperator, ProductionSetup } from '../../types';
import { calculatePlannedUtilization } from '../productionUtilization';
import { summarizeProductionForecast } from '../productionForecastSummary';
import { computeAutoAssignPlan } from '../productionAutoAssign';
import { defaultAssignmentOrder } from '../defaultAssignment';
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
 * Fast KPI metrics computation for candidate scoring during iterative optimization.
 * Bypasses full-shift forecast summary to maintain fast real-time performance on large setups.
 */
function computeCandidateFastMetrics(
  setup: ProductionSetup,
  resolved: Map<string, ResolvedConstruction>,
  baselineTon: number,
  baselineOee: number,
): SetupKpiMetrics {
  const planned = calculatePlannedUtilization(setup, resolved);
  const netShiftMinutes = Math.max(1, setup.shiftTime - (setup.lunchTime ?? 0));
  const operatorCount = setup.operators.length;
  const netManhours = (operatorCount * netShiftMinutes) / 60;

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

  let sumManOcc = 0;
  let minOcc = 100;
  let maxOcc = 0;

  const opBreakdown: Array<{
    operatorId: string;
    operatorLabel: string;
    machineCount: number;
    manOccPercent: number;
  }> = [];

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

  // Approximate proportional tonnage based on relative OEE change compared to baseline
  const estimatedTon = baselineOee > 0 ? baselineTon * (avgOee / baselineOee) : baselineTon;
  const mhptTotal = estimatedTon > 0 ? Number((netManhours / estimatedTon).toFixed(2)) : 0;

  return {
    oee: Number(avgOee.toFixed(1)),
    availability: Number(avgAvail.toFixed(1)),
    mhptTotal,
    mhptFp: mhptTotal,
    totalTon: Number(estimatedTon.toFixed(2)),
    fpTon: Number(estimatedTon.toFixed(2)),
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
 * Finds the optimum operator count and contiguous machine assignments
 * balancing OEE vs MHPT without blocking the browser event loop.
 */
export async function optimizeMachineAllocation({
  setup,
  resolved,
  targetManOcc = 85,
  minOperators,
  maxOperators,
  onProgress,
}: {
  setup: ProductionSetup;
  resolved: Map<string, ResolvedConstruction>;
  targetManOcc?: number;
  minOperators?: number;
  maxOperators?: number;
  onProgress?: (status: string) => void;
}): Promise<OptimizationResult> {
  const currentMetrics = computeSetupKpiMetrics(setup, resolved);
  const plannedMachines = setup.assignments.filter((a) => a.constructionDetailId);

  if (plannedMachines.length === 0) {
    return {
      currentMetrics,
      bestMetrics: currentMetrics,
      tradeoffSummary: 'Setup has no planned machines (Construction Details are unassigned).',
      recommendedOperatorCount: setup.operators.length,
      recommendedOperators: setup.operators,
      recommendedAssignments: setup.assignments,
      alternativeScenarios: [],
    };
  }

  // Pre-sort machines once upfront so we do not re-run geometric sorting 7 times on large layouts
  const plannedMachineIds = new Set(plannedMachines.map((a) => a.machineId));
  const candidateMachines = setup.layout.filter((m) => plannedMachineIds.has(m.id));
  const preorderedMachines = defaultAssignmentOrder(candidateMachines, setup.movement?.pixelsPerMeter);

  // Determine smart search space for operator counts
  const curCount = Math.max(1, setup.operators.length);
  let candidateCounts: number[] = [];

  if (minOperators !== undefined && maxOperators !== undefined) {
    const minC = Math.max(1, minOperators);
    const maxC = Math.max(minC, Math.min(plannedMachines.length, maxOperators));
    const range = maxC - minC;
    if (range > 4) {
      const step = Math.ceil(range / 3);
      for (let c = minC; c < maxC; c += step) candidateCounts.push(c);
      if (!candidateCounts.includes(maxC)) candidateCounts.push(maxC);
    } else {
      for (let c = minC; c <= maxC; c++) candidateCounts.push(c);
    }
  } else {
    // Intelligent sampling around current operator count to keep response under 1-2s
    if (curCount > 30) {
      // Large factory setup (like 75 operators, 1243 machines): test 3 representative steps
      candidateCounts = [
        Math.max(1, curCount - 3),
        curCount,
        Math.min(plannedMachines.length, curCount + 3),
      ].filter((v, idx, arr) => arr.indexOf(v) === idx);
    } else if (curCount > 10) {
      // Medium factory setup (10-30 operators): test 3-4 steps
      candidateCounts = [
        Math.max(1, curCount - 2),
        curCount,
        Math.min(plannedMachines.length, curCount + 2),
      ].filter((v, idx, arr) => arr.indexOf(v) === idx);
    } else {
      // Small setup (1-10 operators): test +-1 or +-2
      const minC = Math.max(1, curCount - 2);
      const maxC = Math.min(plannedMachines.length, curCount + 2);
      for (let c = minC; c <= maxC; c++) candidateCounts.push(c);
    }
  }

  interface CandidateEvaluation {
    count: number;
    metrics: SetupKpiMetrics;
    score: number;
    operators: { id: string; label: string }[];
    assignments: ProductionMachineAssignment[];
    setupObj: ProductionSetup;
  }

  const evaluations: CandidateEvaluation[] = [];

  for (let idx = 0; idx < candidateCounts.length; idx++) {
    const count = candidateCounts[idx];
    if (onProgress) {
      onProgress(`Evaluating scenario ${idx + 1} of ${candidateCounts.length} (${count} operators)…`);
    }

    // Yield control to the browser event loop to prevent "Page isn't responding" freeze
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Generate spatial assignment plan using pre-sorted machines
    const plan = computeAutoAssignPlan({
      setup,
      options: {
        mode: 'multi',
        multiCount: count,
        onlyPlannedMachines: true,
        preorderedMachines,
      },
    });

    const candidateOperators: ProductionOperator[] = plan.operatorsToCreate.map((o, oIdx) => ({
      id: `ai-opr-${oIdx + 1}`,
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

    // Fast metric evaluation for candidate scoring
    const fastMetrics = computeCandidateFastMetrics(
      candidateSetup,
      resolved,
      currentMetrics.totalTon,
      currentMetrics.oee,
    );
    const score = calculateParetoScore(fastMetrics, targetManOcc);

    evaluations.push({
      count,
      metrics: fastMetrics,
      score,
      operators: candidateOperators,
      assignments: candidateAssignments,
      setupObj: candidateSetup,
    });
  }

  // Sort by Pareto score descending
  evaluations.sort((a, b) => b.score - a.score);
  const bestCandidate = evaluations[0];

  // Yield before final full forecast computation
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Compute full accurate KPI metrics for the winning recommendation
  const bestMetrics = bestCandidate
    ? computeSetupKpiMetrics(bestCandidate.setupObj, resolved)
    : currentMetrics;

  const best = bestCandidate
    ? {
        ...bestCandidate,
        metrics: bestMetrics,
      }
    : {
        count: curCount,
        metrics: currentMetrics,
        score: 0,
        operators: setup.operators,
        assignments: setup.assignments,
        setupObj: setup,
      };

  // Build trade-off explanation
  const deltaOee = Number((best.metrics.oee - currentMetrics.oee).toFixed(1));
  const deltaMhpt = Number((best.metrics.mhptTotal - currentMetrics.mhptTotal).toFixed(2));
  const deltaTon = Number((best.metrics.totalTon - currentMetrics.totalTon).toFixed(2));

  let tradeoffSummary = '';
  if (best.count === currentMetrics.operatorCount) {
    tradeoffSummary = `Recommended to maintain ${best.count} operators by reallocating contiguous adjacent machine rows. OEE reaches ${best.metrics.oee}% (Δ ${deltaOee >= 0 ? '+' : ''}${deltaOee}%), MHPT is ${best.metrics.mhptTotal} h/ton, and operator workload is balanced at an average of ${best.metrics.avgManOcc}% (range ${best.metrics.minManOcc}% - ${best.metrics.maxManOcc}%).`;
  } else if (best.count < currentMetrics.operatorCount) {
    tradeoffSummary = `Labor efficiency recommendation: Streamline operators from ${currentMetrics.operatorCount} to ${best.count}. MHPT improves significantly to ${best.metrics.mhptTotal} h/ton (saving ${Math.abs(deltaMhpt)} h/ton), while OEE remains stable at ${best.metrics.oee}% with operator occupation within safe thresholds (${best.metrics.avgManOcc}%).`;
  } else {
    tradeoffSummary = `Capacity expansion recommendation: Increase operators from ${currentMetrics.operatorCount} to ${best.count} to eliminate machine waiting queues. OEE rises to ${best.metrics.oee}% (Δ +${deltaOee}%) and output increases by +${deltaTon} tons, keeping MHPT optimized at ${best.metrics.mhptTotal} h/ton.`;
  }

  const alternativeScenarios = evaluations.map((e) => {
    let desc = '';
    if (e.metrics.avgManOcc > 92) {
      desc = 'Overload risk: operators over-utilized, high machine queue downtime.';
    } else if (e.metrics.avgManOcc < 75) {
      desc = 'Under-utilized: excess operator idle time, higher labor cost per ton (high MHPT).';
    } else {
      desc = 'Sweet spot: optimum balance between equipment OEE and labor efficiency.';
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
