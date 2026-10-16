import { adaptiveSearch } from '../shared/adaptive.mjs'
import SEAL from 'node-seal'
import { mkdir, writeFile } from 'node:fs/promises'
import { cpus, platform, arch, totalmem } from 'node:os'
import { CKKS, packVectors, packQuery, PACK } from '../shared/ckks.mjs'
import { createIndex, insertRecords, route, indexStats, dot } from '../shared/index.mjs'
import { makeDataset } from '../shared/fixtures.mjs'
import { newVaultKey, importVaultKey, encryptJSON } from '../shared/crypto.mjs'

const N = Number(process.env.N || 1024), Q = Number(process.env.Q || 8), K = 10
const seeds = (process.env.SEEDS || '42').split(',').map(Number)
const kinds = (process.env.KINDS || 'clustered,isotropic').split(',')
const probes = (process.env.PROBES || '1,2,4,8').split(',').map(Number)
if (!Number.isInteger(N) || N < K || !Number.isInteger(Q) || Q < 1) throw new Error('N >= 10 and Q >= 1 required')
const output = process.env.OUT || '../benchmarks/ann-results.json'
const avg = a => a.reduce((s, x) => s + x, 0) / a.length
const percentile = (a, p) => [...a].sort((x, y) => x - y)[Math.max(0, Math.ceil(a.length * p) - 1)]
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const seal = await SEAL(), client = new CKKS(seal), server = new CKKS(seal)
let t = performance.now(); const keys = client.generateKeys(), keygenMs = performance.now() - t
client.setClientKeys(keys); t = performance.now(); server.setEvaluationKeys(keys); const evaluationKeyLoadMs = performance.now() - t
const vaultKey = await importVaultKey(newVaultKey())
const runs = []
for (const kind of kinds) for (const seed of seeds) {
  console.log(`Building ${kind}: N=${N}, Q=${Q}, seed=${seed}`)
  const { records, queries } = makeDataset({ n: N, queries: Q, seed, kind })
  const index = createIndex(), plainLeaves = new Map(), encryptedLeaves = new Map(), updates = []
  for (let start = 0; start < N; start += 128) {
    const begin = performance.now()
    const plan = await insertRecords(index, records.slice(start, start + 128), async id => plainLeaves.get(id))
    const clusteringMs = performance.now() - begin
    plan.removed.forEach(id => { plainLeaves.delete(id); encryptedLeaves.delete(id) })
    let rewrittenVectors = 0
    for (const [id, members] of plan.changed) {
      plainLeaves.set(id, members); rewrittenVectors += members.length
      const batches = []
      for (let i = 0; i < members.length; i += PACK) {
        const group = members.slice(i, i + PACK)
        batches.push({ imageIds: group.map(r => r.id), encryptedVector: client.encrypt(packVectors(group.map(r => r.vector))) })
      }
      encryptedLeaves.set(id, { batches, encryptedRecords: await encryptJSON(members, vaultKey, `leaf:${id}`) })
    }
    await encryptJSON(index, vaultKey, 'benchmark-index')
    updates.push({ inserted: Math.min(128, N - start), clusteringMs, encryptAndClusterMs: performance.now() - begin, rewrittenVectors, splits: plan.splits })
  }
  const all = [...encryptedLeaves.values()].flatMap(l => l.batches)
  // Warm up every mode; exclude these observations from measured rows.
  const warmQuery = client.encrypt(packQuery(queries[0]))
  for (const mode of ['server', 'legacy']) client.readScores(server.score(warmQuery, all.slice(0, 2), mode), mode)
  const measurements = []
  const configs = [{ name: 'scan-legacy', mode: 'legacy' }, { name: 'scan-server', mode: 'server' }, ...probes.map(nprobe => ({ name: `ann-${nprobe}`, mode: 'server', nprobe })), { name: 'adaptive', mode: 'server', adaptive: true }, { name: 'adaptive-budget-4', mode: 'server', adaptive: true, maxProbes: 4 }]
  for (let qi = 0; qi < Q; qi++) {
    const query = queries[qi]
    const truth = records.map(r => ({ id: r.id, score: dot(r.vector, query) })).sort((a, b) => b.score - a.score).slice(0, K)
    const truthIds = new Set(truth.map(r => r.id)), byId = new Map(records.map(r => [r.id, r.vector]))
    // Rotate configuration order to avoid always giving one variant a warm CPU.
    const order = [...configs.slice(qi % configs.length), ...configs.slice(0, qi % configs.length)]
    for (const config of order) {
      t = performance.now()
      const routing = config.nprobe ? route(index, query, config.nprobe) : { leafIds: null, comparisons: 0 }
      let routingMs = performance.now() - t
      t = performance.now(); const encQuery = client.encrypt(packQuery(query)); const queryEncryptMs = performance.now() - t
      let serverMs = 0, clientDecryptRankMs = 0, batchCount = 0, responseBytes = 0, responseCiphertexts = 0, scores, audit
      const evaluate = async leafIds => {
        const batches = leafIds ? leafIds.flatMap(id => encryptedLeaves.get(id).batches) : all
        batchCount += batches.length
        let begin = performance.now(); const results = server.score(encQuery, batches, config.mode); serverMs += performance.now() - begin
        begin = performance.now(); const found = client.readScores(results, config.mode); clientDecryptRankMs += performance.now() - begin
        responseBytes += bytes(results); responseCiphertexts += results.length
        return found
      }
      if (config.adaptive) {
        const begin = performance.now()
        const found = await adaptiveSearch(index, query, evaluate, { k: K, maxProbes: config.maxProbes })
        scores = found.scores; audit = found.audit
        routingMs += Math.max(0, performance.now() - begin - serverMs - clientDecryptRankMs)
      } else scores = await evaluate(routing.leafIds)
      const maxError = Math.max(0, ...scores.map(r => Math.abs(r.score - dot(query, byId.get(r.id)))))
      const recall = scores.slice(0, K).filter(r => truthIds.has(r.id)).length / truthIds.size
      measurements.push({ query: qi, config: config.name, candidates: scores.length, batches: batchCount, routingMs, queryEncryptMs, serverMs,
        clientDecryptRankMs, localPipelineMs: routingMs + queryEncryptMs + serverMs + clientDecryptRankMs, recall, maxError,
        responseBytes, responseCiphertexts, audit, comparisons: routing.comparisons })
    }
    console.log(`${kind} query ${qi + 1}/${Q} complete`)
  }
  const summaries = configs.map(config => {
    const rows = measurements.filter(r => r.config === config.name)
    return { config: config.name, recallAt10: avg(rows.map(r => r.recall)), candidates: avg(rows.map(r => r.candidates)),
      serverMeanMs: avg(rows.map(r => r.serverMs)), serverP95Ms: percentile(rows.map(r => r.serverMs), .95),
      clientRouteMeanMs: avg(rows.map(r => r.routingMs)), clientDecryptRankMeanMs: avg(rows.map(r => r.clientDecryptRankMs)),
      pipelineMeanMs: avg(rows.map(r => r.localPipelineMs)), responseMeanBytes: avg(rows.map(r => r.responseBytes)),
      meanRounds: avg(rows.map(r => r.audit?.rounds ?? 1)), boundedFraction: rows.filter(r => r.audit?.status === 'bounded').length / rows.length,
      maxScoreError: Math.max(...rows.map(r => r.maxError)) }
  })
  runs.push({ kind, seed, index: indexStats(index), storedCiphertextBytes: bytes([...encryptedLeaves.values()]), updates, summaries, measurements })
  console.table(summaries.map(s => ({ config: s.config, recall: s.recallAt10.toFixed(3), candidates: Math.round(s.candidates), serverMs: Math.round(s.serverMeanMs), clientMs: s.clientDecryptRankMeanMs.toFixed(2), responseKiB: Math.round(s.responseMeanBytes / 1024) })))
}
const report = { generatedAt: new Date().toISOString(), environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model, totalMemoryBytes: totalmem(), processPeakRSSKiB: process.resourceUsage().maxRSS },
  config: { N, Q, K, dimension: 512, capacity: 64, branching: 4, probes, seeds, kinds },
  scope: 'Actual CKKS microbenchmark, synthetic vectors. Excludes image embedding, image fetch, HTTP/storage, device sync, and cold key loading. No production-security or real-image recall claim.',
  keygenMs, evaluationKeyLoadMs, evaluationKeyBytes: keys.relinKeys.length + keys.galoisKeys.length, runs }
await mkdir(new URL('../benchmarks/', import.meta.url), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2))
console.log(`Saved ${output}`)
client.delete(); server.delete()
