/** Slack for floating-point rounding: a route that's exactly the straight line can sum to a hair
 * under its own straight-line distance. */
const BOUND_SLACK = 1e-9;

/** The candidate with the lowest `exactScore` — the same pick as scoring every candidate in order
 * and keeping the first strictly lower score (so ties go to the earliest candidate) — but
 * `exactScore` only runs where `lowerBound` says the candidate could still win. `lowerBound` must
 * never exceed `exactScore` (e.g. straight-line distance vs the routed walk around machines and
 * walls, which is what makes Task Priority expensive at a few thousand machines). */
export function pickLowestScore<T>(candidates: T[], lowerBound: (candidate: T) => number, exactScore: (candidate: T) => number): T {
  const order = candidates.map((candidate, index) => ({ candidate, index, bound: lowerBound(candidate) }));
  order.sort((a, b) => a.bound - b.bound || a.index - b.index);
  let best = order[0];
  let bestScore = exactScore(best.candidate);
  for (let i = 1; i < order.length; i += 1) {
    const next = order[i];
    if (next.bound - BOUND_SLACK > bestScore) break;
    const score = exactScore(next.candidate);
    if (score < bestScore || (score === bestScore && next.index < best.index)) {
      best = next;
      bestScore = score;
    }
  }
  return best.candidate;
}
