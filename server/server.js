import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import createCKKSEngine from './ckks_node.js'
import dotenv from 'dotenv'

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner' 

dotenv.config()

const PORT = 3000
const MAX_BODY_SIZE = 50 * 1024 * 1024 // 50MB Limit

const fastify = Fastify({ logger: true, bodyLimit: MAX_BODY_SIZE })
await fastify.register(cors, { origin: '*' })
await fastify.register(jwt, { secret: process.env.JWT_SECRET || 'dev-secret' })


const R2 = new S3Client({
  region: 'auto',
  // This constructs: https://16dbe536a3b767e836f7185f343a545d.r2.cloudflarestorage.com
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
  console.log("MongoDB Connected")
} catch (err) { console.error(err) }

// --- SCHEMAS ---
const UserSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  passwordHash: String,
  salt: String,
  encryptedMasterKey: String, 
  encryptedKeys: String      
})
const User = mongoose.model('User', UserSchema)

const ImageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  encryptedVector: String,     // CKKS Vector (Stored in Mongo)
  storageKey: String           // R2 File Path (Reference only)
})
const Image = mongoose.model('SecureImage', ImageSchema)


// --- WASM ENGINE ---
let engine
async function initEngine() {
  const module = await createCKKSEngine()
  engine = new module.CKKSEngine(8192)
  console.log("Crypto Engine Ready")
}
await initEngine()


fastify.decorate("authenticate", async function(request, reply) {
  try { await request.jwtVerify() } catch (err) { reply.send(err) }
})


fastify.post('/register', async (req, reply) => {
  const { email, password, salt, encryptedMasterKey, encryptedKeys } = req.body
  const passwordHash = await bcrypt.hash(password, 10)
  try {
    const user = new User({ email, passwordHash, salt, encryptedMasterKey, encryptedKeys })
    await user.save()
    return { status: 'ok' }
  } catch (err) { return reply.code(400).send({ error: 'User exists' }) }
})

fastify.post('/login', async (req, reply) => {
  const { email, password } = req.body
  const user = await User.findOne({ email })
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return reply.code(401).send({ error: 'Invalid credentials' })
  }
  const token = fastify.jwt.sign({ id: user._id, email: user.email })
  return { 
    token, salt: user.salt, 
    encryptedMasterKey: user.encryptedMasterKey, 
    encryptedKeys: user.encryptedKeys 
  }
})


fastify.post('/upload', { onRequest: [fastify.authenticate] }, async (req, reply) => {
  const { encryptedImage, encryptedVector } = req.body
  
  // A. Generate Unique Filename
  const fileKey = `${req.user.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.enc`

  // B. Upload Encrypted Blob to R2
  await R2.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
    Body: encryptedImage, // Storing the AES String directly
    ContentType: 'text/plain'
  }))

  // C. Save Metadata to Mongo
  const newRecord = new Image({ 
    userId: req.user.id, 
    encryptedVector: encryptedVector,
    storageKey: fileKey // Store the path, not the image
  })
  
  await newRecord.save()
  console.log(`💾 Uploaded to R2: ${fileKey}`)
  return { status: 'ok', id: newRecord._id }
})


fastify.post('/search', { onRequest: [fastify.authenticate] }, async (req, reply) => {
  const { queryVector, relinKeys } = req.body
  // ... (Homomorphic Search Logic stays exactly the same) ...
  // ... Paste your previous search logic here ...
  
  const userRecords = await Image.find({ userId: req.user.id })
  const results = []
  for (const record of userRecords) {
      // (Simplified for brevity - keep your existing dot product logic)
      const dotProduct = engine.computeDotProduct(queryVector, record.encryptedVector, relinKeys)
      results.push({ id: record._id, score: dotProduct })
  }
  return { results }
})


fastify.post('/get-image', { onRequest: [fastify.authenticate] }, async (req, reply) => {
  const { id } = req.body
  
  // A. Find Record
  const record = await Image.findOne({ _id: id, userId: req.user.id })
  if (!record) return reply.code(404).send({ error: "Not found" })
  
  // B. Fetch from R2
  try {
    const data = await R2.send(new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: record.storageKey
    }))
    
    // Convert Stream to String
    const encryptedBlob = await data.Body.transformToString();
    
    return { encryptedImage: encryptedBlob }
  } catch (e) {
    console.error("R2 Error:", e)
    return reply.code(500).send({ error: "Storage Error" })
  }
})

try { await fastify.listen({ port: PORT, host: '0.0.0.0' }) } 
catch (err) { process.exit(1) }
