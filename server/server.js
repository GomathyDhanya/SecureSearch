import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import createCKKSEngine from './ckks_node.js'
import dotenv from 'dotenv'

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

dotenv.config()

const PORT = 3000
const MAX_BODY_SIZE = 50 * 1024 * 1024
const PACK_SIZE = 8
const EMBEDDING_DIM = 512

const fastify = Fastify({ logger: true, bodyLimit: MAX_BODY_SIZE })
await fastify.register(cors, { origin: '*' })
await fastify.register(jwt, { secret: process.env.JWT_SECRET || 'dev-secret' })

const R2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
})

const BUCKET_NAME = process.env.R2_BUCKET_NAME
const MONGO_URI = process.env.MONGO_URI

try {
  await mongoose.connect(MONGO_URI)
  console.log('MongoDB Connected')
} catch (err) {
  console.error(err)
}

// ---------------- SCHEMAS ----------------

const UserSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  passwordHash: String,
  salt: String,
  encryptedMasterKey: String,
  encryptedKeys: String,
})
const User = mongoose.model('User', UserSchema)

// Images no longer need their own encrypted vector.
// The vectors live in VectorBatch documents, up to 8 embeddings/ciphertext.
const ImageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  storageKey: String,
})
const Image = mongoose.model('SecureImage', ImageSchema)

const VectorBatchSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  encryptedVector: { type: String, required: true },
  imageIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SecureImage' }],
  count: { type: Number, min: 1, max: PACK_SIZE, required: true },
}, { timestamps: true })

const VectorBatch = mongoose.model('SecureVectorBatch', VectorBatchSchema)

// ---------------- WASM ENGINE ----------------

let engine

async function initEngine() {
  const module = await createCKKSEngine()
  engine = new module.CKKSEngine(8192)
  console.log(`Crypto Engine Ready: ${PACK_SIZE} x ${EMBEDDING_DIM}-D vectors/ciphertext`)
}

await initEngine()

fastify.decorate('authenticate', async function(request, reply) {
  try {
    await request.jwtVerify()
  } catch (err) {
    return reply.code(401).send({ error: 'Unauthorized' })
  }
})

// ---------------- AUTH ----------------

fastify.post('/register', async (req, reply) => {
  const { email, password, salt, encryptedMasterKey, encryptedKeys } = req.body
  const passwordHash = await bcrypt.hash(password, 10)

  try {
    const user = new User({
      email,
      passwordHash,
      salt,
      encryptedMasterKey,
      encryptedKeys,
    })
    await user.save()
    return { status: 'ok' }
  } catch (err) {
    return reply.code(400).send({ error: 'User exists' })
  }
})

fastify.post('/login', async (req, reply) => {
  const { email, password } = req.body
  const user = await User.findOne({ email })

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return reply.code(401).send({ error: 'Invalid credentials' })
  }

  const token = fastify.jwt.sign({ id: user._id, email: user.email })

  return {
    token,
    salt: user.salt,
    encryptedMasterKey: user.encryptedMasterKey,
    encryptedKeys: user.encryptedKeys,
  }
})

// ---------------- PACKED UPLOAD ----------------
//
// Client responsibilities:
//   1. Compute up to 8 normalized 512-D embeddings locally.
//   2. Flatten [v0 | v1 | ... | v7] into <= 4096 CKKS slots.
//   3. Zero-pad unused slots.
//   4. Encrypt the packed vector once.
//   5. AES-encrypt each image locally.
//
// Server sees only encrypted images + one encrypted packed vector.

fastify.post('/upload-batch', { onRequest: [fastify.authenticate] }, async (req, reply) => {
  const { encryptedImages, encryptedVector, count } = req.body

  if (!Array.isArray(encryptedImages)) {
    return reply.code(400).send({ error: 'encryptedImages must be an array' })
  }

  if (!Number.isInteger(count) || count < 1 || count > PACK_SIZE) {
    return reply.code(400).send({ error: `count must be between 1 and ${PACK_SIZE}` })
  }

  if (encryptedImages.length !== count) {
    return reply.code(400).send({ error: 'encryptedImages.length must equal count' })
  }

  if (!encryptedVector) {
    return reply.code(400).send({ error: 'encryptedVector is required' })
  }

  const imageIds = []
  const uploadedKeys = []

  try {
    for (let i = 0; i < encryptedImages.length; i++) {
      const fileKey = `${req.user.id}/${Date.now()}-${i}-${Math.random().toString(36).slice(2)}.enc`

      await R2.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileKey,
        Body: encryptedImages[i],
        ContentType: 'text/plain',
      }))

      uploadedKeys.push(fileKey)

      const image = await Image.create({
        userId: req.user.id,
        storageKey: fileKey,
      })

      imageIds.push(image._id)
    }

    const batch = await VectorBatch.create({
      userId: req.user.id,
      encryptedVector,
      imageIds,
      count,
    })

    console.log(`Packed upload: ${count} images -> 1 CKKS ciphertext`)

    return {
      status: 'ok',
      batchId: batch._id,
      imageIds,
      count,
    }
  } catch (err) {
    request.log.error(err)
    // R2 cleanup is intentionally not attempted here because the current project
    // does not include DeleteObject wiring. Failed DB writes may leave orphan blobs.
    return reply.code(500).send({ error: 'Packed upload failed' })
  }
})

// ---------------- PACKED SEARCH ----------------
//
// Query ciphertext contains the same 512-D normalized query repeated 8 times:
// [q | q | q | q | q | q | q | q]
//
// Each stored ciphertext contains up to 8 database embeddings:
// [v0 | v1 | ... | v7]
//
// One HE multiplication therefore produces 8 elementwise products in parallel.
// Client decrypts once and sums each 512-slot block to obtain 8 dot products.

fastify.post('/search-packed', { onRequest: [fastify.authenticate] }, async (req, reply) => {
  const { queryVector, relinKeys } = req.body

  if (!queryVector || !relinKeys) {
    return reply.code(400).send({ error: 'queryVector and relinKeys are required' })
  }

  const batches = await VectorBatch
    .find({ userId: req.user.id })
    .select('_id encryptedVector imageIds count')
    .lean()

  const results = []

  // Still O(number of batches), but each expensive HE multiply evaluates
  // up to 8 candidates instead of exactly one.
  for (const batch of batches) {
    const encryptedProducts = engine.computeDotProduct(
      queryVector,
      batch.encryptedVector,
      relinKeys,
    )

    results.push({
      batchId: batch._id,
      imageIds: batch.imageIds,
      count: batch.count,
      score: encryptedProducts,
    })
  }

  return {
    packSize: PACK_SIZE,
    embeddingDim: EMBEDDING_DIM,
    candidateCount: batches.reduce((s, b) => s + b.count, 0),
    batchCount: batches.length,
    results,
  }
})

// ---------------- IMAGE FETCH ----------------

fastify.post('/get-image', { onRequest: [fastify.authenticate] }, async (req, reply) => {
  const { id } = req.body

  const record = await Image.findOne({ _id: id, userId: req.user.id })
  if (!record) return reply.code(404).send({ error: 'Not found' })

  try {
    const data = await R2.send(new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: record.storageKey,
    }))

    const encryptedBlob = await data.Body.transformToString()
    return { encryptedImage: encryptedBlob }
  } catch (e) {
    request.log.error(e)
    return reply.code(500).send({ error: 'Storage Error' })
  }
})

// Optional endpoint useful while benchmarking.
fastify.get('/packed-stats', { onRequest: [fastify.authenticate] }, async (req) => {
  const [batchCount, candidateAgg] = await Promise.all([
    VectorBatch.countDocuments({ userId: req.user.id }),
    VectorBatch.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(req.user.id) } },
      { $group: { _id: null, candidates: { $sum: '$count' } } },
    ]),
  ])

  const candidates = candidateAgg[0]?.candidates ?? 0

  return {
    candidates,
    batches: batchCount,
    packSize: PACK_SIZE,
    ciphertextsPerCandidate: candidates ? batchCount / candidates : 0,
  }
})

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
