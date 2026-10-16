// Shared SEAL 4.1 adapter. The runtime is injected so browser and Node use the
// same protocol without shipping a secret key into the server evaluator.
export const DIM = 512
export const PACK = 8
export const SLOTS = 4096
export const FORMAT = 'ckks-interleaved-v2'

export function packVectors(vectors) {
  if (!vectors.length || vectors.length > PACK) throw new Error('Expected 1–8 vectors')
  const slots = new Float64Array(SLOTS)
  vectors.forEach((v, b) => {
    if (v.length !== DIM || !v.every(Number.isFinite)) throw new Error('Invalid 512-D vector')
    for (let d = 0; d < DIM; d++) slots[d * PACK + b] = v[d]
  })
  return slots
}

export const packQuery = q => packVectors(Array.from({ length: PACK }, () => q))

export class CKKS {
  constructor(seal) {
    this.s = seal
    this.scale = 2 ** 40
    const parms = new seal.EncryptionParameters(seal.SchemeType.ckks)
    const modulus = seal.CoeffModulus.Create(8192, new Int32Array([60, 40, 40, 60]))
    parms.setPolyModulusDegree(8192)
    parms.setCoeffModulus(modulus)
    this.context = new seal.SEALContext(parms, true, seal.SecLevelType.tc128)
    modulus.delete(); parms.delete()
    if (!this.context.parametersSet()) throw new Error('Invalid CKKS parameters')
    this.encoder = new seal.CKKSEncoder(this.context)
    this.evaluator = new seal.Evaluator(this.context)
  }

  save(obj) { return obj.saveToBase64(this.s.ComprModeType.zstd) }
  load(Type, text) {
    const obj = new this.s[Type]()
    try { obj.loadFromBase64(this.context, text); return obj }
    catch (e) { obj.delete(); throw e }
  }

  generateKeys() {
    const generator = new this.s.KeyGenerator(this.context)
    const sk = generator.secretKey()
    const pk = generator.createPublicKey()
    const rk = generator.createRelinKeys()
    // Powers of two suffice for dimension reduction and composed score packing.
    const steps = []
    for (let n = PACK; n < SLOTS; n *= 2) steps.push(n, -n)
    const gk = generator.createGaloisKeysWithSteps(new Int32Array([...new Set(steps)]))
    try {
      return { format: FORMAT, secretKey: this.save(sk), publicKey: this.save(pk),
        relinKeys: this.save(rk), galoisKeys: this.save(gk) }
    } finally { sk.delete(); pk.delete(); rk.delete(); gk.delete(); generator.delete() }
  }

  setClientKeys(keys) {
    this.encryptor?.delete(); this.decryptor?.delete()
    const pk = this.load('PublicKey', keys.publicKey)
    const sk = this.load('SecretKey', keys.secretKey)
    try {
      this.encryptor = new this.s.Encryptor(this.context, pk)
      this.decryptor = new this.s.Decryptor(this.context, sk)
    } finally { pk.delete(); sk.delete() }
  }

  setEvaluationKeys(keys) {
    this.relin?.delete(); this.galois?.delete()
    this.relin = this.load('RelinKeys', keys.relinKeys)
    this.galois = this.load('GaloisKeys', keys.galoisKeys)
  }

  encrypt(slots) {
    const plain = new this.s.Plaintext(), cipher = new this.s.Ciphertext()
    try {
      this.encoder.encode(slots, this.scale, plain)
      this.encryptor.encrypt(plain, cipher)
      return this.save(cipher)
    } finally { plain.delete(); cipher.delete() }
  }

  decrypt(text) {
    const cipher = this.load('Ciphertext', text), plain = new this.s.Plaintext()
    try {
      this.decryptor.decrypt(cipher, plain)
      return Float64Array.from(this.encoder.decodeFloat64(plain))
    } finally { plain.delete(); cipher.delete() }
  }

  // Batches: { encryptedVector, imageIds }. Output scalar scores are packed
  // across batches: the client decrypts once per <=4096 candidate slots.
  // Legacy mode intentionally reproduces the old elementwise/client-sum split.
  score(queryText, batches, mode = 'server') {
    const query = this.load('Ciphertext', queryText)
    const output = []
    let aggregate = null, ids = [], used = 0
    const flush = () => {
      if (aggregate) { output.push({ score: this.save(aggregate), ids }); aggregate.delete() }
      aggregate = null; ids = []; used = 0
    }
    try {
      for (const batch of batches) {
        const product = this.load('Ciphertext', batch.encryptedVector)
        const rotated = new this.s.Ciphertext()
        const mask = new this.s.Plaintext()
        try {
          this.evaluator.multiplyInplace(product, query)
          this.evaluator.relinearizeInplace(product, this.relin)
          this.evaluator.rescaleToNextInplace(product)
          if (mode === 'legacy') {
            output.push({ score: this.save(product), ids: batch.imageIds })
            continue
          }
          // Interleaving makes each rotation sum coordinates of the same image.
          for (let step = PACK; step < SLOTS; step *= 2) {
            this.evaluator.rotateVector(product, step, this.galois, rotated)
            this.evaluator.addInplace(product, rotated)
          }
          const selection = new Float64Array(SLOTS)
          selection.fill(1, 0, PACK)
          this.encoder.encode(selection, this.scale, mask)
          const pid = product.parmsId()
          try { this.evaluator.plainModSwitchToInplace(mask, pid) } finally { pid.delete() }
          this.evaluator.multiplyPlainInplace(product, mask)
          this.evaluator.rescaleToNextInplace(product)
          if (used) this.evaluator.rotateVectorInplace(product, -used, this.galois)
          if (aggregate) this.evaluator.addInplace(aggregate, product)
          else aggregate = product.copy()
          for (let i = 0; i < PACK; i++) ids.push(batch.imageIds[i] ?? null)
          used += PACK
          if (used === SLOTS) flush()
        } finally { product.delete(); rotated.delete(); mask.delete() }
      }
      flush()
      return output
    } finally { query.delete(); aggregate?.delete() }
  }

  readScores(results, mode = 'server') {
    const scores = []
    for (const result of results) {
      const values = this.decrypt(result.score)
      result.ids.forEach((id, i) => {
        if (id === null) return
        let score = values[i]
        if (mode === 'legacy') {
          score = 0
          for (let d = 0; d < DIM; d++) score += values[d * PACK + i]
        }
        scores.push({ id, score })
      })
    }
    return scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  }

  delete() {
    for (const name of ['encryptor', 'decryptor', 'relin', 'galois', 'encoder', 'evaluator', 'context'])
      this[name]?.delete()
  }
}
