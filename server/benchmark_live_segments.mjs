// Real encrypted upload/search pilot on public COCO embeddings. Image bytes are
// fixture strings so this isolates the vector-index protocol, not media upload.
import SEAL from 'node-seal'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { CKKS } from '../shared/ckks.mjs'
import { VaultClient } from '../shared/vault-client.mjs'
import { dot } from '../shared/index.mjs'
import { LocalStore } from './storage.mjs'
import { createApp } from './app.mjs'

const datasetDir = resolve(process.env.COCO_OUT || '../benchmarks/coco-val2017')
const imageLimit = Number(process.env.BENCH_LIVE_IMAGES || 256)
const queryLimit = Number(process.env.BENCH_LIVE_QUERIES || 5)
const segmentSize = Number(process.env.BENCH_LIVE_SEGMENT_SIZE || 64)
const scenarioNames = (process.env.BENCH_LIVE_SCENARIOS || 'monolithic,scheduled-merge').split(',')
const nprobe = Number(process.env.BENCH_LIVE_PROBES || 4)
const exhaustiveCompare = process.env.BENCH_LIVE_EXHAUSTIVE === '1'
const outputPath = resolve(process.env.BENCH_LIVE_OUTPUT || '../benchmarks/COCO_LIVE_SEGMENT_PILOT.json')
if (!Number.isInteger(imageLimit) || imageLimit < 64 || !Number.isInteger(queryLimit) || queryLimit < 1 ||
    !Number.isInteger(segmentSize) || segmentSize < 64 || imageLimit % 64 ||
    !Number.isInteger(nprobe) || nprobe < 1 ||
    scenarioNames.some(name => !['monolithic', 'scheduled-merge', 'opaque-buffer', 'flat-scan'].includes(name)) ||
    new Set(scenarioNames).size !== scenarioNames.length) throw new Error('Invalid pilot configuration')

const imageRows = (await readFile(join(datasetDir, 'images.jsonl'), 'utf8')).trim().split('\n')
  .slice(0, imageLimit).map(JSON.parse)
const ids = new Set(imageRows.map(row => row.id))
const oneCaptionPerImage = new Map()
for (const line of (await readFile(join(datasetDir, 'captions.jsonl'), 'utf8')).trim().split('\n')) {
  const row = JSON.parse(line)
  if (ids.has(row.imageId) && !oneCaptionPerImage.has(row.imageId)) oneCaptionPerImage.set(row.imageId, row)
}
const eligible = imageRows.map(row => oneCaptionPerImage.get(row.id)).filter(Boolean)
if (eligible.length < queryLimit) throw new Error('Too few distinct captioned images for selected prefix')
const captions = Array.from({ length: queryLimit }, (_, i) =>
  eligible[Math.floor((i + .5) * eligible.length / queryLimit)])
const exact = captions.map(caption => imageRows.map(row => ({ id: String(row.id), score: dot(caption.vector, row.vector) }))
  .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 10).map(row => row.id))
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1]
const seal = await SEAL(), clientEngine = new CKKS(seal), serverEngine = new CKKS(seal)
const keygenStart = performance.now(), keys = clientEngine.generateKeys()
const keygenMs = performance.now() - keygenStart
clientEngine.generateKeys = () => keys
const scenarios = []
try {
  for (const name of scenarioNames) {
    console.log(`Starting ${name}: ${imageRows.length} COCO embeddings, ${captions.length} queries`)
    const dir = await mkdtemp(join(tmpdir(), `coco-live-${name}-`))
    const store = new LocalStore(dir)
    const app = await createApp({ store, engine: serverEngine, secret: 'benchmark-only-jwt-secret' })
    const traffic = { commitBytes: 0, leafDownloadBytes: 0, indexDownloadBytes: 0, searchRequestBytes: 0, searchResponseBytes: 0 }
    const request = async (url, body, token) => {
      const payloadBytes = body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body))
      const response = await app.inject({ method: body === undefined ? 'GET' : 'POST', url, payload: body,
        headers: token ? { authorization: `Bearer ${token}` } : {} })
      const parsed = response.json()
      if (response.statusCode >= 400) throw Object.assign(new Error(parsed.error), { statusCode: response.statusCode })
      if (url === '/commit') traffic.commitBytes += payloadBytes
      if (url.startsWith('/leaves/')) traffic.leafDownloadBytes += Buffer.byteLength(response.payload)
      if (url.startsWith('/index')) traffic.indexDownloadBytes += Buffer.byteLength(response.payload)
      if (url === '/search-packed') {
        traffic.searchRequestBytes += payloadBytes
        traffic.searchResponseBytes += Buffer.byteLength(response.payload)
      }
      return parsed
    }
    try {
      const client = new VaultClient(clientEngine, request, () => {}, {
        segmentSize: name === 'scheduled-merge' ? segmentSize : 0,
        bufferedSegmentSize: name === 'opaque-buffer' ? segmentSize : name === 'flat-scan' ? imageRows.length + 64 : 0 })
      await client.register(`${name}@benchmark.test`, 'benchmark-password-123')
      const updates = []
      for (let i = 0; i < imageRows.length; i += 64) {
        const rows = imageRows.slice(i, i + 64).map(row => ({ id: String(row.id), vector: row.vector,
          image: `COCO-image-${row.id}` }))
        updates.push(await client.insert(rows, { embeddingSpace: 'COCO CLIP ViT-B/32 q8' }))
        console.log(`${name}: uploaded ${Math.min(i + 64, imageRows.length)}/${imageRows.length}`)
      }
      const queries = [], exhaustiveQueries = []
      for (let i = 0; i < captions.length; i++) {
        const result = await client.search(captions[i].vector, { nprobe, k: 10, fetchImages: false })
        const retrieved = new Set(result.results.map(row => row.id))
        queries.push({ captionId: captions[i].id, annRecall10: exact[i].filter(id => retrieved.has(id)).length / 10,
          candidates: result.metrics.candidateCount, searchMs: result.metrics.searchMs,
          serverComputeMs: result.metrics.computeMs })
        if (exhaustiveCompare && name !== 'flat-scan') {
          const full = await client.search(captions[i].vector, { exhaustive: true, k: 10, fetchImages: false })
          const fullIds = new Set(full.results.map(row => row.id))
          exhaustiveQueries.push({ captionId: captions[i].id,
            exhaustiveRecall10: exact[i].filter(id => fullIds.has(id)).length / 10,
            candidates: full.metrics.candidateCount, searchMs: full.metrics.searchMs,
            serverComputeMs: full.metrics.computeMs })
        }
        console.log(`${name}: encrypted query ${i + 1}/${captions.length}`)
      }
      const account = (await app.jwt.verify(client.token)).id
      const head = await store.getHead(account)
      const fullIndexResponseBytes = Buffer.byteLength(JSON.stringify({ version: head.version,
        encryptedIndex: head.encryptedIndex, count: head.count, leafCount: Object.keys(head.leaves).length }))
      const ciphertextVectorBytes = (await Promise.all(Object.values(head.leaves).map(async ref => {
        const blob = await store.getBlob(ref.key)
        return blob.batches.reduce((n, batch) => n + Buffer.byteLength(batch.encryptedVector), 0)
      }))).reduce((a, b) => a + b, 0)
      scenarios.push({ name, imageCount: imageRows.length, finalLeaves: Object.keys(head.leaves).length,
        fullIndexResponseBytes,
        storedVectorCiphertextBytes: ciphertextVectorBytes, traffic, updates, queries, exhaustiveQueries,
        summary: { meanAnnRecall10: mean(queries.map(q => q.annRecall10)),
          meanCandidateFraction: mean(queries.map(q => q.candidates / imageRows.length)),
          meanServerComputeMs: mean(queries.map(q => q.serverComputeMs)),
          p50SearchMs: percentile(queries.map(q => q.searchMs), .5),
          p95SearchMs: percentile(queries.map(q => q.searchMs), .95),
          ...(exhaustiveQueries.length ? {
            meanExhaustiveRecall10: mean(exhaustiveQueries.map(q => q.exhaustiveRecall10)),
            meanExhaustiveServerComputeMs: mean(exhaustiveQueries.map(q => q.serverComputeMs)),
            p50ExhaustiveSearchMs: percentile(exhaustiveQueries.map(q => q.searchMs), .5),
            p95ExhaustiveSearchMs: percentile(exhaustiveQueries.map(q => q.searchMs), .95),
          } : {}),
          rewrittenVectors: updates.reduce((n, update) => n + (update.rewrittenVectors ?? 0), 0) } })
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
  }
} finally { clientEngine.delete(); serverEngine.delete() }
const report = { scope: 'Real CKKS, AES-GCM, HTTP-inject, and local persistence on a COCO val2017 image prefix. Image blobs are fixture strings; no network transport or model inference. This is a small-scale pilot, not a scaling result.',
  generatedAt: new Date().toISOString(), dataset: 'MS COCO val2017 captions', imageLimit, queryLimit, segmentSize, nprobe, exhaustiveCompare,
  hardware: { cpu: cpus()[0]?.model, node: process.version }, keygenMs, scenarios }
await writeFile(outputPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ outputPath, keygenMs, scenarios: scenarios.map(({ name, traffic, summary }) => ({ name, traffic, summary })) }, null, 2))
