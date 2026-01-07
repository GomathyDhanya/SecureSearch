import { useState, useEffect, useRef } from 'react'
import createCKKSEngine from '../ckks_web.js'
import { AutoProcessor, CLIPVisionModelWithProjection, AutoTokenizer, CLIPTextModelWithProjection, RawImage, env } from '@xenova/transformers'
// Add 'generateSalt' to the import list
import { deriveKey, generateRandomKey, generateSalt, encryptAES, decryptAES, normalizeVector } from '../utils/crypto'
env.allowLocalModels = false;
env.useBrowserCache = true;

export function useSecureSystem() {
  const [status, setStatus] = useState("Booting System...")
  const [user, setUser] = useState(null)
  const [logs, setLogs] = useState([])
  const [isReady, setIsReady] = useState(false)


  const engineRef = useRef(null)
  const aiRef = useRef({ processor: null, vision: null, tokenizer: null, text: null })
  const keysRef = useRef(null)
  const masterKeyRef = useRef(null)

  const addLog = (msg) => setLogs(p => [...p, msg])

  // 1. Initialize System
  useEffect(() => {
    async function init() {
      try {
        // Load WASM
        const module = await createCKKSEngine({ locateFile: p => p.endsWith('.wasm') ? '/ckks_web.wasm' : p })
        engineRef.current = new module.CKKSEngine(8192)
        
        // Load AI
        addLog("Loading AI Models (this happens once)...")
        const model_id = "Xenova/clip-vit-base-patch32";
        aiRef.current.processor = await AutoProcessor.from_pretrained(model_id);
        aiRef.current.vision = await CLIPVisionModelWithProjection.from_pretrained(model_id);
        aiRef.current.tokenizer = await AutoTokenizer.from_pretrained(model_id);
        aiRef.current.text = await CLIPTextModelWithProjection.from_pretrained(model_id);

        setIsReady(true)
        setStatus("System Ready")
        addLog("Secure Core Initialized")
      } catch (e) {
        console.error(e)
        setStatus("Initialization Failed")
      }
    }
    init()
  }, [])

  // 2. Auth Actions
  const login = async (email, password) => {
    setStatus("Authenticating...")
    try {
      const res = await fetch('http://localhost:3000/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ email, password })
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)

      // Unwrap Keys
      const passwordKey = deriveKey(password, data.salt)
      const masterKey = decryptAES(data.encryptedMasterKey, passwordKey)
      if (!masterKey) throw new Error("Invalid Credentials")
      
      masterKeyRef.current = masterKey
      
      const keysStr = decryptAES(data.encryptedKeys, masterKey)
      keysRef.current = JSON.parse(keysStr)

      setUser({ email, token: data.token })
      setStatus("Ready")
      addLog(`Welcome back, ${email}`)
    } catch (e) {
      addLog(`Login Error: ${e.message}`)
      setStatus("Error")
    }
  }

  const register = async (email, password) => {
    setStatus("Generating Identity...")
  try {
    const masterKey = generateRandomKey()


    const salt = generateSalt() 

    const passwordKey = deriveKey(password, salt)

      const encryptedMasterKey = encryptAES(masterKey, passwordKey)

      const ckksKeys = engineRef.current.generateKeys()
      const encryptedKeys = encryptAES(JSON.stringify(ckksKeys), masterKey)

      const res = await fetch('http://localhost:3000/register', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ email, password, salt, encryptedMasterKey, encryptedKeys })
      })
      if (!res.ok) throw new Error("Registration Failed")
      
      addLog("Identity Created. Please Login.")
      setStatus("Registered")
    } catch (e) {
      addLog(`Register Error: ${e.message}`)
    }
  }

  // 3. Image Actions
  const uploadImage = async (file) => {
    if (!user) return
    setStatus("Encrypting & Embedding...")
    
    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const base64 = e.target.result
        
        // AI Embedding
        const image = await RawImage.read(base64)
        const inputs = await aiRef.current.processor(image)
        const output = await aiRef.current.vision(inputs)
        const vec = normalizeVector(Array.from(output.image_embeds.data))

        // Encryption
        const encryptedImage = encryptAES(base64, masterKeyRef.current)
        const encryptedVector = engineRef.current.encrypt(vec, keysRef.current.publicKey)

        // Upload
        await fetch('http://localhost:3000/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${user.token}` },
          body: JSON.stringify({ encryptedImage, encryptedVector })
        })
        addLog("Image Encrypted & Stored")
        setStatus("Ready")
      } catch (err) {
        addLog(`Upload Failed: ${err.message}`)
      }
    }
    reader.readAsDataURL(file)
  }

  // 4. Search Actions (Returns Top K)
  const searchImages = async (queryText, k = 3) => {
    if (!user || !queryText) return []
    setStatus("Running Secure Search...")
    addLog(`Query: "${queryText}"`)

    try {
      // Embed Text
      const inputs = await aiRef.current.tokenizer([queryText], { padding: true, truncation: true })
      const output = await aiRef.current.text(inputs)
      const vec = normalizeVector(Array.from(output.text_embeds.data))

      // Encrypt Query
      const encQuery = engineRef.current.encrypt(vec, keysRef.current.publicKey)

      // Server Compute
      const res = await fetch('http://localhost:3000/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${user.token}` },
        body: JSON.stringify({ queryVector: encQuery, relinKeys: keysRef.current.relinKeys })
      })
      const data = await res.json()

      // Decrypt Scores & Sort
      const scores = data.results.map(item => {
        const parts = engineRef.current.decrypt(item.score, keysRef.current.secretKey)
        let sum = 0; for(let i=0; i<vec.length; i++) sum += parts[i]; 
        return { id: item.id, score: sum }
      })
      
      // Top K Logic
      scores.sort((a,b) => b.score - a.score)
      const topK = scores.slice(0, k).filter(s => s.score > 0.18) // Threshold

      if (topK.length === 0) {
        addLog("No matches found")
        setStatus("Ready")
        return []
      }

      // Fetch & Decrypt Images in Parallel
      addLog(`Decrypting Top ${topK.length} matches...`)
      const images = await Promise.all(topK.map(async (item) => {
        const imgRes = await fetch('http://localhost:3000/get-image', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${user.token}` },
           body: JSON.stringify({ id: item.id })
        })
        const imgData = await imgRes.json()
        const url = decryptAES(imgData.encryptedImage, masterKeyRef.current)
        return { ...item, url }
      }))

      setStatus("Results Ready")
      return images

    } catch (e) {
      addLog(`Search Error: ${e.message}`)
      return []
    }
  }

  return { 
    isReady, status, user, logs, 
    login, register, uploadImage, searchImages 
  }
}
