// Relevance: official COCO caption -> its image. ANN truth: exhaustive cosine
// top-10 over the *same* CLIP embeddings. No synthetic data enters this run.
import { readFile, writeFile, stat, open, access } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { cpus, platform, arch } from 'node:os'
import { createIndex, insertRecords, route, dot, leaves, indexStats } from '../shared/index.mjs'
import { createSegmentedIndex, insertSegmented } from '../shared/segments.mjs'
import { createBufferedIndex, insertBuffered } from '../shared/buffered-segments.mjs'
import { preparePrivateQuery, prepareDecoyQuery } from '../shared/private-probe.mjs'
import { CKKS, packVectors, packQuery, PACK } from '../shared/ckks.mjs'

const dir = resolve(process.env.COCO_OUT || '../benchmarks/coco-val2017')
const queryLimit = Number(process.env.BENCH_QUERIES || Infinity)
const imageLimit = Number(process.env.BENCH_IMAGE_LIMIT || Infinity)
const privateTrials = Number(process.env.BENCH_PRIVATE_TRIALS || 20)
const heQueries = Number(process.env.BENCH_HE_QUERIES || 0)
const heFullQueries = Number(process.env.BENCH_HE_FULL_QUERIES || 0)
const heGlobalProbes = Number(process.env.BENCH_HE_GLOBAL_PROBES || 0)
const heOnlyGlobal = process.env.BENCH_HE_ONLY_GLOBAL === '1'
const budget = Number(process.env.BENCH_BUDGET || 4)
const segmentSize = Number(process.env.BENCH_SEGMENT_SIZE || 0)
const liveSegmentSize = Number(process.env.BENCH_LIVE_SEGMENT_SIZE || 0)
const bufferedSegmentSize = Number(process.env.BENCH_BUFFERED_SEGMENT_SIZE || 0)
const segmentMerge = process.env.BENCH_SEGMENT_MERGE === '1'
const insertSeed = Number(process.env.BENCH_INSERT_SEED || 0)
const fixedProbes = (process.env.BENCH_FIXED_PROBES || '1,2,4,8') === 'none' ? [] :
  (process.env.BENCH_FIXED_PROBES || '1,2,4,8').split(',').map(Number)
const globalProbes = (process.env.BENCH_GLOBAL_PROBES || '').split(',').filter(Boolean).map(Number)
const balancedProbes = (process.env.BENCH_BALANCED_PROBES || '').split(',').filter(Boolean).map(Number)
const privateEpsilons = process.env.BENCH_PRIVATE_EPSILONS === 'none' ? [] :
  (process.env.BENCH_PRIVATE_EPSILONS || '0,1,2,4').split(',').map(Number)
const decoyRequired = (process.env.BENCH_DECOY_REQUIRED || '').split(',').filter(Boolean).map(Number)
const imageDir = process.env.BENCH_IMAGE_DIR ? resolve(process.env.BENCH_IMAGE_DIR) : null
if (!(queryLimit === Infinity || Number.isInteger(queryLimit) && queryLimit > 0) ||
    !(imageLimit === Infinity || Number.isInteger(imageLimit) && imageLimit > 0) ||
    !Number.isInteger(privateTrials) || privateTrials < 1 || !Number.isInteger(heQueries) || heQueries < 0 ||
    !Number.isInteger(heFullQueries) || heFullQueries < 0 || !Number.isInteger(heGlobalProbes) || heGlobalProbes < 0 ||
    !Number.isInteger(budget) || budget < 1 ||
    !Number.isInteger(segmentSize) || segmentSize < 0 || segmentSize > 0 && segmentSize < 64 ||
    !Number.isInteger(liveSegmentSize) || liveSegmentSize < 0 || liveSegmentSize > 0 && liveSegmentSize < 64 ||
    !Number.isInteger(bufferedSegmentSize) || bufferedSegmentSize < 0 || bufferedSegmentSize > 0 && bufferedSegmentSize < 64 ||
    Number(Boolean(liveSegmentSize)) + Number(Boolean(segmentSize)) + Number(Boolean(bufferedSegmentSize)) > 1 ||
    bufferedSegmentSize && (fixedProbes.length || privateEpsilons.length || decoyRequired.length || balancedProbes.length || heQueries || heFullQueries) ||
    segmentMerge && !segmentSize ||
    !Number.isInteger(insertSeed) || insertSeed < 0 || insertSeed > 0xffffffff ||
    decoyRequired.some(x => !Number.isInteger(x) || x < 1 || x > budget) ||
    fixedProbes.some(x => !Number.isInteger(x) || x < 1) ||
    globalProbes.some(x => !Number.isInteger(x) || x < 1) ||
    balancedProbes.some(x => !Number.isInteger(x) || x < 1) ||
    privateEpsilons.some(x => !Number.isFinite(x) || x < 0 || x > 20))
  throw new Error('Invalid benchmark limits')
const readRows = async name => (await readFile(join(dir, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json')))
const allImages = await readRows('images.jsonl'), captions = await readRows('captions.jsonl')
const allImageIds = new Set(allImages.map(x => x.id))
if (allImages.length !== manifest.imageCount || captions.length !== manifest.captionCount ||
    allImageIds.size !== allImages.length || new Set(captions.map(x => x.id)).size !== captions.length ||
    captions.some(c => !allImageIds.has(c.imageId))) throw new Error('Incomplete or inconsistent COCO embeddings')
const images = allImages.slice(0, imageLimit), currentIds = new Set(images.map(x => x.id))
const insertImages = [...images]
if (insertSeed) {
  let state = insertSeed >>> 0
  const nextRandom = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0 }
  for (let i = insertImages.length - 1; i > 0; i--) {
    const j = nextRandom() % (i + 1)
    ;[insertImages[i], insertImages[j]] = [insertImages[j], insertImages[i]]
  }
}
const queries = captions.map((caption, sourceIndex) => ({ ...caption, sourceIndex }))
  .filter(caption => currentIds.has(caption.imageId)).slice(0, queryLimit)
const scorePath = resolve(process.env.BENCH_SCORE_MATRIX || join(dir, 'scores.f64'))
let scoreFile = null, scoreBuffer = null, scoreMetadata = null
async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
try { await access(scorePath) } catch { if (process.env.BENCH_SCORE_MATRIX) throw new Error('Specified score matrix is missing') }
try {
  scoreMetadata = JSON.parse(await readFile(join(dir, 'scores-metadata.json')))
  if (scoreMetadata.dtype !== 'float64-le' || scoreMetadata.shape[0] !== captions.length ||
      scoreMetadata.shape[1] !== allImages.length || scoreMetadata.annotationSha256 !== manifest.annotationSha256 ||
      scoreMetadata.imageIdsSha256 !== manifest.imageIdsSha256 ||
      scoreMetadata.captionIdsSha256 !== manifest.captionIdsSha256 ||
      scoreMetadata.imageEmbeddingsSha256 !== await sha256(join(dir, 'images.jsonl')) ||
      scoreMetadata.captionEmbeddingsSha256 !== await sha256(join(dir, 'captions.jsonl')) ||
      (await stat(scorePath)).size !== captions.length * allImages.length * 8)
    throw new Error('Score matrix does not match prepared COCO embeddings')
  scoreFile = await open(scorePath, 'r')
  scoreBuffer = Buffer.allocUnsafe(allImages.length * 8)
} catch (error) { if (process.env.BENCH_SCORE_MATRIX || error.message.includes('does not match')) throw error; scoreMetadata = null }
const rawImageBytes = new Map()
if (imageDir) for (const image of images)
  rawImageBytes.set(String(image.id), (await stat(join(imageDir, image.file))).size)
let index = createIndex()
const byLeaf = new Map(), updates = []
if (bufferedSegmentSize) {
  index = createBufferedIndex({ segmentSize: bufferedSegmentSize })
  for (let start = 0; start < insertImages.length;) {
    const count = Math.min(64, insertImages.length - start, bufferedSegmentSize - index.pendingCount)
    const begun = performance.now()
    const plan = await insertBuffered(index, insertImages.slice(start, start + count)
      .map(image => ({ id: String(image.id), vector: image.vector })), id => byLeaf.get(id))
    plan.removed.forEach(id => byLeaf.delete(id))
    for (const [id, members] of plan.changed) byLeaf.set(id, members)
    updates.push({ count, changedLeaves: plan.changed.size,
      rewrittenVectors: [...plan.changed.values()].reduce((n, group) => n + group.length, 0),
      fetchedVectors: plan.fetchedVectors, splits: plan.splits, merges: plan.mergeCount,
      sealed: plan.sealed, pendingCount: index.pendingCount,
      milliseconds: performance.now() - begun })
    start += count
  }
} else if (liveSegmentSize) {
  index = createSegmentedIndex({ segmentSize: liveSegmentSize })
  for (let start = 0; start < insertImages.length;) {
    const pending = index.root.children.find(node => node.id === index.pendingRootId)
    const count = Math.min(64, insertImages.length - start, liveSegmentSize - pending.count)
    const begun = performance.now()
    const plan = await insertSegmented(index, insertImages.slice(start, start + count)
      .map(image => ({ id: String(image.id), vector: image.vector })), id => byLeaf.get(id))
    plan.removed.forEach(id => byLeaf.delete(id))
    for (const [id, members] of plan.changed) byLeaf.set(id, members)
    updates.push({ count, changedLeaves: plan.changed.size,
      rewrittenVectors: [...plan.changed.values()].reduce((n, group) => n + group.length, 0),
      fetchedVectors: plan.fetchedVectors, splits: plan.splits, merges: plan.mergeCount,
      sealed: plan.sealed, milliseconds: performance.now() - begun })
    start += count
  }
} else if (segmentSize) {
  const segments = [], levels = new Map()
  const buildSegment = async rows => {
    const segment = createIndex()
    const plan = await insertRecords(segment, rows.map(image => ({ id: String(image.id), vector: image.vector })))
    return { index: segment, rows, leafMembers: plan.changed, splits: plan.splits }
  }
  for (let start = 0; start < insertImages.length; start += segmentSize) {
    const batch = insertImages.slice(start, start + segmentSize)
    const begun = performance.now()
    let built = await buildSegment(batch), level = 0, rewrittenVectors = batch.length * 2
    let fetchedVectors = batch.length, splits = built.splits
    if (segmentMerge) while (levels.has(level)) {
      const previous = levels.get(level)
      levels.delete(level)
      built = await buildSegment([...previous.rows, ...built.rows])
      rewrittenVectors += built.rows.length
      fetchedVectors += built.rows.length
      splits += built.splits
      level++
    }
    if (segmentMerge) levels.set(level, built)
    else segments.push(built)
    updates.push({ count: batch.length, changedLeaves: built.leafMembers.size,
      // One encrypted staging write and one final sealed-layout write per row.
      // Each deterministic merge rewrites both input runs once. These are
      // Modeled I/O counts from the older layout experiment, not actual
      // ciphertext traffic or placements in the live update algorithm.
      rewrittenVectors, fetchedVectors, splits, milliseconds: performance.now() - begun })
  }
  if (segmentMerge) segments.push(...levels.values())
  for (const segment of segments) for (const [id, members] of segment.leafMembers) byLeaf.set(id, members)
  index = { format: 'segmented-private-centroid-tree-experiment', dimension: 512,
    segmentSize, segmentMerge, root: { count: images.length, children: segments.map(x => x.index.root) } }
} else for (let start = 0; start < insertImages.length; start += 64) {
  const begun = performance.now()
  const plan = await insertRecords(index, insertImages.slice(start, start + 64).map(image => ({ id: String(image.id), vector: image.vector })), id => byLeaf.get(id))
  plan.removed.forEach(id => byLeaf.delete(id))
  for (const [id, members] of plan.changed) byLeaf.set(id, members)
  updates.push({ count: Math.min(64, insertImages.length - start), changedLeaves: plan.changed.size,
    rewrittenVectors: [...plan.changed.values()].reduce((n, group) => n + group.length, 0),
    fetchedVectors: plan.fetchedVectors, splits: plan.splits, milliseconds: performance.now() - begun })
}
const rank = (records, scored) => records.map(r => ({ id: r.id, score: scored.get(r.id) }))
  .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
const leafOfImage = new Map([...byLeaf].flatMap(([leafId, members]) => members.map(member => [member.id, leafId])))
const leafRawBytes = new Map([...byLeaf].map(([id, members]) => [id,
  members.reduce((n, record) => n + (rawImageBytes.get(record.id) || 0), 0)]))
const mean = rows => rows.reduce((n, x) => n + x, 0) / rows.length
const summary = rows => {
  const keys = ['annRecall10', 'expectedAnnRecall10', 'imageRecall1', 'imageRecall5', 'imageRecall10', 'candidateFraction', 'coverRawImageBytes',
    'certified', 'falseCertificate', 'regretBound', 'regretViolation', 'preferredIncluded', 'overPrivateCap']
  return Object.fromEntries(keys.map(key => {
    // COCO's five captions for one image are correlated. Treat the image,
    // rather than each caption or each private trial, as the uncertainty unit.
    const grouped = new Map()
    for (const row of rows) if (Number.isFinite(row[key])) {
      if (!grouped.has(row.imageId)) grouped.set(row.imageId, [])
      grouped.get(row.imageId).push(row[key])
    }
    const values = [...grouped.values()].map(mean)
    if (!values.length) return [key, null]
    const m = mean(values), se = values.length > 1 ? Math.sqrt(mean(values.map(x => (x - m) ** 2)) / (values.length - 1)) : null
    return [key, { mean: m, ci95Normal: se === null ? null : [m - 1.96 * se, m + 1.96 * se], n: values.length }]
  }))
}
const configs = [{ name: 'exhaustive', get: () => leaves(index).map(x => x.id) },
  ...fixedProbes.map(n => ({ name: `fixed-${n}`, get: q => route(index, q, n).leafIds })),
  ...globalProbes.map(n => ({ name: `global-centroid-${n}`, global: true, probes: n })),
  ...balancedProbes.map(n => ({ name: `balanced-segment-${n}`, balanced: true, probes: n })),
  ...privateEpsilons.map(epsilon => ({ name: `private-eps${epsilon}-budget${budget}`,
    private: true, epsilon })),
  ...decoyRequired.map(required => ({ name: `decoy-top${required}-budget${budget}`, private: true, decoy: true, required }))]
const perQuery = Object.fromEntries(configs.map(c => [c.name, []]))
const examples = []
for (const [qi, query] of queries.entries()) {
  if (scoreFile) {
    const { bytesRead } = await scoreFile.read(scoreBuffer, 0, scoreBuffer.length, query.sourceIndex * scoreBuffer.length)
    if (bytesRead !== scoreBuffer.length) throw new Error('Short read from COCO score matrix')
  }
  const scored = new Map(images.map((image, i) => [String(image.id), scoreFile
    ? scoreBuffer.readDoubleLE(i * 8) : dot(query.vector, image.vector)]))
  const truth = rank(images.map(im => ({ id: String(im.id) })), scored).slice(0, 10)
  const trueIds = new Set(truth.map(x => x.id))
  const privateQuery = privateEpsilons.length ? preparePrivateQuery(index, query.vector) : null
  const pendingIds = bufferedSegmentSize ? index.pendingBatchIds : []
  const pendingSet = new Set(pendingIds)
  const globalOrder = globalProbes.length ? leaves(index).filter(node => !pendingSet.has(node.id))
    .map(node => ({ id: node.id, score: dot(query.vector, node.center) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(x => x.id) : null
  const balancedOrder = balancedProbes.length ? index.segmentSize ? index.root.children.map(root =>
    leaves({ root }).map(node => ({ id: node.id, score: dot(query.vector, node.center) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(x => x.id)) : null : null
  const balancedSelect = n => {
    if (!balancedOrder) throw new Error('Balanced routing requires segmented index')
    const groups = index.root.children
    const fractions = groups.map((group, i) => ({ i, target: n * group.count / index.root.count }))
    const quotas = fractions.map(x => Math.min(balancedOrder[x.i].length, Math.floor(x.target)))
    let remaining = Math.min(n, balancedOrder.reduce((sum, group) => sum + group.length, 0)) - quotas.reduce((a, b) => a + b, 0)
    for (const item of fractions.sort((a, b) => (b.target % 1) - (a.target % 1) || a.i - b.i)) {
      if (!remaining) break
      if (quotas[item.i] < balancedOrder[item.i].length) { quotas[item.i]++; remaining-- }
    }
    while (remaining) for (const item of fractions) {
      if (!remaining) break
      if (quotas[item.i] < balancedOrder[item.i].length) { quotas[item.i]++; remaining-- }
    }
    return balancedOrder.flatMap((group, i) => group.slice(0, quotas[i]))
  }
  const decoyQueries = new Map(decoyRequired.map(required => [required,
    prepareDecoyQuery(index, query.vector, { budget, required })]))
  // The global top-10 of a union is contained in the top-10 of each member
  // leaf. Cache those lists once per caption; private trials can reuse them.
  const leafTop10 = new Map([...byLeaf].map(([id, members]) => [id, rank(members, scored).slice(0, 10)]))
  for (const config of configs) {
    const trials = config.private ? privateTrials : 1, observations = []
    for (let trial = 0; trial < trials; trial++) {
      const selected = config.private ? config.decoy
        ? decoyQueries.get(config.required).sample()
        : privateQuery.sample({ budget, epsilon: config.epsilon }) : config.global
        ? [...pendingIds, ...globalOrder.slice(0, config.probes)] : config.balanced
        ? balancedSelect(config.probes) : config.get(query.vector)
      const ids = config.private ? selected.leafIds : selected
      const candidateCount = ids.reduce((n, id) => n + byLeaf.get(id).length, 0)
      const found = ids.flatMap(id => leafTop10.get(id)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 10)
      const audit = config.private ? privateQuery.audit(ids, found, 10, 0) : null
      const annRecall10 = found.filter(x => trueIds.has(x.id)).length / truth.length
      // Every exhaustive top-10 item in a selected leaf is also in the
      // candidate top-10. Thus this is the exact expectation over the subset
      // mechanism, without Monte Carlo noise or any independence assumption.
      const expectedAnnRecall10 = config.private && !config.decoy ? (() => {
        const m = selected.totalLeaves, b = selected.budget
        const p = selected.actualInclusionProbability
        const other = m === 1 ? 0 : (b - p) / (m - 1)
        const preferredMass = truth.filter(x => leafOfImage.get(x.id) === selected.preferredId).length / truth.length
        return preferredMass * p + (1 - preferredMass) * other
      })() : null
      const observedKth = found[Math.min(9, truth.length - 1)]?.score
      const actualRegret = observedKth === undefined ? null : Math.max(0, truth[truth.length - 1].score - observedKth)
      observations.push({ annRecall10,
        expectedAnnRecall10,
        imageRecall1: Number(found.slice(0, 1).some(x => x.id === String(query.imageId))),
        imageRecall5: Number(found.slice(0, 5).some(x => x.id === String(query.imageId))),
        imageRecall10: Number(found.some(x => x.id === String(query.imageId))),
        candidateFraction: candidateCount / images.length,
        overPrivateCap: config.private ? Number(candidateCount > 2048) : null,
        coverRawImageBytes: imageDir ? ids.reduce((n, id) => n + leafRawBytes.get(id), 0) : null,
        certified: audit ? Number(audit.complete) : null,
        regretBound: audit?.scoreRegretBound ?? null,
        falseCertificate: audit ? Number(audit.complete && annRecall10 < 1) : null,
        regretViolation: audit?.scoreRegretBound != null && actualRegret != null
          ? Number(actualRegret > audit.scoreRegretBound + 1e-7) : null,
        preferredIncluded: config.private ? Number(ids.includes(config.decoy ? selected.requiredIds[0] : selected.preferredId)) : null })
    }
    perQuery[config.name].push({ imageId: query.imageId,
      ...Object.fromEntries(Object.keys(observations[0]).map(k => [k,
        mean(observations.map(x => x[k]).filter(Number.isFinite))])) })
  }
  if (qi < 10) examples.push({ captionId: query.id, imageId: query.imageId,
    exhaustiveTop10: truth.map(x => Number(x.id)) })
  if ((qi + 1) % 100 === 0) console.log(`Evaluated ${qi + 1}/${queries.length} captions`)
}
await scoreFile?.close()

// Optional *actual* CKKS check. The plaintext tables above are index quality
// simulations, not encrypted latency claims. Same vectors, queries and code.
let encrypted = null
if (heQueries || heFullQueries) {
  const { default: SEAL } = await import('node-seal')
  const seal = await SEAL(), client = new CKKS(seal), server = new CKKS(seal), keys = client.generateKeys()
  client.setClientKeys(keys); server.setEvaluationKeys(keys)
  const encodedLeaves = new Map()
  for (const [id, members] of byLeaf) {
    const batches = []
    for (let i = 0; i < members.length; i += PACK) {
      const part = members.slice(i, i + PACK)
      batches.push({ imageIds: part.map(x => x.id), encryptedVector: client.encrypt(packVectors(part.map(x => x.vector))) })
    }
    encodedLeaves.set(id, batches)
  }
  const measurements = [], byId = new Map(images.map(im => [String(im.id), im.vector]))
  for (const [qi, query] of queries.slice(0, Math.max(heQueries, heFullQueries)).entries()) {
    const encryptionStart = performance.now(), queryCipher = client.encrypt(packQuery(query.vector))
    const queryEncryptMs = performance.now() - encryptionStart
    const privateQuery = preparePrivateQuery(index, query.vector)
    const variants = qi < heQueries && !heOnlyGlobal ? [
      { name: 'fixed', ids: route(index, query.vector, budget).leafIds },
      { name: 'private-eps2', ids: privateQuery.sample({ budget, epsilon: 2 }).leafIds },
    ] : []
    if (qi < heQueries && heGlobalProbes) variants.push({ name: `global-centroid-${heGlobalProbes}`,
      ids: leaves(index).map(node => ({ id: node.id, score: dot(query.vector, node.center) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, heGlobalProbes).map(x => x.id) })
    if (qi < heFullQueries) variants.push({ name: 'exhaustive', ids: [...encodedLeaves.keys()] })
    for (const variant of variants) {
      const batches = variant.ids.flatMap(id => encodedLeaves.get(id))
      const begun = performance.now(), ciphertexts = server.score(queryCipher, batches, 'server')
      const serverMs = performance.now() - begun
      const decryptStart = performance.now(), scores = client.readScores(ciphertexts)
      const clientDecryptMs = performance.now() - decryptStart
      const plaintextTop10 = variant.ids.flatMap(id => byLeaf.get(id))
        .map(record => ({ id: record.id, score: dot(query.vector, record.vector) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 10)
      const correct = new Set(plaintextTop10.map(x => x.id))
      measurements.push({ captionId: query.id, variant: variant.name, selectedLeaves: variant.ids.length,
        candidates: scores.length, queryEncryptMs, serverMs, clientDecryptMs,
        heVsPlainCandidateRecall10: scores.slice(0, 10).filter(x => correct.has(x.id)).length / plaintextTop10.length,
        officialImageRecall1: Number(scores[0]?.id === String(query.imageId)),
        maxScoreError: Math.max(...scores.map(x => Math.abs(x.score - dot(query.vector, byId.get(x.id))))),
        returnedCiphertexts: ciphertexts.length, responseBytes: Buffer.byteLength(JSON.stringify(ciphertexts)) })
    }
    console.log(`Encrypted query ${qi + 1}/${Math.max(heQueries, heFullQueries)} complete`)
  }
  encrypted = { scope: 'actual CKKS score evaluation on fixed, private, and optional exhaustive leaves; excludes HTTP, image bytes, model embedding and setup',
    evaluatedQueries: Math.max(heQueries, heFullQueries), measurements }
  client.delete(); server.delete()
}
const report = { generatedAt: new Date().toISOString(), dataset: manifest,
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model },
  protocol: bufferedSegmentSize ? 'experimental opaque append buffer with count-scheduled seal and merge; plaintext layout and vector placements measured, not ciphertext bytes' :
    liveSegmentSize ? 'live count-scheduled segment update algorithm; plaintext layout and vector placements measured, not ciphertext bytes' :
    segmentSize ? 'experimental immutable sealed segments with optional deterministic equal-size merges; I/O modeled' :
    'incremental spherical index; fixed-size subset randomized response; no post-query expansion',
  evaluation: { corpusImages: images.length, evaluatedCaptions: queries.length, imageLimit, privateTrials, budget, segmentSize, liveSegmentSize, bufferedSegmentSize, segmentMerge, insertSeed,
    heGlobalProbes,
    heOnlyGlobal,
    fixedProbes, globalProbes, balancedProbes, privateEpsilons,
    decoyRequired,
    imageBytes: imageDir ? 'sum of original JPEG files in selected leaves; lower bound on encrypted cover transfer' : 'not measured',
    relevance: 'official COCO caption image_id; all other matching-looking images count as non-relevant',
    annTruth: 'exact top-10 cosine on the same quantized CLIP embeddings',
    scoreComputation: scoreMetadata ? `NumPy ${scoreMetadata.numpyVersion} float64 matrix multiplication` : 'JavaScript float64 dot product',
    confidence: 'normal 95% interval across image-level means; captions and private trials averaged within each image',
    limitation: 'COCO val2017, not COCO 2014 Karpathy test; caption relevance has false negatives. Plaintext routing metrics are not HE timings.' },
  index: indexStats(index), updates, summaries: Object.fromEntries(configs.map(c => [c.name, summary(perQuery[c.name])])),
  examples, perQuery: process.env.BENCH_SAVE_PER_QUERY === '1' ? perQuery : undefined, encrypted }
const output = resolve(process.env.BENCH_OUTPUT || join(dir, 'results.json'))
await writeFile(output, JSON.stringify(report, null, 2))
console.table(Object.entries(report.summaries).map(([name, row]) => ({ name,
  annR10: row.annRecall10?.mean.toFixed(3), imageR1: row.imageRecall1?.mean.toFixed(3),
  candidates: row.candidateFraction?.mean.toFixed(3), certificate: row.certified?.mean.toFixed(3) })))
console.log(`Saved ${output}`)
