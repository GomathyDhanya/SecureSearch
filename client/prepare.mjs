import { copyFile } from 'node:fs/promises'
await copyFile(new URL('./node_modules/node-seal/dist/seal_throws.wasm', import.meta.url), new URL('./public/seal_throws.wasm', import.meta.url))
