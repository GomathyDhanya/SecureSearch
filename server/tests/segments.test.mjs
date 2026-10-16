import test from 'node:test'
import assert from 'node:assert/strict'
import { createSegmentedIndex, insertSegmented } from '../../shared/segments.mjs'
import { leaves, route, routeGlobal } from '../../shared/index.mjs'
import { makeDataset } from '../../shared/fixtures.mjs'

test('fixed-count seals and binary merges preserve records and searchable leaves', async () => {
  const data = makeDataset({ n: 160, queries: 1 })
  const index = createSegmentedIndex({ segmentSize: 64 })
  const storage = new Map()
  const observations = []
  for (let start = 0; start < data.records.length; start += 32) {
    const plan = await insertSegmented(index, data.records.slice(start, start + 32), async id => storage.get(id))
    for (const id of plan.removed) storage.delete(id)
    for (const [id, rows] of plan.changed) storage.set(id, rows)
    observations.push({ count: index.root.count, runs: index.runs.map(run => [run.level, run.count]),
      pending: index.root.children.find(node => node.id === index.pendingRootId).count,
      merges: plan.mergeCount })
    const routed = routeGlobal(index, data.queries[0], 1000)
    assert.equal(routed.candidates, index.root.count)
    assert.deepEqual(new Set(routed.leafIds), new Set(storage.keys()))
    assert.ok(route(index, data.queries[0], 1).leafIds.every(id => storage.has(id)))
    assert.deepEqual(new Set([...storage.values()].flat().map(row => row.id)),
      new Set(data.records.slice(0, start + 32).map(row => row.id)))
  }
  assert.deepEqual(observations.map(x => x.count), [32, 64, 96, 128, 160])
  assert.deepEqual(observations[1].runs, [[0, 64]])
  assert.deepEqual(observations[3].runs, [[1, 128]])
  assert.equal(observations[3].merges, 1)
  assert.equal(observations[4].pending, 32)
  assert.equal(leaves(index).reduce((n, leaf) => n + leaf.count, 0), 160)
})
