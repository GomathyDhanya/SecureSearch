import CryptoJS from 'crypto-js'

export const deriveKey = (password, salt) => {
  return CryptoJS.PBKDF2(password, salt, { keySize: 256/32, iterations: 1000 }).toString();
}

// --- ADD THIS FUNCTION ---
export const generateSalt = () => {
  return CryptoJS.lib.WordArray.random(128/8).toString();
}
// ------------------------

export const generateRandomKey = () => {
  return CryptoJS.lib.WordArray.random(256/8).toString();
}

export const normalizeVector = (vec) => {
  const magnitude = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) return vec;
  return vec.map(val => val / magnitude);
}

export const encryptAES = (data, key) => {
  return CryptoJS.AES.encrypt(data, key).toString();
}

export const decryptAES = (ciphertext, key) => {
  const bytes = CryptoJS.AES.decrypt(ciphertext, key);
  return bytes.toString(CryptoJS.enc.Utf8);
}