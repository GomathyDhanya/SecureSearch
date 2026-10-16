import test from 'node:test'
import assert from 'node:assert/strict'
import SEAL from 'node-seal'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CKKS, packVectors, packQuery } from '../../shared/ckks.mjs'
import { createIndex, insertRecords, leaves, route, routeGlobal, dot } from '../../shared/index.mjs'
import { makeDataset } from '../../shared/fixtures.mjs'
import { newVaultKey, importVaultKey, encryptJSON, decryptJSON } from '../../shared/crypto.mjs'
import { VaultClient } from '../../shared/vault-client.mjs'
import { LocalStore } from '../storage.mjs'
import { createApp } from '../app.mjs'
import { adaptiveSearch, boundLeaves } from '../../shared/adaptive.mjs'
import { inclusionProbability, selectPrivateLeaves, selectDecoyLeaves, auditPrivateResult } from '../../shared/private-probe.mjs'

test('fixed-size subset mechanism has full support and the claimed likelihood-ratio bound', async () => {
  const index = createIndex({ dimension: 2, capacity: 8 })
  const unit = i => [Math.cos(i * Math.PI / 2), Math.sin(i * Math.PI / 2)]
  await insertRecords(index, Array.from({ length: 32 }, (_, i) => ({ id: `item-${i}`, vector: unit(i % 4) })))
  const allLeaves = leaves(index)
  assert.ok(allLeaves.length >= 4)
  const m = allLeaves.length, b = 2, epsilon = 1.5
  const p = inclusionProbability(m, b, epsilon)
  const actual = selectPrivateLeaves(index, [1, 0], { budget: b, epsilon })
  assert.ok(actual.actualInclusionProbability <= p)
  assert.ok(actual.actualInclusionProbability / (1 - actual.actualInclusionProbability) * (m - b) / b <= Math.exp(epsilon) + 1e-12)
  const probability = (set, target) => set.has(target)
    ? p / (m * (m - 1) / 2 * b / m)
    : (1 - p) / (m * (m - 1) / 2 * (m - b) / m)
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
    const subset = new Set([allLeaves[i].id, allLeaves[j].id])
    for (const a of allLeaves) for (const c of allLeaves)
      assert.ok(probability(subset, a.id) / probability(subset, c.id) <= Math.exp(epsilon) + 1e-12)
  }
  // At epsilon zero, selections from two different queries are statistically indistinguishable.
  const q1 = [1, 0], q2 = [-1, 0], trials = 6000, counts = new Map()
  for (const [label, query] of [['a', q1], ['b', q2]]) {
    for (let i = 0; i < trials; i++) {
      const selected = selectPrivateLeaves(index, query, { budget: b, epsilon: 0 })
      assert.equal(selected.leafIds.length, b)
      const key = `${label}:${selected.leafIds.join(',')}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  const combinations = m * (m - 1) / 2, expected = trials / combinations
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
    const ids = [allLeaves[i].id, allLeaves[j].id].sort().join(',')
    for (const label of ['a', 'b']) assert.ok(Math.abs(counts.get(`${label}:${ids}`) - expected) < 6 * Math.sqrt(expected))
  }
  assert.throws(() => selectPrivateLeaves(index, q1, { budget: 0, epsilon: 1 }))
  assert.throws(() => selectPrivateLeaves(index, q1, { budget: 2, epsilon: -1 }))
  const worst = allLeaves.reduce((a, c) => dot(q1, a.center) < dot(q1, c.center) ? a : c)
  const audit = auditPrivateResult(index, q1, [worst.id], [{ id: 'x', score: -1 }], 1)
  assert.equal(audit.complete, false)
})

test('decoy cover always includes routed leaves, has fixed width, and is correctly distinguished from DP', async () => {
  const index = createIndex({ dimension: 2, capacity: 8 })
  const vectors = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  await insertRecords(index, Array.from({ length: 32 }, (_, i) => ({ id: `d-${i}`, vector: vectors[i % 4] })))
  const query = [1, 0], wanted = route(index, query, 2).leafIds
  for (let i = 0; i < 50; i++) {
    const cover = selectDecoyLeaves(index, query, { budget: 3, required: 2 })
    assert.equal(cover.leafIds.length, 3)
    assert.equal(new Set(cover.leafIds).size, 3)
    for (const id of wanted) assert.ok(cover.leafIds.includes(id))
  }
  assert.throws(() => selectDecoyLeaves(index, query, { budget: 3, required: 4 }))
})

test('numeric near ties can change the winner despite exhaustive coverage; audit retains uncertainty', async () => {
  const index = createIndex({ dimension: 2 }), q = [1, 0], e = 1e-4
  const records = [{ id: 'best', vector: q }, { id: 'near', vector: [Math.cos(.001), Math.sin(.001)] }]
  await insertRecords(index, records)
  const result = await adaptiveSearch(index, q, async () => [
    { id: 'best', score: 1 - e }, { id: 'near', score: Math.cos(.001) + e },
  ], { k: 1, scoreError: e })
  assert.equal(result.scores[0].id, 'near')
  assert.ok(result.audit.exhaustive)
  assert.ok(result.audit.scoreRegretBound >= 1 - Math.cos(.001))
  assert.equal(result.audit.scoreRegretBound, 2 * e)
})

test('private cap bounds survive incremental splits and adaptive budgets never overclaim', async () => {
  for (const kind of ['clustered', 'isotropic']) {
    const index = createIndex({ capacity: 16 }), storage = new Map()
    const { records, queries } = makeDataset({ n: 201, queries: 6, kind })
    for (let start = 0; start < records.length; start += 23) {
      const plan = await insertRecords(index, records.slice(start, start + 23), async id => storage.get(id))
      plan.removed.forEach(id => storage.delete(id)); plan.changed.forEach((v, id) => storage.set(id, v))
      for (const q of queries) for (const bound of boundLeaves(index, q))
        for (const record of storage.get(bound.id)) assert.ok(dot(q, record.vector) <= bound.upper + 1e-10)
    }
    for (const q of queries) {
      const truth = records.map(r => ({ id: r.id, score: dot(q, r.vector) })).sort((a, b) => b.score - a.score)
      const evaluate = async ids => ids.flatMap(id => storage.get(id)).map(r => ({ id: r.id, score: dot(q, r.vector) }))
      const full = await adaptiveSearch(index, q, evaluate, { k: 5 })
      assert.deepEqual(full.scores.slice(0, 5).map(r => r.id), truth.slice(0, 5).map(r => r.id))
      assert.ok(full.audit.unseenExcluded)
      const limited = await adaptiveSearch(index, q, evaluate, { k: 5, maxProbes: 1 })
      assert.equal(limited.audit.visitedLeaves, 1)
      if (limited.scores.length >= 5) assert.ok(truth[4].score - limited.scores[4].score <= limited.audit.scoreRegretBound)
    }
    // Backward-compatible snapshots must never manufacture a pruning certificate.
    leaves(index).forEach(l => { delete l.radius })
    const old = await adaptiveSearch(index, queries[0], async ids => ids.flatMap(id => storage.get(id)).map(r => ({ id: r.id, score: dot(queries[0], r.vector) })))
    assert.ok(old.audit.exhaustive)
    await assert.rejects(adaptiveSearch(index, queries[0].map(x => 2 * x), async () => []))
  }
})

test('incremental splits preserve every record; full probing recovers all leaves', async () => {
  const index = createIndex({ capacity: 16 }), storage = new Map()
  const { records, queries } = makeDataset({ n: 137 })
  for (let start = 0; start < records.length; start += 19) {
    const changes = await insertRecords(index, records.slice(start, start + 19), async id => storage.get(id))
    changes.removed.forEach(id => storage.delete(id)); changes.changed.forEach((value, id) => storage.set(id, value))
  }
  assert.equal(index.root.count, 137)
  assert.equal(new Set([...storage.values()].flat().map(r => r.id)).size, 137)
  assert.equal(leaves(index).reduce((n, l) => n + l.count, 0), 137)
  assert.equal(route(index, queries[0], 10000).candidates, 137)
  assert.equal(routeGlobal(index, queries[0], 10000).candidates, 137)
  const bestCenter = leaves(index).reduce((best, node) =>
    dot(queries[0], node.center) > dot(queries[0], best.center) ? node : best)
  assert.equal(routeGlobal(index, queries[0], 1).leafIds[0], bestCenter.id)
  assert.ok(!JSON.stringify(index).includes('fixture-'))
  const identical = createIndex({ capacity: 8 })
  await insertRecords(identical, records.slice(0, 40).map(r => ({ ...r, vector: records[0].vector })))
  assert.equal(identical.root.count, 40)
})

test('AES-GCM rejects modified payloads, wrong purposes, and wrong vault keys', async () => {
  const key = await importVaultKey(newVaultKey()), other = await importVaultKey(newVaultKey())
  const message = await encryptJSON({ secret: 'private-vector' }, key, 'index:1')
  assert.deepEqual(await decryptJSON(message, key, 'index:1'), { secret: 'private-vector' })
  await assert.rejects(decryptJSON(message, other, 'index:1'))
  await assert.rejects(decryptJSON(message, key, 'index:2'))
  await assert.rejects(decryptJSON({ ...message, ciphertext: `${message.ciphertext[0] === 'A' ? 'B' : 'A'}${message.ciphertext.slice(1)}` }, key, 'index:1'))
})

test('real CKKS reduction, packing, legacy agreement, API upload/search, and second-device login', { timeout: 180000 }, async () => {
  const seal = await SEAL(), clientEngine = new CKKS(seal), serverEngine = new CKKS(seal)
  const keys = clientEngine.generateKeys()
  clientEngine.setClientKeys(keys); serverEngine.setEvaluationKeys(keys)
  const dataset = makeDataset({ n: 19, queries: 1 })
  const batches = []
  for (let i = 0; i < dataset.records.length; i += 8) {
    const records = dataset.records.slice(i, i + 8)
    batches.push({ encryptedVector: clientEngine.encrypt(packVectors(records.map(r => r.vector))), imageIds: records.map(r => r.id) })
  }
  const q = clientEngine.encrypt(packQuery(dataset.queries[0]))
  for (const mode of ['legacy', 'server']) {
    const output = serverEngine.score(q, batches, mode), scores = clientEngine.readScores(output, mode)
    assert.equal(scores.length, 19)
    for (const score of scores) {
      const record = dataset.records.find(r => r.id === score.id)
      assert.ok(Math.abs(score.score - dot(record.vector, dataset.queries[0])) < 1e-4)
    }
    if (mode === 'server') assert.equal(output.length, 1)
  }
  const dir = await mkdtemp(join(tmpdir(), 'securelens-test-')), store = new LocalStore(dir)
  const app = await createApp({ store, engine: serverEngine, secret: 'test-only-jwt-secret-not-for-deployment' })
  const calls = []
  const request = async (url, body, token) => {
    calls.push({ url, body })
    const response = await app.inject({ method: body === undefined ? 'GET' : 'POST', url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} })
    const value = response.json()
    if (response.statusCode >= 400) throw Object.assign(new Error(value.error), { statusCode: response.statusCode })
    return value
  }
  const originalGenerate = clientEngine.generateKeys.bind(clientEngine)
  clientEngine.generateKeys = () => keys
  const first = new VaultClient(clientEngine, request)
  const vaultKey = await first.register('test@local.test', 'account-password-123')
  assert.ok(!JSON.stringify(calls).includes(vaultKey))
  assert.ok(!JSON.stringify(calls).includes(keys.secretKey))
  await first.insert(dataset.records.map(r => ({ ...r, image: `image-${r.id}` })))
  const result = await first.search(dataset.queries[0], { exhaustive: true, k: 5 })
  assert.equal(result.results.length, 5)
  assert.ok(result.results[0].url.startsWith('image-fixture'))
  assert.equal(result.metrics.resultCiphertexts, 1)
  const adaptive = await first.search(dataset.queries[0], { adaptive: true, k: 5, fetchImages: false })
  assert.deepEqual(adaptive.results.map(r => r.id), result.results.map(r => r.id))
  assert.equal(adaptive.metrics.audit.status, 'exhaustive')
  const callCount = calls.length
  const privateResult = await first.search(dataset.queries[0], { privateMode: true, epsilon: 0, privateBudget: 1, k: 5 })
  const searchCalls = calls.slice(callCount).filter(call => call.url === '/search-packed')
  assert.equal(searchCalls.length, 1)
  assert.equal(searchCalls[0].body.privateImages, true)
  assert.equal(searchCalls[0].body.leafIds.length, 1)
  assert.ok(!JSON.stringify(searchCalls[0].body).includes('preferredId'))
  assert.equal(calls.slice(callCount).filter(call => call.url.startsWith('/images/')).length, 0)
  assert.equal(privateResult.results.length, 5)
  assert.ok(privateResult.results.every(result => result.url.startsWith('image-fixture')))
  assert.equal(privateResult.metrics.privacy.epsilon, 0)
  assert.equal(privateResult.metrics.candidateCount, 19)
  const decoyCallCount = calls.length
  const decoyResult = await first.search(dataset.queries[0], { privateMode: true, coverPolicy: 'decoy',
    privateBudget: 1, requiredLeaves: 1, k: 5 })
  assert.equal(calls.slice(decoyCallCount).filter(call => call.url === '/search-packed').length, 1)
  assert.equal(calls.slice(decoyCallCount).filter(call => call.url.startsWith('/images/')).length, 0)
  assert.equal(decoyResult.metrics.privacy.policy, 'decoy')
  assert.equal(decoyResult.metrics.privacy.preferredIncludedProbability, 1)
  assert.equal(decoyResult.metrics.privacy.epsilon, undefined)
  assert.deepEqual(decoyResult.results.map(x => x.id), result.results.map(x => x.id))
  assert.equal((await app.inject({ url: '/index' })).statusCode, 401)
  const second = new VaultClient(clientEngine, request)
  await assert.rejects(second.login('test@local.test', 'account-password-123', newVaultKey()))
  await second.login('test@local.test', 'account-password-123', vaultKey)
  assert.equal(second.index.root.count, 19)
  assert.equal(second.version, 1)
  await assert.rejects(request('/search-packed', { queryVector: q, leafIds: null, expectedVersion: 0 }, second.token), e => e.statusCode === 409)
  const oldHead = await store.getHead(first.token ? (await app.jwt.verify(first.token)).id : '')
  const account = (await app.jwt.verify(first.token)).id
  const concurrent = await Promise.allSettled([store.commit(account, 1, { ...oldHead, version: 2 }), store.commit(account, 1, { ...oldHead, version: 2 })])
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1)
  clientEngine.generateKeys = originalGenerate
  await app.close(); clientEngine.delete(); serverEngine.delete(); await rm(dir, { recursive: true, force: true })
})
