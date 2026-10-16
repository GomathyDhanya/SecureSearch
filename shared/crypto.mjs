const encoder = new TextEncoder(), decoder = new TextDecoder()
export function toBase64(bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return btoa(text)
}
export const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0))
export const newVaultKey = () => toBase64(crypto.getRandomValues(new Uint8Array(32)))
export async function importVaultKey(text) {
  const bytes = fromBase64(text.trim())
  if (bytes.length !== 32) throw new Error('Vault key must be a 32-byte base64 key')
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export async function encryptJSON(value, key, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) }, key, encoder.encode(JSON.stringify(value)))
  return { version: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) }
}
export async function decryptJSON(value, key, purpose) {
  if (value?.version !== 1) throw new Error('Unsupported encrypted envelope')
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(value.iv), additionalData: encoder.encode(purpose) }, key, fromBase64(value.ciphertext))
  return JSON.parse(decoder.decode(plain))
}
