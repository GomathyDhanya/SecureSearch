import { createIndex, insertRecords, leaves } from './index.mjs'

export const BUFFERED_FORMAT = 'buffered-private-centroid-tree-experiment-v1'

export function createBufferedIndex({ segmentSize = 500, dimension = 512, capacity = 64, branching = 4, maxDepth = 6 } = {}) {
  if (!Number.isInteger(segmentSize) || segmentSize < 64) throw new Error('Segment size must be at least 64')
  return { format: BUFFERED_FORMAT, dimension, capacity, branching, maxDepth, segmentSize,
    pendingCount: 0, pendingBatchIds: [], runs: [],
    root: { id: crypto.randomUUID(), count: 0, children: [] } }
}

const wrapper = (index, root) => ({ dimension: index.dimension, root })
const child = (index, id) => {
  const node = index.root.children.find(root => root.id === id)
  if (!node) throw new Error('Buffered run root is missing')
  return node
}

// Each incoming batch is a new unclassified physical leaf. Old batch leaves
// are not rewritten until the fixed-count seal.
export async function insertBuffered(index, incoming, loadLeaf) {
  if (index.format !== BUFFERED_FORMAT || !incoming.length ||
      incoming.length > index.segmentSize - index.pendingCount) throw new Error('Invalid buffered insertion')
  for (const record of incoming) if (record.vector.length !== index.dimension ||
      !record.vector.every(Number.isFinite) ||
      Math.abs(Math.hypot(...record.vector) - 1) > 1e-8) throw new Error('Invalid normalized embedding')
  const existing = new Set(leaves(index).map(node => node.id))
  const changed = new Map(), removed = new Set()
  let fetchedVectors = 0, splits = 0, mergeCount = 0, sealed = false
  const recordsFor = async id => {
    if (changed.has(id)) return changed.get(id)
    const rows = await loadLeaf(id)
    const leaf = leaves(index).find(node => node.id === id)
    if (!Array.isArray(rows) || rows.length !== leaf?.count) throw new Error('Leaf count does not match encrypted index')
    fetchedVectors += rows.length
    return rows
  }
  const retire = id => {
    changed.delete(id)
    if (existing.has(id)) removed.add(id)
  }
  const rowsIn = async root => (await Promise.all(leaves(wrapper(index, root))
    .map(async leaf => recordsFor(leaf.id)))).flat()
  const retireTree = root => { for (const leaf of leaves(wrapper(index, root))) retire(leaf.id) }
  const removeRoot = id => { index.root.children = index.root.children.filter(root => root.id !== id) }
  const batch = { id: crypto.randomUUID(), count: incoming.length, center: Array(index.dimension).fill(0),
    radius: Math.PI, children: null }
  index.root.children.push(batch)
  index.pendingBatchIds.push(batch.id)
  index.pendingCount += incoming.length
  changed.set(batch.id, incoming)
  if (index.pendingCount === index.segmentSize) {
    sealed = true
    let rows = (await Promise.all(index.pendingBatchIds.map(id => recordsFor(id)))).flat()
    for (const id of index.pendingBatchIds) { retire(id); removeRoot(id) }
    index.pendingBatchIds = []; index.pendingCount = 0
    let level = 0
    while (index.runs.some(run => run.level === level)) {
      const previous = index.runs.find(run => run.level === level)
      const oldRoot = child(index, previous.rootId)
      rows = [...await rowsIn(oldRoot), ...rows]
      retireTree(oldRoot)
      removeRoot(oldRoot.id)
      index.runs = index.runs.filter(run => run !== previous)
      level++; mergeCount++
    }
    const built = createIndex(index)
    const plan = await insertRecords(built, rows)
    splits += plan.splits
    for (const [id, members] of plan.changed) changed.set(id, members)
    index.root.children.push(built.root)
    index.runs.push({ level, rootId: built.root.id, count: rows.length })
    index.runs.sort((a, b) => a.level - b.level)
  }
  index.root.count = index.root.children.reduce((n, root) => n + root.count, 0)
  return { changed, removed: [...removed], fetchedVectors, splits, mergeCount, sealed }
}
