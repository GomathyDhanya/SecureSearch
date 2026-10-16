import { adaptiveSearch } from './adaptive.mjs'
import { selectPrivateLeaves, selectDecoyLeaves, auditPrivateResult } from './private-probe.mjs'
import { createIndex, insertRecords, routeGlobal, indexStats } from './index.mjs'
import { createSegmentedIndex, insertSegmented, SEGMENT_FORMAT } from './segments.mjs'
import { createBufferedIndex, insertBuffered, BUFFERED_FORMAT } from './buffered-segments.mjs'
import { encryptJSON, decryptJSON, importVaultKey, newVaultKey } from './crypto.mjs'
import { packVectors, packQuery, FORMAT, PACK } from './ckks.mjs'

// Runs only on a trusted client (browser or benchmark process).
export class VaultClient {
  constructor(engine, request, log = () => {}, { segmentSize = 500, bufferedSegmentSize = 0 } = {}) {
    this.engine = engine; this.request = request; this.log = log; this.version = 0
    this.segmentSize = segmentSize; this.bufferedSegmentSize = bufferedSegmentSize
  }
  async register(email, password) {
    email = email.trim().toLowerCase()
    const vaultKey = newVaultKey(), key = await importVaultKey(vaultKey)
    const keys = await this.engine.generateKeys()
    const encryptedKeys = await encryptJSON({ publicKey: keys.publicKey, secretKey: keys.secretKey, format: FORMAT }, key, `keys:${email}`)
    await this.request('/register', { email, password, format: FORMAT, encryptedKeys,
      evaluationKeys: { relinKeys: keys.relinKeys, galoisKeys: keys.galoisKeys } })
    await this.login(email, password, vaultKey)
    return vaultKey
  }
  async login(email, password, vaultKey) {
    email = email.trim().toLowerCase()
    const key = await importVaultKey(vaultKey)
    const result = await this.request('/login', { email, password })
    const keys = await decryptJSON(result.encryptedKeys, key, `keys:${email}`)
    if (keys.format !== FORMAT) throw new Error('This vault needs a different cryptography version')
    await this.engine.setClientKeys(keys)
    this.key = key; this.token = result.token; this.email = email; this.version = 0; this.index = null
    await this.refresh()
  }
  api(path, body) { return this.request(path, body, this.token) }
  async refresh() {
    const snapshot = await this.api(this.index ? `/index?since=${this.version}` : '/index')
    if (snapshot.version < this.version) throw new Error('Server returned an older index version')
    if (snapshot.unchanged) {
      if (!this.index || snapshot.version !== this.version) throw new Error('Invalid unchanged index response')
      return indexStats(this.index)
    }
    this.index = snapshot.encryptedIndex ? await decryptJSON(snapshot.encryptedIndex, this.key, `index:${snapshot.version}`) :
      this.bufferedSegmentSize ? createBufferedIndex({ segmentSize: this.bufferedSegmentSize }) :
        this.segmentSize ? createSegmentedIndex({ segmentSize: this.segmentSize }) : createIndex()
    this.version = snapshot.version
    return indexStats(this.index)
  }
  async insert(records, { embeddingSpace } = {}) {
    const started = performance.now()
    await this.refresh()
    if (this.index.root.count && embeddingSpace && this.index.embeddingSpace && embeddingSpace !== this.index.embeddingSpace) throw new Error('Use a separate vault for different embedding models or synthetic fixtures')
    if (this.index.format === SEGMENT_FORMAT || this.index.format === BUFFERED_FORMAT)
      return this.insertBatches(records, embeddingSpace, started)
    const next = structuredClone(this.index), version = this.version
    if (embeddingSpace) next.embeddingSpace = embeddingSpace
    const plan = await insertRecords(next, records.map(({ id, vector }) => ({ id, vector })), async leafId => {
      const value = await this.api(`/leaves/${leafId}`)
      if (value.version !== version) throw new Error('Index changed while preparing upload. Retry.')
      return decryptJSON(value.encryptedRecords, this.key, `leaf:${leafId}`)
    })
    const clusteringMs = performance.now() - started
    const replacements = []
    for (const [id, members] of plan.changed) {
      const batches = []
      for (let i = 0; i < members.length; i += PACK) {
        const group = members.slice(i, i + PACK)
        batches.push({ imageIds: group.map(r => r.id), encryptedVector: await this.engine.encrypt(packVectors(group.map(r => r.vector))) })
      }
      replacements.push({ id, batches, encryptedRecords: await encryptJSON(members, this.key, `leaf:${id}`) })
    }
    const images = []
    for (const record of records) images.push({ id: record.id, encryptedImage: await encryptJSON(record.image, this.key, `image:${record.id}`) })
    const encryptedIndex = await encryptJSON(next, this.key, `index:${version + 1}`)
    const body = { expectedVersion: version, encryptedIndex, replacements, removed: plan.removed, images }
    const uploadedBytes = new TextEncoder().encode(JSON.stringify(body)).length
    const result = await this.api('/commit', body)
    this.index = next; this.version = result.version
    return { ...indexStats(next), inserted: records.length, splits: plan.splits, touchedLeaves: replacements.length,
      fetchedVectors: plan.fetchedVectors, rewrittenVectors: [...plan.changed.values()].reduce((n, rows) => n + rows.length, 0), uploadedBytes,
      clusteringAndFetchMs: clusteringMs, totalMs: performance.now() - started }
  }
  async insertBatches(records, embeddingSpace, started) {
    if (!records.length) return { ...indexStats(this.index), inserted: 0, rewrittenVectors: 0, uploadedBytes: 0, totalMs: performance.now() - started }
    let offset = 0, touchedLeaves = 0, fetchedVectors = 0, splits = 0, mergeCount = 0
    let rewrittenVectors = 0, uploadedBytes = 0, clusteringAndFetchMs = 0
    while (offset < records.length) {
      const next = structuredClone(this.index), version = this.version
      if (embeddingSpace) next.embeddingSpace = embeddingSpace
      const buffered = next.format === BUFFERED_FORMAT
      const pendingCount = buffered ? next.pendingCount : next.root.children.find(node => node.id === next.pendingRootId)?.count
      if (pendingCount === undefined) throw new Error('Pending segment is missing')
      const chunk = records.slice(offset, offset + Math.min(512, next.segmentSize - pendingCount))
      const clusteringStart = performance.now()
      const plan = await (buffered ? insertBuffered : insertSegmented)(next,
        chunk.map(({ id, vector }) => ({ id, vector })), async leafId => {
        const value = await this.api(`/leaves/${leafId}`)
        if (value.version !== version) throw new Error('Index changed while preparing upload. Retry.')
        return decryptJSON(value.encryptedRecords, this.key, `leaf:${leafId}`)
      })
      clusteringAndFetchMs += performance.now() - clusteringStart
      const replacements = []
      for (const [id, members] of plan.changed) {
        const batches = []
        for (let i = 0; i < members.length; i += PACK) {
          const group = members.slice(i, i + PACK)
          batches.push({ imageIds: group.map(r => r.id), encryptedVector: await this.engine.encrypt(packVectors(group.map(r => r.vector))) })
        }
        replacements.push({ id, batches, encryptedRecords: await encryptJSON(members, this.key, `leaf:${id}`) })
        rewrittenVectors += members.length
      }
      const images = []
      for (const record of chunk) images.push({ id: record.id, encryptedImage: await encryptJSON(record.image, this.key, `image:${record.id}`) })
      const encryptedIndex = await encryptJSON(next, this.key, `index:${version + 1}`)
      const body = { expectedVersion: version, encryptedIndex, replacements, removed: plan.removed, images }
      uploadedBytes += new TextEncoder().encode(JSON.stringify(body)).length
      const result = await this.api('/commit', body)
      this.index = next; this.version = result.version
      touchedLeaves += replacements.length; fetchedVectors += plan.fetchedVectors
      splits += plan.splits; mergeCount += plan.mergeCount
      offset += chunk.length
      if (offset < records.length) await this.refresh()
    }
    return { ...indexStats(this.index), inserted: records.length, splits, mergeCount, touchedLeaves,
      fetchedVectors, rewrittenVectors, uploadedBytes, clusteringAndFetchMs, totalMs: performance.now() - started }
  }
  async search(query, { nprobe = 4, exhaustive = false, mode = 'server', k = 8, fetchImages = true, adaptive = false, maxProbes = Infinity, privateMode = false, coverPolicy = 'dp', epsilon = 2, privateBudget = 4, requiredLeaves = 1 } = {}) {
    const start = performance.now()
    await this.refresh()
    const routingStart = performance.now()
    if (privateMode && this.index.format === BUFFERED_FORMAT) throw new Error('Private cover is not defined for buffered index')
    if (adaptive && this.index.format === BUFFERED_FORMAT) throw new Error('Adaptive search is not defined for buffered index')
    if (privateMode && (exhaustive || adaptive || mode !== 'server')) throw new Error('Private mode uses one fixed server-reduced request')
    if (privateMode && !['dp', 'decoy'].includes(coverPolicy)) throw new Error('Unknown cover policy')
    const privateSelection = privateMode ? coverPolicy === 'decoy'
      ? selectDecoyLeaves(this.index, query, { budget: privateBudget, required: requiredLeaves })
      : selectPrivateLeaves(this.index, query, { budget: privateBudget, epsilon }) : null
    const routing = privateSelection ? { leafIds: privateSelection.leafIds, comparisons: privateSelection.totalLeaves } :
      (exhaustive || adaptive) ? { leafIds: null, comparisons: 0 } : routeGlobal(this.index, query, nprobe)
    let routingMs = performance.now() - routingStart
    const encryptionStart = performance.now()
    const queryVector = await this.engine.encrypt(packQuery(query))
    const queryEncryptMs = performance.now() - encryptionStart
    let response, scores, audit, clientDecryptRankMs = 0, responseBytes = 0, resultCiphertexts = 0, evaluationMs = 0
    const totals = { computeMs: 0, candidateCount: 0, batchCount: 0 }
    const evaluate = async leafIds => {
      const evaluationStart = performance.now()
      response = await this.api('/search-packed', { queryVector, leafIds, expectedVersion: this.version, mode,
        privateImages: privateMode })
      responseBytes += new TextEncoder().encode(JSON.stringify(response)).length
      resultCiphertexts += response.results.length
      for (const key of Object.keys(totals)) totals[key] += response[key] || 0
      const decryptStart = performance.now()
      const found = await this.engine.readScores(response.results, mode)
      clientDecryptRankMs += performance.now() - decryptStart
      evaluationMs += performance.now() - evaluationStart
      return found
    }
    if (adaptive && !exhaustive) {
      const adaptiveStarted = performance.now()
      const found = await adaptiveSearch(this.index, query, evaluate, { k, initialProbe: nprobe, maxProbes })
      scores = found.scores; audit = found.audit
      routingMs += Math.max(0, performance.now() - adaptiveStarted - evaluationMs)
    } else scores = await evaluate(routing.leafIds)
    if (privateMode) audit = auditPrivateResult(this.index, query, routing.leafIds, scores, k)
    const results = scores.slice(0, k)
    const searchMs = performance.now() - start
    if (fetchImages) {
      const privateImageById = privateMode ? new Map(response.images.map(item => [item.id, item.encryptedImage])) : null
      for (const result of results) {
        const encrypted = privateMode ? privateImageById.get(result.id) : await this.api(`/images/${result.id}`)
        if (!encrypted) throw new Error('Missing encrypted image in private cover')
        result.url = await decryptJSON(encrypted, this.key, `image:${result.id}`)
      }
    }
    return { results, scores, metrics: { totalCount: this.index.root.count, ...response, ...totals, audit, results: undefined, routingMs, routingComparisons: routing.comparisons,
      queryEncryptMs, clientDecryptRankMs, searchMs, withImageFetchMs: performance.now() - start,
      responseBytes, resultCiphertexts, privacy: privateMode ? coverPolicy === 'decoy'
        ? { policy: 'decoy', budget: privateSelection.budget, totalLeaves: privateSelection.totalLeaves,
          required: privateSelection.requiredIds.length, preferredIncludedProbability: 1,
          guarantee: 'best routing leaves are in the visible cover; no finite epsilon-DP guarantee' }
        : { policy: 'dp', epsilon, budget: privateSelection.budget,
          totalLeaves: privateSelection.totalLeaves, preferredIncludedProbability: privateSelection.actualInclusionProbability,
          guarantee: 'one-request computational query-local-DP for server transcript, conditioned on fixed vault and request time' } : null,
      images: undefined } }
  }
}
