import { createIndex, insertRecords, leaves } from './index.mjs'

export const SEGMENT_FORMAT = 'segmented-private-centroid-tree-v1'

export function createSegmentedIndex({ segmentSize = 500, dimension = 512, capacity = 64, branching = 4, maxDepth = 6 } = {}) {
  if (!Number.isInteger(segmentSize) || segmentSize < 8) throw new Error('Segment size must be at least 8')
  const pending = createIndex({ dimension, capacity, branching, maxDepth })
  return { format: SEGMENT_FORMAT, dimension, capacity, branching, maxDepth, segmentSize,
    pendingRootId: pending.root.id, runs: [],
    root: { id: crypto.randomUUID(), count: 0, children: [pending.root] } }
}

function child(index, rootId) {
  const root = index.root.children.find(node => node.id === rootId)
  if (!root) throw new Error('Segment root missing from encrypted index')
  return root
}

function configuration(index, root) {
  return { dimension: index.dimension, capacity: index.capacity, branching: index.branching,
    maxDepth: index.maxDepth, root }
}

// Mutates a trusted-client snapshot. loadLeaf retrieves and decrypts a leaf
// only when it is needed; the returned plan contains the new physical leaves
// and all old physical leaf IDs to retire in one atomic snapshot commit.
export async function insertSegmented(index, incoming, loadLeaf) {
  if (index.format !== SEGMENT_FORMAT) throw new Error('Not a segmented index')
  if (incoming.length > index.segmentSize - child(index, index.pendingRootId).count)
    throw new Error('Insertion crosses a segment boundary')
  const existingIds = new Set(leaves(index).map(node => node.id))
  const replacements = new Map(), removed = new Set()
  let fetchedVectors = 0, splits = 0, mergeCount = 0, sealed = false
  const recordsFor = async id => {
    if (replacements.has(id)) return replacements.get(id)
    const rows = await loadLeaf(id)
    fetchedVectors += rows.length
    return rows
  }
  const retire = id => {
    replacements.delete(id)
    if (existingIds.has(id)) removed.add(id)
  }
  const apply = plan => {
    splits += plan.splits
    for (const id of plan.removed) retire(id)
    for (const [id, rows] of plan.changed) replacements.set(id, rows)
  }
  const rowsIn = async root => {
    const groups = await Promise.all(leaves(configuration(index, root)).map(async leaf => recordsFor(leaf.id)))
    return groups.flat()
  }
  const retireTree = root => { for (const leaf of leaves(configuration(index, root))) retire(leaf.id) }
  const removeRoot = rootId => { index.root.children = index.root.children.filter(node => node.id !== rootId) }
  const build = async rows => {
    const next = createIndex(index)
    const plan = await insertRecords(next, rows)
    splits += plan.splits
    for (const [id, members] of plan.changed) replacements.set(id, members)
    return next.root
  }

  const pending = child(index, index.pendingRootId)
  const pendingIndex = configuration(index, pending)
  apply(await insertRecords(pendingIndex, incoming, recordsFor))
  if (pending.count === index.segmentSize) {
    sealed = true
    let rows = await rowsIn(pending)
    retireTree(pending)
    removeRoot(pending.id)
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
    const sealedRoot = await build(rows)
    index.root.children.push(sealedRoot)
    index.runs.push({ level, rootId: sealedRoot.id, count: rows.length })
    index.runs.sort((a, b) => a.level - b.level)
    const fresh = createIndex(index)
    index.pendingRootId = fresh.root.id
    index.root.children.push(fresh.root)
  }
  index.root.count = index.root.children.reduce((n, root) => n + root.count, 0)
  return { changed: replacements, removed: [...removed], fetchedVectors, splits, mergeCount, sealed }
}
