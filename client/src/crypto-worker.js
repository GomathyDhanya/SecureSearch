import SEAL from 'node-seal'
import { CKKS } from '../../shared/ckks.mjs'
let engine
const ready = SEAL({ locateFile: () => '/seal_throws.wasm' }).then(seal => { engine = new CKKS(seal) })
self.onmessage = async event => {
  const { id, method, args } = event.data
  try {
    await ready
    const result = method === 'ready' ? true : engine[method](...args)
    self.postMessage({ id, result })
  } catch (error) { self.postMessage({ id, error: String(error.message || error) }) }
}
