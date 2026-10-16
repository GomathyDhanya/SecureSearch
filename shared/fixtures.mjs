import { normalize } from './index.mjs'

export function randomSource(seed) {
  return () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}
export function makeDataset({ n = 512, queries = 12, dimension = 512, seed = 42, kind = 'clustered', noise = 0.55 } = {}) {
  const rng = randomSource(seed)
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng())
  const randomVector = () => normalize(Array.from({ length: dimension }, gaussian))
  const centers = Array.from({ length: 16 }, randomVector)
  const around = (center, amount) => normalize(center.map(x => x + amount * gaussian() / Math.sqrt(dimension)))
  const records = Array.from({ length: n }, (_, i) => ({ id: `fixture-${seed}-${i}`, group: i % centers.length,
    vector: kind === 'isotropic' ? randomVector() : around(centers[i % centers.length], noise) }))
  const queryVectors = Array.from({ length: queries }, (_, i) => kind === 'isotropic' ? randomVector() : around(centers[(i * 7) % centers.length], noise))
  return { records, queries: queryVectors, centers }
}

export function demoImage(record) {
  const hue = record.group * 22.5
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="260"><rect width="360" height="260" rx="20" fill="hsl(${hue} 65% 92%)"/><circle cx="180" cy="95" r="46" fill="hsl(${hue} 65% 45%)"/><text x="180" y="182" text-anchor="middle" font-family="sans-serif" font-size="23">Synthetic group ${record.group + 1}</text><text x="180" y="217" text-anchor="middle" font-family="sans-serif" font-size="13">${record.id}</text></svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}
