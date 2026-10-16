import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { accountId } from './storage.mjs'
import { FORMAT } from '../shared/ckks.mjs'

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }) }
const identifier = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(x) && !['__proto__', 'constructor', 'prototype'].includes(x)
const envelope = x => x?.version === 1 && typeof x.iv === 'string' && typeof x.ciphertext === 'string'

export async function createApp({ store, engine, secret, logger = false }) {
  const app = Fastify({ logger, bodyLimit: 128 * 1024 * 1024 })
  await app.register(cors, { origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' })
  await app.register(jwt, { secret, sign: { expiresIn: '8h' } })
  const auth = async request => { try { await request.jwtVerify() } catch { fail('Unauthorized', 401) } }
  let evaluationOwner = null, evaluationCache = null
  const loadEvaluation = async (id, account) => {
    if (evaluationCache?.id === id) return evaluationCache
    return { id, keys: (await store.getBlob(account.keyRef)).evaluationKeys }
  }
  const headFor = async request => (await store.getHead(request.user.id)) ?? { version: 0, encryptedIndex: null, leaves: {}, count: 0 }
  app.get('/health', async () => ({ ok: true, protocol: FORMAT, privacy: 'encrypted contents; coarse access and result IDs visible' }))
  app.post('/register', async request => {
    const { email: rawEmail, password, encryptedKeys, evaluationKeys, format } = request.body || {}
    if (typeof rawEmail !== 'string' || !rawEmail.includes('@') || rawEmail.length > 254) fail('Valid email required')
    if (typeof password !== 'string' || password.length < 10 || Buffer.byteLength(password) > 72) fail('Account password must be 10–72 bytes')
    if (format !== FORMAT || !envelope(encryptedKeys) || typeof evaluationKeys?.relinKeys !== 'string' || typeof evaluationKeys?.galoisKeys !== 'string') fail('Valid v2 encrypted keys required')
    if ('secretKey' in evaluationKeys || 'vaultKey' in request.body) fail('Never send private keys to the server')
    const email = rawEmail.trim().toLowerCase(), id = accountId(email)
    if (await store.getAccount(id)) fail('Account exists', 409)
    const passwordHash = await bcrypt.hash(password, 12)
    const keyRef = `${id}/keys/${randomUUID()}`
    await store.putBlob(keyRef, { encryptedKeys, evaluationKeys })
    await store.createAccount({ id, email, passwordHash, keyRef })
    return { ok: true }
  })
  app.post('/login', async request => {
    const { email, password } = request.body || {}
    if (typeof email !== 'string' || typeof password !== 'string') fail('Credentials required')
    const account = await store.getAccount(accountId(email.trim().toLowerCase()))
    if (!account || !(await bcrypt.compare(password, account.passwordHash))) fail('Invalid credentials', 401)
    const { encryptedKeys } = await store.getBlob(account.keyRef)
    return { token: app.jwt.sign({ id: account.id }), encryptedKeys, format: FORMAT }
  })
  app.get('/index', { onRequest: auth }, async request => {
    const head = await headFor(request)
    if (request.query?.since !== undefined && Number(request.query.since) === head.version)
      return { version: head.version, unchanged: true, count: head.count, leafCount: Object.keys(head.leaves).length }
    return { version: head.version, encryptedIndex: head.encryptedIndex, count: head.count, leafCount: Object.keys(head.leaves).length }
  })
  app.get('/leaves/:id', { onRequest: auth }, async request => {
    const head = await headFor(request), ref = head.leaves[request.params.id]
    if (!Object.hasOwn(head.leaves, request.params.id)) fail('Leaf not found', 404)
    return { encryptedRecords: (await store.getBlob(ref.key)).encryptedRecords, version: head.version }
  })
  app.post('/commit', { onRequest: auth }, async request => {
    const { expectedVersion, encryptedIndex, replacements, removed = [], images = [] } = request.body || {}
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || !envelope(encryptedIndex)) fail('Valid snapshot required')
    if (!Array.isArray(replacements) || !Array.isArray(removed) || !Array.isArray(images) || replacements.length > 2048 || images.length > 512) fail('Invalid upload size')
    const head = await headFor(request)
    if (head.version !== expectedVersion) fail('Index changed on another device. Reload and retry.', 409)
    const imageIds = new Set()
    for (const image of images) {
      if (!identifier(image.id) || !envelope(image.encryptedImage) || imageIds.has(image.id)) fail('Invalid image')
      imageIds.add(image.id)
      if (await store.getBlob(`${request.user.id}/images/${image.id}`)) fail('Image ID already exists', 409)
    }
    const newIds = new Set()
    for (const entry of replacements) {
      if (!identifier(entry.id) || !envelope(entry.encryptedRecords) || !Array.isArray(entry.batches) || !entry.batches.length || newIds.has(entry.id)) fail('Invalid leaf')
      newIds.add(entry.id)
      for (const batch of entry.batches)
        if (typeof batch.encryptedVector !== 'string' || !batch.encryptedVector.length || !Array.isArray(batch.imageIds) || batch.imageIds.length < 1 || batch.imageIds.length > 8 || !batch.imageIds.every(identifier)) fail('Invalid packed vector')
    }
    if (!removed.every(identifier)) fail('Invalid removed leaf IDs')
    const refs = { ...head.leaves }, upload = randomUUID()
    for (const leafId of removed) delete refs[leafId]
    for (const image of images) await store.putBlob(`${request.user.id}/images/${image.id}`, image.encryptedImage)
    for (const entry of replacements) {
      const key = `${request.user.id}/leaves/${upload}-${entry.id}`
      await store.putBlob(key, entry)
      refs[entry.id] = { key, count: entry.batches.reduce((s, b) => s + b.imageIds.length, 0) }
    }
    const next = { version: expectedVersion + 1, encryptedIndex, leaves: refs, count: Object.values(refs).reduce((s, l) => s + l.count, 0) }
    await store.commit(request.user.id, expectedVersion, next)
    return { version: next.version, count: next.count, leafCount: Object.keys(refs).length }
  })
  app.post('/search-packed', { onRequest: auth }, async request => {
    const start = performance.now()
    const { queryVector, leafIds, expectedVersion, mode = 'server', privateImages = false } = request.body || {}
    if (typeof queryVector !== 'string' || !['server', 'legacy'].includes(mode)) fail('Invalid query')
    if (typeof privateImages !== 'boolean' || privateImages && leafIds === null) fail('Invalid private image request')
    if (leafIds !== null && (!Array.isArray(leafIds) || !leafIds.every(identifier))) fail('leafIds must be an array, or null for exhaustive search')
    const head = await headFor(request)
    if (head.version !== expectedVersion) fail('Index changed on another device. Reload and retry.', 409)
    const selected = leafIds === null ? Object.keys(head.leaves) : [...new Set(leafIds)]
    if (selected.some(id => !Object.hasOwn(head.leaves, id))) fail('Unknown leaf', 409)
    const batches = []
    for (const id of selected) batches.push(...(await store.getBlob(head.leaves[id].key)).batches)
    const account = await store.getAccount(request.user.id)
    const loaded = await loadEvaluation(request.user.id, account)
    // Key switching and evaluation must be in the SAME synchronous turn.
    if (evaluationOwner !== loaded.id) { engine.setEvaluationKeys(loaded.keys); evaluationOwner = loaded.id }
    evaluationCache = loaded
    const computeStart = performance.now()
    const results = engine.score(queryVector, batches, mode)
    const computeMs = performance.now() - computeStart
    // In query-private mode all images in the selected cover are returned.
    // Fetching only top-result IDs would expose the ranking and void the
    // selection protocol's transcript guarantee.
    let images
    if (privateImages) {
      const ids = [...new Set(batches.flatMap(batch => batch.imageIds))]
      if (ids.length > 2048) fail('Private cover exceeds 2,048 images; use a smaller budget', 413)
      images = await Promise.all(ids.map(async id => ({ id, encryptedImage: await store.getBlob(`${request.user.id}/images/${id}`) })))
    }
    return { results, images, mode, version: head.version, candidateCount: batches.reduce((n, b) => n + b.imageIds.length, 0), batchCount: batches.length,
      selectedLeaves: selected.length, totalLeaves: Object.keys(head.leaves).length, totalCount: head.count,
      computeMs, serverMs: performance.now() - start }
  })
  app.get('/images/:id', { onRequest: auth }, async request => {
    if (!identifier(request.params.id)) fail('Invalid ID')
    const image = await store.getBlob(`${request.user.id}/images/${request.params.id}`)
    if (!image) fail('Image not found', 404)
    return image
  })
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Request failed')
    reply.code(error.statusCode || 500).send({ error: error.statusCode ? error.message : 'Server operation failed' })
  })
  return app
}
