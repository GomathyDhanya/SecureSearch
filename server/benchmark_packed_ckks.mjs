import createCKKSEngine from './ckks_node.js'
import { performance } from 'node:perf_hooks'

const D = 512
const PACK = 8
const SLOTS = D * PACK
const N = Number(process.env.N || 80)
const Q = Number(process.env.Q || 10)
const K = Number(process.env.K || 10)
const SEED = Number(process.env.SEED || 20260919)

function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const rng = mulberry32(SEED)

function randn() {
  let u = 0, v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function normalizedVector() {
  const x = new Array(D)
  let ss = 0
  for (let i = 0; i < D; i++) {
    const z = randn()
    x[i] = z
    ss += z * z
  }
  const inv = 1 / Math.sqrt(ss)
  for (let i = 0; i < D; i++) x[i] *= inv
  return x
}

function dot(a, b) {
  let s = 0
  for (let i = 0; i < D; i++) s += a[i] * b[i]
  return s
}

function packVectors(vectors) {
  const packed = new Array(SLOTS).fill(0)
  vectors.forEach((v, b) => {
    const offset = b * D
    for (let i = 0; i < D; i++) packed[offset + i] = v[i]
  })
  return packed
}

function replicateQuery(q) {
  const packed = new Array(SLOTS)
  for (let b = 0; b < PACK; b++) {
    const offset = b * D
    for (let i = 0; i < D; i++) packed[offset + i] = q[i]
  }
  return packed
}

function topK(scores) {
  return scores
    .map((score, i) => ({ score, i }))
    .sort((a, b) => b.score - a.score)
    .slice(0, K)
    .map(x => x.i)
}

function overlap(a, b) {
  const B = new Set(b)
  return a.filter(x => B.has(x)).length / K
}

const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length

function percentile(xs, p) {
  const a = [...xs].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)]
}

function decodedBytes(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor(base64.length * 3 / 4) - padding
}

console.log('\nSecureSearch PACKED CKKS benchmark')
console.log(`Vectors=${N}, Queries=${Q}, Dimension=${D}, Pack=${PACK}, TopK=${K}\n`)

const module = await createCKKSEngine()
const engine = new module.CKKSEngine(8192)

let t = performance.now()
const keys = engine.generateKeys()
const keygenMs = performance.now() - t

const db = Array.from({ length: N }, normalizedVector)

const batches = []
for (let i = 0; i < N; i += PACK) {
  batches.push(db.slice(i, i + PACK))
}

const encryptedBatches = []
const batchEncryptTimes = []

console.log(`Encrypting ${batches.length} packed ciphertexts for ${N} vectors...`)

for (const batch of batches) {
  t = performance.now()
  encryptedBatches.push(
    engine.encrypt(packVectors(batch), keys.publicKey)
  )
  batchEncryptTimes.push(performance.now() - t)
}

const queryEncryptTimes = []
const computeTimes = []
const decryptTimes = []
const totalTimes = []
const plainTimes = []
const agreements = []
const top1 = []
const errors = []

for (let qi = 0; qi < Q; qi++) {
  console.log(`Query ${qi + 1}/${Q}`)

  const q = normalizedVector()

  t = performance.now()
  const plain = db.map(v => dot(q, v))
  plainTimes.push(performance.now() - t)

  t = performance.now()
  const encQ = engine.encrypt(replicateQuery(q), keys.publicKey)
  const qEnc = performance.now() - t
  queryEncryptTimes.push(qEnc)

  t = performance.now()
  const products = encryptedBatches.map(encDb =>
    engine.computeDotProduct(encQ, encDb, keys.relinKeys)
  )
  const comp = performance.now() - t
  computeTimes.push(comp)

  t = performance.now()
  const encryptedScores = []

  products.forEach((product, batchIndex) => {
    const slots = engine.decrypt(product, keys.secretKey)
    const actualCount = batches[batchIndex].length

    for (let b = 0; b < actualCount; b++) {
      const offset = b * D
      let sum = 0
      for (let d = 0; d < D; d++) sum += slots[offset + d]
      encryptedScores.push(sum)
    }
  })

  const dec = performance.now() - t
  decryptTimes.push(dec)

  totalTimes.push(qEnc + comp + dec)

  let mae = 0
  for (let i = 0; i < N; i++) {
    mae += Math.abs(plain[i] - encryptedScores[i])
  }
  errors.push(mae / N)

  const p = topK(plain)
  const e = topK(encryptedScores)
  agreements.push(overlap(p, e))
  top1.push(p[0] === e[0] ? 1 : 0)
}

const plaintextBytes = D * 4
const oneCipherWire = Buffer.byteLength(encryptedBatches[0], 'utf8')
const oneCipherRaw = decodedBytes(encryptedBatches[0])

const result = {
  configuration: {
    vectors: N,
    batches: batches.length,
    packSize: PACK,
    queries: Q,
    dimension: D,
    topK: K,
  },
  quality: {
    top1AgreementPercent: 100 * avg(top1),
    topKAgreementPercent: 100 * avg(agreements),
    meanAbsoluteScoreError: avg(errors),
  },
  latencyMs: {
    keyGeneration: keygenMs,
    packedBatchEncryptionAverage: avg(batchEncryptTimes),
    queryEncryptionAverage: avg(queryEncryptTimes),
    plaintextSearchAverage: avg(plainTimes),
    encryptedServerComputeAverage: avg(computeTimes),
    clientDecryptReduceAverage: avg(decryptTimes),
    packedSearchAverage: avg(totalTimes),
    packedSearchP50: percentile(totalTimes, 50),
    packedSearchP95: percentile(totalTimes, 95),
    encryptedComputePerBatch: avg(computeTimes) / batches.length,
    effectiveEncryptedComputePerVector: avg(computeTimes) / N,
  },
  storage: {
    ciphertextRawBytesPerBatch: oneCipherRaw,
    ciphertextWireBytesPerBatch: oneCipherWire,
    effectiveRawBytesPerVectorAtFullPack: oneCipherRaw / PACK,
    effectiveWireBytesPerVectorAtFullPack: oneCipherWire / PACK,
    plaintextFloat32BytesPerVector: plaintextBytes,
    effectiveWireExpansionAtFullPack:
      (oneCipherWire / PACK) / plaintextBytes,
  },
}

console.log('\n==============================')
console.log('PACKED RESULTS')
console.log('==============================\n')
console.log(JSON.stringify(result, null, 2))

console.log('\n==============================')
console.log('SUMMARY')
console.log('==============================\n')

console.log(`Top-${K} agreement: ${result.quality.topKAgreementPercent.toFixed(2)}%`)
console.log(`Top-1 agreement: ${result.quality.top1AgreementPercent.toFixed(2)}%`)
console.log(`Packed search avg: ${result.latencyMs.packedSearchAverage.toFixed(2)} ms`)
console.log(`Packed search p95: ${result.latencyMs.packedSearchP95.toFixed(2)} ms`)
console.log(`Effective HE compute/vector: ${result.latencyMs.effectiveEncryptedComputePerVector.toFixed(2)} ms`)
console.log(`Effective wire storage expansion: ${result.storage.effectiveWireExpansionAtFullPack.toFixed(1)}x`)

if (engine.delete) engine.delete()
