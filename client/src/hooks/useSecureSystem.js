import { useState, useEffect, useRef } from 'react'
import createCKKSEngine from '../ckks_web.js'
import {
  AutoProcessor,
  CLIPVisionModelWithProjection,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  RawImage,
  env,
} from '@xenova/transformers'
import {
  deriveKey,
  generateRandomKey,
  generateSalt,
  encryptAES,
  decryptAES,
  normalizeVector,
} from '../utils/crypto'

env.allowLocalModels = false
env.useBrowserCache = true

const EMBEDDING_DIM = 512
const PACK_SIZE = 8
const SLOT_COUNT = EMBEDDING_DIM * PACK_SIZE // 4096 for CKKS degree 8192

function packEmbeddings(vectors) {
  if (vectors.length < 1 || vectors.length > PACK_SIZE) {
    throw new Error(`Expected 1-${PACK_SIZE} embeddings`)
  }

  const packed = new Array(SLOT_COUNT).fill(0)

  vectors.forEach((vec, batchIndex) => {
    if (vec.length !== EMBEDDING_DIM) {
      throw new Error(`Expected ${EMBEDDING_DIM}-D embedding, got ${vec.length}`)
    }

    const offset = batchIndex * EMBEDDING_DIM
    for (let d = 0; d < EMBEDDING_DIM; d++) {
      packed[offset + d] = vec[d]
    }
  })

  return packed
}

function packQuery(query) {
  if (query.length !== EMBEDDING_DIM) {
    throw new Error(`Expected ${EMBEDDING_DIM}-D query, got ${query.length}`)
  }

  const packed = new Array(SLOT_COUNT)

  for (let batchIndex = 0; batchIndex < PACK_SIZE; batchIndex++) {
    const offset = batchIndex * EMBEDDING_DIM
    for (let d = 0; d < EMBEDDING_DIM; d++) {
      packed[offset + d] = query[d]
    }
  }

  return packed
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => resolve(e.target.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function useSecureSystem() {
  const [status, setStatus] = useState('Booting System...')
  const [user, setUser] = useState(null)
  const [logs, setLogs] = useState([])
  const [isReady, setIsReady] = useState(false)

  const engineRef = useRef(null)
  const aiRef = useRef({ processor: null, vision: null, tokenizer: null, text: null })
  const keysRef = useRef(null)
  const masterKeyRef = useRef(null)

  const addLog = msg => setLogs(p => [...p, msg])

  // ---------------- INIT ----------------

  useEffect(() => {
    async function init() {
      try {
        const module = await createCKKSEngine({
          locateFile: p => p.endsWith('.wasm') ? '/ckks_web.wasm' : p,
        })

        engineRef.current = new module.CKKSEngine(8192)

        addLog('Loading AI Models (this happens once)...')

        const model_id = 'Xenova/clip-vit-base-patch32'
        aiRef.current.processor = await AutoProcessor.from_pretrained(model_id)
        aiRef.current.vision = await CLIPVisionModelWithProjection.from_pretrained(model_id)
        aiRef.current.tokenizer = await AutoTokenizer.from_pretrained(model_id)
        aiRef.current.text = await CLIPTextModelWithProjection.from_pretrained(model_id)

        setIsReady(true)
        setStatus('System Ready')
        addLog(`Secure Core Initialized (${PACK_SIZE} embeddings/ciphertext)`)
      } catch (e) {
        console.error(e)
        setStatus('Initialization Failed')
      }
    }

    init()
  }, [])

  // ---------------- AUTH ----------------

  const login = async (email, password) => {
    setStatus('Authenticating...')

    try {
      const res = await fetch('http://localhost:3000/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      const data = await res.json()
      if (data.error) throw new Error(data.error)

      const passwordKey = deriveKey(password, data.salt)
      const masterKey = decryptAES(data.encryptedMasterKey, passwordKey)

      if (!masterKey) throw new Error('Invalid Credentials')

      masterKeyRef.current = masterKey

      const keysStr = decryptAES(data.encryptedKeys, masterKey)
      keysRef.current = JSON.parse(keysStr)

      setUser({ email, token: data.token })
      setStatus('Ready')
      addLog(`Welcome back, ${email}`)
    } catch (e) {
      addLog(`Login Error: ${e.message}`)
      setStatus('Error')
    }
  }

  const register = async (email, password) => {
    setStatus('Generating Identity...')

    try {
      const masterKey = generateRandomKey()
      const salt = generateSalt()
      const passwordKey = deriveKey(password, salt)
      const encryptedMasterKey = encryptAES(masterKey, passwordKey)

      const ckksKeys = engineRef.current.generateKeys()
      const encryptedKeys = encryptAES(JSON.stringify(ckksKeys), masterKey)

      const res = await fetch('http://localhost:3000/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          salt,
          encryptedMasterKey,
          encryptedKeys,
        }),
      })

      if (!res.ok) throw new Error('Registration Failed')

      addLog('Identity Created. Please Login.')
      setStatus('Registered')
    } catch (e) {
      addLog(`Register Error: ${e.message}`)
    }
  }

  // ---------------- EMBEDDING ----------------

  const embedImage = async file => {
    const base64 = await readFileAsDataURL(file)
    const image = await RawImage.read(base64)
    const inputs = await aiRef.current.processor(image)
    const output = await aiRef.current.vision(inputs)

    return {
      base64,
      vector: normalizeVector(Array.from(output.image_embeds.data)),
    }
  }

  // ---------------- PACKED UPLOAD ----------------

  const uploadImages = async filesLike => {
    if (!user) return

    const files = Array.from(filesLike)
    if (!files.length) return

    setStatus('Embedding & Encrypting...')

    try {
      for (let start = 0; start < files.length; start += PACK_SIZE) {
        const chunk = files.slice(start, start + PACK_SIZE)

        // Keep client memory bounded to one pack.
        // Parallel image embedding can consume substantial browser memory,
        // so process the chunk sequentially.
        const vectors = []
        const encryptedImages = []

        for (const file of chunk) {
          addLog(`Embedding ${file.name}...`)
          const { base64, vector } = await embedImage(file)
          vectors.push(vector)
          encryptedImages.push(encryptAES(base64, masterKeyRef.current))
        }

        const packedVector = packEmbeddings(vectors)
        const encryptedVector = engineRef.current.encrypt(
          packedVector,
          keysRef.current.publicKey,
        )

        const res = await fetch('http://localhost:3000/upload-batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${user.token}`,
          },
          body: JSON.stringify({
            encryptedImages,
            encryptedVector,
            count: chunk.length,
          }),
        })

        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Packed upload failed')

        addLog(
          `Packed ${chunk.length} image${chunk.length === 1 ? '' : 's'} into 1 CKKS ciphertext`,
        )
      }

      setStatus('Ready')
    } catch (err) {
      console.error(err)
      addLog(`Upload Failed: ${err.message}`)
      setStatus('Error')
    }
  }

  // Keep the old name available for callers that upload one file.
  const uploadImage = async file => uploadImages([file])

  // ---------------- PACKED SEARCH ----------------

  const searchImages = async (queryText, k = 3) => {
    if (!user || !queryText) return []

    setStatus('Running Packed Secure Search...')
    addLog(`Query: "${queryText}"`)

    try {
      // 1. Local text embedding
      const inputs = await aiRef.current.tokenizer(
        [queryText],
        { padding: true, truncation: true },
      )

      const output = await aiRef.current.text(inputs)
      const query = normalizeVector(Array.from(output.text_embeds.data))

      // 2. Replicate the same query into all 8 CKKS blocks.
      const packedQuery = packQuery(query)
      const encQuery = engineRef.current.encrypt(
        packedQuery,
        keysRef.current.publicKey,
      )

      // 3. One HE multiply per packed database ciphertext.
      const res = await fetch('http://localhost:3000/search-packed', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({
          queryVector: encQuery,
          relinKeys: keysRef.current.relinKeys,
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Packed search failed')

      // 4. Decrypt once per batch and reduce 8 independent 512-slot blocks.
      const scores = []

      for (const batch of data.results) {
        const slots = engineRef.current.decrypt(
          batch.score,
          keysRef.current.secretKey,
        )

        for (let candidate = 0; candidate < batch.count; candidate++) {
          const offset = candidate * EMBEDDING_DIM

          let score = 0
          for (let d = 0; d < EMBEDDING_DIM; d++) {
            score += slots[offset + d]
          }

          scores.push({
            id: batch.imageIds[candidate],
            score,
          })
        }
      }

      scores.sort((a, b) => b.score - a.score)
      const topK = scores.slice(0, k).filter(s => s.score > 0.18)

      addLog(
        `Scored ${data.candidateCount} images using ${data.batchCount} HE multiplications`,
      )

      if (!topK.length) {
        addLog('No matches found')
        setStatus('Ready')
        return []
      }

      // 5. Fetch only the selected encrypted image blobs.
      const images = await Promise.all(
        topK.map(async item => {
          const imgRes = await fetch('http://localhost:3000/get-image', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${user.token}`,
            },
            body: JSON.stringify({ id: item.id }),
          })

          const imgData = await imgRes.json()
          if (!imgRes.ok) throw new Error(imgData.error || 'Image fetch failed')

          const url = decryptAES(
            imgData.encryptedImage,
            masterKeyRef.current,
          )

          return { ...item, url }
        }),
      )

      setStatus('Results Ready')
      return images
    } catch (e) {
      console.error(e)
      addLog(`Search Error: ${e.message}`)
      setStatus('Error')
      return []
    }
  }

  return {
    isReady,
    status,
    user,
    logs,
    login,
    register,
    uploadImage,
    uploadImages,
    searchImages,
  }
}
