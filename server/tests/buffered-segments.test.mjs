import test from 'node:test'
import assert from 'node:assert/strict'
import { createBufferedIndex, insertBuffered } from '../../shared/buffered-segments.mjs'
import { leaves } from '../../shared/index.mjs'
import { makeDataset } from '../../shared/fixtures.mjs'

test('opaque insert batches leave existing leaves untouched until a count-triggered seal', async () => {
  const data = makeDataset({ n: 160, queries: 1 })
  const index = createBufferedIndex({ segmentSize: 64 })
  const storage = new Map()
  const observations = []
  for (let start = 0; start < data.records.length; start += 32) {
    const prior = new Set(storage.keys())
    const plan = await insertBuffered(index, data.records.slice(start, start + 32), async id => storage.get(id))
    if (!plan.sealed) {
      assert.equal(plan.changed.size, 1)
      assert.equal(plan.removed.length, 0)
      assert.ok([...prior].every(id => !plan.changed.has(id)))
      assert.equal(plan.fetchedVectors, 0)
    }
    for (const id of plan.removed) storage.delete(id)
    for (const [id, rows] of plan.changed) storage.set(id, rows)
    observations.push({ count: index.root.count, pending: index.pendingCount,
      runs: index.runs.map(run => [run.level, run.count]), merges: plan.mergeCount })
    assert.deepEqual(new Set([...storage.values()].flat().map(row => row.id)),
      new Set(data.records.slice(0, start + 32).map(row => row.id)))
    assert.deepEqual(new Set(leaves(index).map(leaf => leaf.id)), new Set(storage.keys()))
  }
  assert.deepEqual(observations.map(x => x.pending), [32, 0, 32, 0, 32])
  assert.deepEqual(observations[1].runs, [[0, 64]])
  assert.deepEqual(observations[3].runs, [[1, 128]])
  assert.equal(observations[3].merges, 1)
  assert.equal(index.root.count, 160)
})
