import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStore } from '../storage.mjs'
import { createApp } from '../app.mjs'
import { VaultClient } from '../../shared/vault-client.mjs'
import { makeDataset } from '../../shared/fixtures.mjs'
import { dot, leaves } from '../../shared/index.mjs'

// Protocol test double only. The real CKKS scorer is exercised in core.test.mjs.
function fixtureEngine() {
  return {
    generateKeys: () => ({ publicKey: 'fixture', secretKey: 'fixture', relinKeys: 'fixture', galoisKeys: 'fixture' }),
    setClientKeys: () => {}, setEvaluationKeys: () => {},
    encrypt: slots => JSON.stringify(Array.from(slots)),
    score: (encryptedQuery, batches) => {
      const q = JSON.parse(encryptedQuery)
      return batches.flatMap(batch => {
        const packed = JSON.parse(batch.encryptedVector)
        return batch.imageIds.map((id, slot) => ({ id, score: dot(
          Array.from({ length: 512 }, (_, d) => q[d * 8]),
          Array.from({ length: 512 }, (_, d) => packed[d * 8 + slot])) }))
      })
    },
    readScores: rows => rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)),
  }
}

test('live segmented commits seal, merge, search, and sync on a second device', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'segmented-api-test-'))
  const engine = fixtureEngine(), store = new LocalStore(dir)
  const app = await createApp({ store, engine, secret: 'test-only-jwt-secret-not-for-deployment' })
  const request = async (url, body, token) => {
    const response = await app.inject({ method: body === undefined ? 'GET' : 'POST', url, payload: body,
      headers: token ? { authorization: `Bearer ${token}` } : {} })
    const value = response.json()
    if (response.statusCode >= 400) throw Object.assign(new Error(value.error), { statusCode: response.statusCode })
    return value
  }
  try {
    const data = makeDataset({ n: 16, queries: 1 })
    const first = new VaultClient(engine, request, () => {}, { segmentSize: 8 })
    const vaultKey = await first.register('segments@local.test', 'account-password-123')
    const firstUpload = await first.insert(data.records.slice(0, 8).map(row => ({ ...row, image: row.id })))
    assert.equal(firstUpload.mergeCount, 0)
    assert.equal(first.index.runs[0].count, 8)
    const secondUpload = await first.insert(data.records.slice(8).map(row => ({ ...row, image: row.id })))
    assert.equal(secondUpload.mergeCount, 1)
    assert.deepEqual(first.index.runs.map(run => [run.level, run.count]), [[1, 16]])
    assert.equal(first.index.root.count, 16)
    assert.equal(leaves(first.index).reduce((n, leaf) => n + leaf.count, 0), 16)
    const result = await first.search(data.queries[0], { exhaustive: true, k: 5, fetchImages: false })
    assert.deepEqual(result.results.map(row => row.id), data.records.map(row => ({ id: row.id, score: dot(row.vector, data.queries[0]) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 5).map(row => row.id))
    const second = new VaultClient(engine, request)
    await second.login('segments@local.test', 'account-password-123', vaultKey)
    assert.equal(second.index.format, first.index.format)
    assert.equal(second.version, 2)
    assert.equal((await second.search(data.queries[0], { exhaustive: true, k: 5, fetchImages: false })).results.length, 5)
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})

test('buffered encrypted commits query pending rows and survive a seal across devices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buffered-api-test-'))
  const engine = fixtureEngine(), store = new LocalStore(dir)
  const app = await createApp({ store, engine, secret: 'test-only-jwt-secret-not-for-deployment' })
  const indexRequests = []
  const request = async (url, body, token) => {
    const response = await app.inject({ method: body === undefined ? 'GET' : 'POST', url, payload: body,
      headers: token ? { authorization: `Bearer ${token}` } : {} })
    const value = response.json()
    if (response.statusCode >= 400) throw Object.assign(new Error(value.error), { statusCode: response.statusCode })
    if (url.startsWith('/index')) indexRequests.push({ url, bytes: Buffer.byteLength(response.payload) })
    return value
  }
  try {
    const data = makeDataset({ n: 96, queries: 1 })
    const first = new VaultClient(engine, request, () => {}, { bufferedSegmentSize: 64 })
    const key = await first.register('buffered@local.test', 'account-password-123')
    await first.insert(data.records.slice(0, 32).map(row => ({ ...row, image: row.id })))
    assert.equal(first.index.pendingCount, 32)
    assert.equal(first.index.pendingBatchIds.length, 1)
    assert.equal((await first.search(data.queries[0], { nprobe: 1, k: 10, fetchImages: false })).metrics.candidateCount, 32)
    assert.ok(indexRequests.at(-1).url.includes('?since='))
    assert.ok(indexRequests.at(-1).bytes < 256)
    await first.insert(data.records.slice(32, 64).map(row => ({ ...row, image: row.id })))
    assert.equal(first.index.pendingCount, 0)
    assert.deepEqual(first.index.runs.map(run => run.count), [64])
    await first.insert(data.records.slice(64).map(row => ({ ...row, image: row.id })))
    assert.equal(first.index.pendingCount, 32)
    const second = new VaultClient(engine, request)
    await second.login('buffered@local.test', 'account-password-123', key)
    const routed = await second.search(data.queries[0], { nprobe: 1, k: 10, fetchImages: false })
    assert.ok(routed.metrics.candidateCount >= 32)
    const exhaustive = await second.search(data.queries[0], { exhaustive: true, k: 10, fetchImages: false })
    assert.deepEqual(exhaustive.results.map(row => row.id), data.records.map(row => ({ id: row.id, score: dot(row.vector, data.queries[0]) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 10).map(row => row.id))
    await first.insert([{ id: 'extra', vector: data.records[0].vector, image: 'extra' }])
    assert.equal((await second.refresh()).count, 97)
    assert.ok(indexRequests.at(-1).bytes > 256)
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})
