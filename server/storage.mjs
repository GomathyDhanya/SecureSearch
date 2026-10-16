import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
export const accountId = email => createHash('sha256').update(email).digest('hex')
const conflict = () => Object.assign(new Error('Index changed on another device. Reload and retry.'), { statusCode: 409 })

// Single-process development backend; encrypted data persists across restarts.
export class LocalStore {
  constructor(root) { this.root = root; this.locks = new Map() }
  path(key) {
    if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes('..')) throw new Error('Invalid storage key')
    return join(this.root, `${key}.json`)
  }
  async getBlob(key) {
    try { return JSON.parse(await readFile(this.path(key), 'utf8')) }
    catch (e) { if (e.code === 'ENOENT') return null; throw e }
  }
  async putBlob(key, value) {
    const path = this.path(key), temp = `${path}.${randomUUID()}.tmp`
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
    await rename(temp, path)
  }
  async createAccount(account) {
    const path = this.path(`accounts/${account.id}`)
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
    try { await writeFile(path, JSON.stringify(account), { flag: 'wx', mode: 0o600 }) }
    catch (e) { if (e.code === 'EEXIST') throw Object.assign(new Error('Account exists'), { statusCode: 409 }); throw e }
  }
  getAccount(id) { return this.getBlob(`accounts/${id}`) }
  getHead(id) { return this.getBlob(`${id}/head`) }
  async commit(id, expectedVersion, next) {
    const before = this.locks.get(id) || Promise.resolve()
    const action = before.catch(() => {}).then(async () => {
      const current = await this.getHead(id)
      if ((current?.version ?? 0) !== expectedVersion) throw conflict()
      await this.putBlob(`${id}/head`, next)
    })
    this.locks.set(id, action)
    try { await action } finally { if (this.locks.get(id) === action) this.locks.delete(id) }
  }
}

// Immutable encrypted objects in R2; atomic snapshot publication in MongoDB.
// Failed/conflicting commits can leave unreferenced blobs, never a partial head.
export async function cloudStore() {
  const [{ default: mongoose }, { S3Client, GetObjectCommand, PutObjectCommand }] = await Promise.all([import('mongoose'), import('@aws-sdk/client-s3')])
  await mongoose.connect(process.env.MONGO_URI)
  const Account = mongoose.model('VaultV2Account', new mongoose.Schema({ _id: String, email: String, passwordHash: String, keyRef: String }))
  const Head = mongoose.model('VaultV2Head', new mongoose.Schema({ _id: String, version: Number, value: mongoose.Schema.Types.Mixed }))
  const r2 = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY } })
  return {
    async getBlob(key) {
      try { const response = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: `v2/${key}.json` })); return JSON.parse(await response.Body.transformToString()) }
      catch (e) { if (e.name === 'NoSuchKey') return null; throw e }
    },
    async putBlob(key, value) { await r2.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: `v2/${key}.json`, Body: JSON.stringify(value), ContentType: 'application/json' })) },
    async createAccount(account) {
      try { await Account.create({ _id: account.id, email: account.email, passwordHash: account.passwordHash, keyRef: account.keyRef }) }
      catch (e) { if (e.code === 11000) throw Object.assign(new Error('Account exists'), { statusCode: 409 }); throw e }
    },
    async getAccount(id) { const a = await Account.findById(id).lean(); return a && { ...a, id: a._id } },
    async getHead(id) { return (await Head.findById(id).lean())?.value ?? null },
    async commit(id, expectedVersion, next) {
      if (!expectedVersion) {
        try { await Head.create({ _id: id, version: next.version, value: next }); return }
        catch (e) { if (e.code === 11000) throw conflict(); throw e }
      }
      const result = await Head.updateOne({ _id: id, version: expectedVersion }, { $set: { version: next.version, value: next } })
      if (result.modifiedCount !== 1) throw conflict()
    },
    close: () => mongoose.disconnect(),
  }
}
