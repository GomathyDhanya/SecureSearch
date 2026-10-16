import 'dotenv/config'
import SEAL from 'node-seal'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CKKS } from '../shared/ckks.mjs'
import { LocalStore, cloudStore } from './storage.mjs'
import { createApp } from './app.mjs'
const local = process.env.STORAGE_MODE === 'local'
if (!local && (!process.env.MONGO_URI || !process.env.JWT_SECRET)) throw new Error('Set cloud credentials and JWT_SECRET, or run npm run demo for local storage.')
const store = local ? new LocalStore(process.env.DATA_DIR || fileURLToPath(new URL('./.local-data-v2', import.meta.url))) : await cloudStore()
const engine = new CKKS(await SEAL())
const app = await createApp({ store, engine, secret: process.env.JWT_SECRET || randomBytes(32).toString('hex'), logger: true })
await app.listen({ port: Number(process.env.PORT || 3000), host: process.env.HOST || '127.0.0.1' })
console.log(`SecureLens v2 — ${local ? 'local development storage (single process)' : 'MongoDB / R2'}; coarse accesses and image IDs are visible`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); engine.delete(); await store.close?.(); process.exit(0) })
