import { dot, leaves, route } from './index.mjs'
import { boundLeaves } from './adaptive.mjs'

// A single-query, fixed-size k-subset randomized response mechanism. For m
// leaves, b selected leaves, and a query-dependent preferred leaf t:
//   Pr[t included] = b exp(eps) / (m-b+b exp(eps)).
// Every particular b-subset containing t is exp(eps) times as likely as every
// particular b-subset omitting t. The same normalizer applies for every t,
// so the selected SET is pure eps-local-DP for any pair of queries. This is a
// known mechanism; the protocol's contribution is composing it with encrypted
// scoring and query-independent image retrieval for a personal vault.
function uniform(max) {
  if (!Number.isSafeInteger(max) || max < 1 || max > 0x100000000) throw new Error('Invalid random range')
  const range = 0x100000000, cutoff = Math.floor(range / max) * max
  const value = new Uint32Array(1)
  do { crypto.getRandomValues(value) } while (value[0] >= cutoff)
  return value[0] % max
}

function sample(pool, n) {
  const copy = [...pool]
  for (let i = 0; i < n; i++) {
    const j = i + uniform(copy.length - i)
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

export function inclusionProbability(m, b, epsilon) {
  if (!Number.isInteger(m) || m < 1 || !Number.isInteger(b) || b < 1 || b > m ||
      !Number.isFinite(epsilon) || epsilon < 0 || epsilon > 20)
    throw new Error('Invalid private probe parameters')
  // Numerically stable even when exp(epsilon) is large.
  return b / (b + (m - b) * Math.exp(-epsilon))
}

export function preparePrivateQuery(index, query) {
  const choices = leaves(index)
  // Validation also checks that the query is unit-normalized. Bounds are used
  // only for the local quality audit, never transmitted to the server.
  const bounds = boundLeaves(index, query)
  const preferred = choices.length ? choices.reduce((best, node) => dot(query, node.center) > dot(query, best.center) ? node : best) : null
  const ids = choices.map(x => x.id), other = ids.filter(id => id !== preferred?.id), m = ids.length
  return {
    sample({ budget = 4, epsilon = 2 } = {}) {
      if (!m) return { leafIds: [], preferredId: null, inclusionProbability: 1, totalLeaves: 0, budget: 0, epsilon }
      const b = Math.min(budget, m), p = inclusionProbability(m, b, epsilon)
      // Round inclusion probability DOWN on the 32-bit sampling grid. If it
      // rounds below the uniform b/m baseline, emit a uniform subset instead.
      // Thus the actual likelihood ratio never exceeds exp(epsilon).
      const threshold = Math.floor(p * 0x100000000)
      const actualP = threshold / 0x100000000
      const uniformSubset = actualP < b / m
      const include = !uniformSubset && uniform(0x100000000) < threshold
      const selected = uniformSubset ? sample(ids, b) :
        include ? [preferred.id, ...sample(other, b - 1)] : sample(other, b)
      return { leafIds: selected.sort(), preferredId: preferred.id, inclusionProbability: p,
        actualInclusionProbability: uniformSubset ? b / m : actualP, totalLeaves: m, budget: b, epsilon }
    },
    audit(visitedIds, scores, k, scoreError = 1e-4) {
      return auditPrivateResult(index, query, visitedIds, scores, k, scoreError, bounds)
    },
  }
}

export function selectPrivateLeaves(index, query, options) { return preparePrivateQuery(index, query).sample(options) }

// Weaker-privacy alternative: keep the r best routing leaves, then add
// uniformly sampled decoys to a fixed-size request. This guarantees coverage
// of those leaves, but has NO finite epsilon-DP guarantee: an output omitting
// a query's required leaf has probability zero for that query.
export function prepareDecoyQuery(index, query, { budget = 4, required = 1 } = {}) {
  const all = leaves(index)
  if (!Number.isInteger(budget) || budget < 1 || !Number.isInteger(required) || required < 1 || required > budget)
    throw new Error('Invalid decoy cover parameters')
  if (!all.length) return { sample: () => ({ leafIds: [], requiredIds: [], budget: 0, totalLeaves: 0, policy: 'guaranteed-plus-decoys' }) }
  const b = Math.min(budget, all.length), r = Math.min(required, b)
  const requiredIds = route(index, query, r).leafIds
  const needed = new Set(requiredIds)
  const pool = all.map(x => x.id).filter(id => !needed.has(id))
  return { sample: () => ({ leafIds: [...requiredIds, ...sample(pool, b - r)].sort(), requiredIds, budget: b,
    totalLeaves: all.length, policy: 'guaranteed-plus-decoys' }) }
}

export function selectDecoyLeaves(index, query, options) { return prepareDecoyQuery(index, query, options).sample() }

// One fixed request. This audit is local post-processing and makes no extra
// server request when it cannot exclude an unvisited leaf.
export function auditPrivateResult(index, query, visitedIds, scores, k, scoreError = 1e-4, preparedBounds = null) {
  const visited = new Set(visitedIds)
  const unseenUpper = Math.max(-1, ...(preparedBounds || boundLeaves(index, query)).filter(x => !visited.has(x.id)).map(x => x.upper))
  const sorted = [...scores].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const kthLower = sorted.length >= k ? sorted[k - 1].score - scoreError : -1
  const complete = visited.size === (preparedBounds || leaves(index)).length || sorted.length >= k && unseenUpper < kthLower
  return { complete, status: complete ? 'bounded-within-private-cover' : 'uncertain-within-private-cover',
    unseenUpper, kthLower, scoreRegretBound: sorted.length < Math.min(k, index.root.count) ? null :
      Math.max(2 * scoreError, unseenUpper - kthLower), scoreError }
}
