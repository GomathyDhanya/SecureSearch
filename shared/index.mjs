export const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)
export function normalize(vector) {
  const norm = Math.hypot(...vector)
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Vector must be finite and nonzero')
  return Array.from(vector, v => v / norm)
}
const centroid = sum => { const n = Math.hypot(...sum); return sum.map(x => n ? x / n : 0) }
const id = () => crypto.randomUUID()
const leaf = () => ({ id: id(), count: 0, sum: [], center: [], children: null })

export function createIndex({ dimension = 512, capacity = 64, branching = 4, maxDepth = 6 } = {}) {
  if (!Number.isInteger(capacity) || capacity < 8 || !Number.isInteger(branching) || branching < 2 || branching > 16)
    throw new Error('Invalid index configuration')
  return { format: 'private-centroid-tree-v1', dimension, capacity, branching, maxDepth, root: leaf() }
}

function summarize(node, records, dimension) {
  node.count = records.length
  node.sum = Array(dimension).fill(0)
  records.forEach(r => r.vector.forEach((x, d) => { node.sum[d] += x }))
  node.center = centroid(node.sum)
  // Unit vectors lie inside this spherical cap. Only leaf bounds are used;
  // recompute whenever a leaf changes rather than retaining stale radii.
  node.radius = Math.hypot(...node.center) < 0.5 ? Math.PI : Math.max(0,
    ...records.map(r => Math.acos(Math.max(-1, Math.min(1, dot(r.vector, node.center)))))) + 1e-7
}

// Bounded, deterministic spherical k-means, initialized by farthest-first seeds.
// Empty or identical clusters fall back to balanced partitions, preserving data.
function partition(records, k) {
  const seeds = [records[0].vector]
  while (seeds.length < k) {
    let best = records[0], distance = -Infinity
    for (const r of records) {
      const dist = 1 - Math.max(...seeds.map(c => dot(r.vector, c)))
      if (dist > distance) { best = r; distance = dist }
    }
    if (distance < 1e-10) break
    seeds.push(best.vector)
  }
  let centers = seeds, groups
  for (let iteration = 0; iteration < 8; iteration++) {
    groups = centers.map(() => [])
    for (const r of records) {
      let best = 0
      for (let i = 1; i < centers.length; i++)
        if (dot(r.vector, centers[i]) > dot(r.vector, centers[best])) best = i
      groups[best].push(r)
    }
    groups = groups.filter(g => g.length)
    centers = groups.map(g => centroid(g.reduce((sum, r) => sum.map((x, d) => x + r.vector[d]), Array(records[0].vector.length).fill(0))))
  }
  if (groups.length < 2) {
    groups = Array.from({ length: k }, () => [])
    records.forEach((r, i) => groups[i % k].push(r))
  }
  return groups
}

// All plaintext vectors are transaction-local. The persistent routing index has
// only summaries. Existing vectors are fetched/decrypted only in touched leaves.
export async function insertRecords(index, incoming, loadLeaf = async () => []) {
  const changed = new Map(), removed = new Set()
  let splits = 0, fetchedVectors = 0
  const recordsFor = async node => {
    if (!changed.has(node.id)) {
      const records = node.count ? await loadLeaf(node.id) : []
      if (records.length !== node.count) throw new Error('Leaf count does not match encrypted index')
      fetchedVectors += records.length
      changed.set(node.id, [...records])
    }
    return changed.get(node.id)
  }
  async function split(node, records, depth) {
    if (records.length <= index.capacity || depth >= index.maxDepth) return
    removed.add(node.id); changed.delete(node.id); splits++
    node.children = partition(records, Math.min(index.branching, records.length)).map(group => {
      const child = leaf(); summarize(child, group, index.dimension)
      changed.set(child.id, group)
      return child
    })
    for (const child of node.children) await split(child, changed.get(child.id), depth + 1)
  }
  async function insert(node, record, depth) {
    if (node.children) {
      const next = node.children.reduce((a, b) => dot(record.vector, a.center) >= dot(record.vector, b.center) ? a : b)
      await insert(next, record, depth + 1)
      node.count++
      node.sum = node.sum.map((x, d) => x + record.vector[d])
      node.center = centroid(node.sum)
    } else {
      const records = await recordsFor(node)
      records.push(record)
      summarize(node, records, index.dimension)
      await split(node, records, depth)
    }
  }
  for (const record of incoming) {
    if (record.vector.length !== index.dimension || !record.vector.every(Number.isFinite)) throw new Error('Invalid embedding')
    if (Math.abs(Math.hypot(...record.vector) - 1) > 1e-8) throw new Error('Embedding must be normalized')
    await insert(index.root, record, 0)
  }
  return { changed, removed: [...removed], splits, fetchedVectors }
}

export function leaves(index) {
  const result = []
  function visit(node) { if (node.children) node.children.forEach(visit); else if (node.count) result.push(node) }
  visit(index.root)
  return result
}

// Local beam traversal; server sees only the chosen coarse leaf IDs. Beam width
// is a public tuning knob. With nprobe >= leaf count, routing is exhaustive.
export function route(index, query, nprobe = 4) {
  if (!Number.isInteger(nprobe) || nprobe < 1) throw new Error('nprobe must be positive')
  if (query.length !== index.dimension) throw new Error('Query dimension mismatch')
  let frontier = index.root.count ? [index.root] : [], comparisons = 0
  while (frontier.some(n => n.children)) {
    frontier = frontier.flatMap(n => n.children || [n]).filter(node => node.count).map(node => {
      comparisons++; return { node, score: dot(query, node.center) }
    }).sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
      .slice(0, nprobe).map(x => x.node)
  }
  return { leafIds: frontier.map(n => n.id), candidates: frontier.reduce((s, n) => s + n.count, 0), comparisons }
}

// Exact ranking of client-held leaf summaries. This trades additional local
// centroid dot products for better candidate coverage at the same HE budget.
export function routeGlobal(index, query, nprobe = 4) {
  if (!Number.isInteger(nprobe) || nprobe < 1) throw new Error('nprobe must be positive')
  if (query.length !== index.dimension) throw new Error('Query dimension mismatch')
  const all = leaves(index)
  const pendingIds = new Set(index.pendingBatchIds || [])
  const selected = all.filter(node => !pendingIds.has(node.id)).map(node => ({ node, score: dot(query, node.center) }))
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
    .slice(0, nprobe).map(x => x.node)
  if (pendingIds.size) selected.unshift(...all.filter(node => pendingIds.has(node.id)))
  return { leafIds: selected.map(node => node.id),
    candidates: selected.reduce((sum, node) => sum + node.count, 0), comparisons: all.length }
}

export function indexStats(index) {
  const sizes = leaves(index).map(n => n.count)
  return { format: index.format, embeddingSpace: index.embeddingSpace ?? null, count: index.root.count,
    pendingCount: index.pendingCount ?? null, leaves: sizes.length, maxLeaf: Math.max(0, ...sizes),
    routingBytes: new TextEncoder().encode(JSON.stringify(index)).length }
}
