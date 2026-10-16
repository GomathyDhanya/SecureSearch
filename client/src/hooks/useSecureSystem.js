import { useEffect, useRef, useState } from 'react'
import { createWorkerEngine } from '../utils/worker-engine'
import { VaultClient } from '../../../shared/vault-client.mjs'
import { normalize } from '../../../shared/index.mjs'
import { makeDataset, demoImage } from '../../../shared/fixtures.mjs'

const API = import.meta.env.VITE_API_URL || '/api'
async function request(path, body, token) {
  const response = await fetch(`${API}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
  return result
}
const asDataURL = file => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file)
})
export function useSecureSystem() {
  const [status, setStatus] = useState('Starting encrypted engine…')
  const [isReady, setReady] = useState(false), [busy, setBusy] = useState(false)
  const [user, setUser] = useState(null), [recovery, setRecovery] = useState(null)
  const [stats, setStats] = useState(null), [metrics, setMetrics] = useState(null), [comparison, setComparison] = useState(null)
  const [logs, setLogs] = useState([])
  const session = useRef(null), lock = useRef(false), ai = useRef(null)
  const log = message => setLogs(previous => [...previous.slice(-49), message])
  useEffect(() => {
    let live = true
    const engine = createWorkerEngine()
    engine.ready().then(async () => {
      await request('/health')
      if (!live) return
      session.current = new VaultClient(engine, request)
      setReady(true); setStatus('Ready — keys stay on your device')
    }).catch(error => { if (live) setStatus(`Startup failed: ${error.message}`) })
    return () => { live = false; engine.terminate() }
  }, [])
  async function run(label, action) {
    if (lock.current) return
    lock.current = true; setBusy(true); setStatus(label)
    try { const result = await action(); setStatus('Ready'); return result }
    catch (error) { setStatus(error.message); log(`Error: ${error.message}`) }
    finally { lock.current = false; setBusy(false) }
  }
  const syncStats = async () => setStats(await session.current.refresh())
  const register = (email, password, { buffered = false } = {}) => run('Generating your encryption keys…', async () => {
    session.current.bufferedSegmentSize = buffered ? 500 : 0
    const vaultKey = await session.current.register(email, password)
    setRecovery({ email: session.current.email, vaultKey }); setUser({ email: session.current.email })
    await syncStats(); log(`${buffered ? 'Opaque-buffer' : 'Segmented'} vault created. Save the recovery key; it never goes to the server.`)
  })
  const login = (email, password, vaultKey) => run('Unlocking your vault…', async () => {
    await session.current.login(email, password, vaultKey)
    setUser({ email: session.current.email }); await syncStats(); log('Encrypted index unlocked on this device.')
  })
  const createDemo = () => run('Creating a local demo vault…', async () => {
    const email = `demo-${Date.now()}@local.test`, password = crypto.randomUUID()
    const vaultKey = await session.current.register(email, password)
    setRecovery({ email, password, vaultKey }); setUser({ email })
    const { records } = makeDataset({ n: 256 }), prefix = crypto.randomUUID()
    for (let start = 0; start < records.length; start += 64) {
      setStatus(`Encrypting demo vectors ${start + 1}–${Math.min(start + 64, records.length)}…`)
      const result = await session.current.insert(records.slice(start, start + 64).map(r => ({ ...r, id: `${prefix}-${r.id}`, image: demoImage(r) })), { embeddingSpace: 'synthetic-fixture-v1' })
      setStats(result); log(`Inserted 64 synthetic vectors; ${result.leaves} groups, ${result.splits} splits.`)
    }
    log('Synthetic demo ready. Generated vectors and cards, not CLIP image embeddings.')
  })
  async function loadAI(kind) {
    if (ai.current?.[kind]) return ai.current
    setStatus(`Downloading CLIP ${kind === 'vision' ? 'image' : 'text'} model for local embedding…`)
    const { AutoProcessor, CLIPVisionModelWithProjection, AutoTokenizer, CLIPTextModelWithProjection, RawImage, env } = await import('@huggingface/transformers')
    env.allowLocalModels = false; env.useBrowserCache = true
    const model = 'Xenova/clip-vit-base-patch32'
    const revision = 'd15189d7028b43f1d3e65039190477f6af591c2a'
    ai.current ||= { RawImage }
    if (kind === 'vision') {
      const [processor, vision] = await Promise.all([AutoProcessor.from_pretrained(model, { revision }), CLIPVisionModelWithProjection.from_pretrained(model, { dtype: 'q8', revision })])
      Object.assign(ai.current, { processor, vision })
    } else {
      const [tokenizer, text] = await Promise.all([AutoTokenizer.from_pretrained(model, { revision }), CLIPTextModelWithProjection.from_pretrained(model, { dtype: 'q8', revision })])
      Object.assign(ai.current, { tokenizer, text })
    }
    return ai.current
  }
  const uploadImages = filesLike => run('Embedding images on your device…', async () => {
    const model = await loadAI('vision'), files = Array.from(filesLike)
    for (let start = 0; start < files.length; start += 32) {
      const records = []
      for (const file of files.slice(start, start + 32)) {
        setStatus(`Embedding ${file.name}…`)
        const image = await asDataURL(file), input = await model.processor(await model.RawImage.read(image)), output = await model.vision(input)
        records.push({ id: crypto.randomUUID(), vector: normalize(Array.from(output.image_embeds.data)), image })
      }
      setStatus('Updating the encrypted hierarchy…')
      const result = await session.current.insert(records, { embeddingSpace: 'clip-vit-base-patch32-q8' })
      setStats(result); log(`Added ${records.length} images; ${result.leaves} groups; ${result.splits} splits; ${(result.totalMs / 1000).toFixed(2)} s.`)
    }
  })
  const search = ({ text, group, nprobe, compare, adaptive, privateMode, coverPolicy, epsilon, privateBudget, requiredLeaves }) => run('Searching encrypted vectors on the server…', async () => {
    const space = session.current.index.embeddingSpace
    if (space && (group !== undefined) !== (space === 'synthetic-fixture-v1')) throw new Error('Synthetic queries and CLIP queries need separate collections')
    let query
    if (group !== undefined) query = makeDataset({ n: 0 }).centers[group]
    else {
      const model = await loadAI('text'), output = await model.text(await model.tokenizer([text], { padding: true, truncation: true }))
      query = normalize(Array.from(output.text_embeds.data))
    }
    const ann = await session.current.search(query, { nprobe, k: 1,
      adaptive: adaptive && !privateMode, privateMode, coverPolicy, epsilon, privateBudget, requiredLeaves })
    setMetrics(ann.metrics); setComparison(null)
    if (compare && !privateMode) {
      setStatus('Running the exhaustive encrypted baseline…')
      const exact = await session.current.search(query, { exhaustive: true, k: 1, fetchImages: false }), truth = new Set(exact.results.map(r => r.id))
      setComparison({ ...exact.metrics, recall: truth.size ? ann.results.filter(r => truth.has(r.id)).length / truth.size : 1 })
    }
    log(`Server scored ${ann.metrics.candidateCount}/${ann.metrics.totalCount} vectors; returned ${ann.metrics.resultCiphertexts} score ciphertext(s).${privateMode ? ' Cover fetched all selected images.' : ''}`)
    await syncStats(); return ann.results
  })
  return { status, isReady, busy, user, recovery, stats, metrics, comparison, logs, register, login, createDemo, uploadImages, search }
}
