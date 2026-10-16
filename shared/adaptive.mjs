import { leaves, dot } from './index.mjs'

// Spherical cap bound: max q·x <= cos(max(0, angle(q,c) - radius)).
// Old snapshots lacking a radius safely fall back to the universal upper bound.
export function boundLeaves(index, query) {
  if (query.length !== index.dimension || !query.every(Number.isFinite) || Math.abs(Math.hypot(...query) - 1) > 1e-8)
    throw new Error('Bounded search requires a normalized query')
  return leaves(index).map(node => {
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(query, node.center))))
    const upper = node.radius === undefined ? 1 : Math.min(1, Math.cos(Math.max(0, angle - node.radius)) + 1e-7)
    return { id: node.id, count: node.count, upper }
  }).sort((a, b) => b.upper - a.upper || a.id.localeCompare(b.id))
}

// Client-driven, batched branch-and-bound. evaluate receives only leaf IDs and
// returns decrypted scalar scores; never download candidate vectors to search.
// The stopping statement is CONDITIONAL on |CKKS error| <= scoreError. This
// configured tolerance is empirically tested, not a cryptographic error proof.
export async function adaptiveSearch(index, query, evaluate, {
  k = 8, initialProbe = 2, maxProbes = Infinity, scoreError = 1e-4,
} = {}) {
  if (!Number.isInteger(k) || k < 1 || !Number.isInteger(initialProbe) || initialProbe < 1 ||
      !(maxProbes === Infinity || Number.isInteger(maxProbes) && maxProbes > 0) || !Number.isFinite(scoreError) || scoreError < 0)
    throw new Error('Invalid adaptive search options')
  const pending = boundLeaves(index, query), totalLeaves = pending.length
  const budget = Math.min(maxProbes, totalLeaves), scores = [], trace = []
  let visited = 0, width = initialProbe, unseenUpper = pending[0]?.upper ?? -1, kthLower = -1
  while (visited < budget) {
    const batch = pending.slice(visited, Math.min(budget, visited + width))
    scores.push(...await evaluate(batch.map(x => x.id)))
    scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    visited += batch.length
    unseenUpper = pending[visited]?.upper ?? -1
    kthLower = scores.length >= k ? scores[k - 1].score - scoreError : -1
    trace.push({ leaves: batch.length, visited, candidates: scores.length, unseenUpper, kthLower })
    if (visited === totalLeaves || scores.length >= k && unseenUpper < kthLower) break
    width *= 2
  }
  const exhaustive = visited === totalLeaves
  const unseenExcluded = exhaustive || scores.length >= k && unseenUpper < kthLower
  return { scores, audit: { rounds: trace.length, visitedLeaves: visited, totalLeaves, exhaustive, unseenExcluded,
    status: exhaustive ? 'exhaustive' : unseenExcluded ? 'bounded' : 'budget-exhausted', scoreError,
    // Additive score regret of the returned top-k set, conditional on tolerance.
    scoreRegretBound: scores.length < Math.min(k, index.root.count) ? null : Math.max(2 * scoreError, unseenUpper - kthLower),
    unseenUpper, kthLower, trace } }
}
