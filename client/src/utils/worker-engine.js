export function createWorkerEngine() {
  const worker = new Worker(new URL('../crypto-worker.js', import.meta.url), { type: 'module' })
  let next = 0
  const pending = new Map()
  worker.onmessage = ({ data }) => {
    const task = pending.get(data.id)
    if (!task) return
    pending.delete(data.id)
    if (data.error) task.reject(new Error(data.error)); else task.resolve(data.result)
  }
  worker.onerror = event => { for (const task of pending.values()) task.reject(new Error(event.message)); pending.clear() }
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = next++; pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args })
  })
  return Object.fromEntries(['ready', 'generateKeys', 'setClientKeys', 'encrypt', 'readScores'].map(method => [method, (...args) => call(method, ...args)]).concat([
    ['terminate', () => { worker.terminate(); for (const task of pending.values()) task.reject(new Error('Worker terminated')); pending.clear() }],
  ]))
}
