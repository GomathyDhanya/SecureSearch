// Embeds official COCO val2017 images and captions with the SAME q8 CLIP model
// used by the browser. This script never fabricates vectors or relevance labels.
import { readFile, writeFile, appendFile, mkdir, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { normalize } from '../shared/index.mjs'

const imagesDir = process.env.COCO_IMAGES && resolve(process.env.COCO_IMAGES)
const captionsFile = process.env.COCO_CAPTIONS && resolve(process.env.COCO_CAPTIONS)
const outputDir = resolve(process.env.COCO_OUT || '../benchmarks/coco-val2017')
const imageLimit = Number(process.env.COCO_IMAGES_N || 5000)
const captionLimit = Number(process.env.COCO_CAPTIONS_N || Infinity)
const seed = process.env.COCO_SEED || '20261014'
const modelId = process.env.CLIP_MODEL || 'Xenova/clip-vit-base-patch32'
const modelRevision = process.env.CLIP_REVISION || 'd15189d7028b43f1d3e65039190477f6af591c2a'
if (!imagesDir || !captionsFile || !Number.isInteger(imageLimit) || imageLimit < 1 ||
    !(captionLimit === Infinity || Number.isInteger(captionLimit) && captionLimit > 0))
  throw new Error('Set COCO_IMAGES, COCO_CAPTIONS, and positive COCO_IMAGES_N / COCO_CAPTIONS_N')
const hash = value => createHash('sha256').update(value).digest('hex')
const annotationBytes = await readFile(captionsFile)
const annotations = JSON.parse(annotationBytes)
if (!Array.isArray(annotations.images) || !Array.isArray(annotations.annotations) ||
    annotations.images.length !== 5000)
  throw new Error('Expected official captions_val2017.json with exactly 5,000 validation images')
const rank = value => hash(`${seed}:${value}`)
const images = [...annotations.images].sort((a, b) => rank(a.id).localeCompare(rank(b.id))).slice(0, imageLimit)
const ids = new Set(images.map(image => image.id))
const captions = annotations.annotations.filter(a => ids.has(a.image_id))
  .sort((a, b) => rank(a.id).localeCompare(rank(b.id))).slice(0, captionLimit)
if (!captions.length) throw new Error('No official captions selected')
for (const image of images) await access(join(imagesDir, image.file_name))
await mkdir(outputDir, { recursive: true })
const manifestPath = join(outputDir, 'manifest.json')
const manifest = { dataset: 'MS COCO val2017 captions', split: 'val2017', annotationSha256: hash(annotationBytes),
  model: modelId, modelRevision, modelDtype: 'q8', imageCount: images.length, captionCount: captions.length, selectionSeed: seed,
  imageIdsSha256: hash(images.map(x => x.id).join(',')), captionIdsSha256: hash(captions.map(x => x.id).join(',')),
  format: 'l2-normalized CLIP projection, 512 dimensions; JSONL; official caption-to-image relevance' }
let existing
try { existing = JSON.parse(await readFile(manifestPath)) } catch { /* new run */ }
if (existing && JSON.stringify(existing) !== JSON.stringify(manifest)) throw new Error('Output manifest differs. Use a new COCO_OUT directory.')
if (!existing) await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
const readDone = async name => {
  try { return new Set((await readFile(join(outputDir, name), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).id)) }
  catch (e) { if (e.code === 'ENOENT') return new Set(); throw e }
}
const doneImages = await readDone('images.jsonl'), doneCaptions = await readDone('captions.jsonl')
if (doneImages.size === images.length && doneCaptions.size === captions.length) {
  console.log(`Complete cached embeddings: ${images.length} images, ${captions.length} captions in ${outputDir}`)
  process.exit(0)
}
const { AutoProcessor, CLIPVisionModelWithProjection, AutoTokenizer, CLIPTextModelWithProjection, RawImage, env } =
  await import('../client/node_modules/@huggingface/transformers/dist/transformers.node.mjs')
env.useFSCache = true
env.cacheDir = resolve(process.env.CLIP_CACHE || '../datasets/model-cache')
console.log(`Loading ${modelId} q8; model artifacts must be acquired from the stated model source.`)
if (doneImages.size < images.length) {
  const processor = await AutoProcessor.from_pretrained(modelId, { revision: modelRevision })
  const vision = await CLIPVisionModelWithProjection.from_pretrained(modelId, { dtype: 'q8', revision: modelRevision })
  for (const [i, image] of images.entries()) {
    if (doneImages.has(image.id)) continue
    const input = await processor(await RawImage.read(join(imagesDir, image.file_name)))
    const output = await vision(input)
    const vector = normalize(Array.from(output.image_embeds.data))
    if (vector.length !== 512) throw new Error(`Unexpected image embedding dimension: ${vector.length}`)
    await appendFile(join(outputDir, 'images.jsonl'), `${JSON.stringify({ id: image.id, file: image.file_name, vector })}\n`)
    if ((i + 1) % 100 === 0) console.log(`Embedded images ${i + 1}/${images.length}`)
  }
  vision.dispose?.()
}
if (doneCaptions.size < captions.length) {
  const tokenizer = await AutoTokenizer.from_pretrained(modelId, { revision: modelRevision })
  const text = await CLIPTextModelWithProjection.from_pretrained(modelId, { dtype: 'q8', revision: modelRevision })
  for (const [i, caption] of captions.entries()) {
    if (doneCaptions.has(caption.id)) continue
    const output = await text(await tokenizer([caption.caption], { padding: true, truncation: true }))
    const vector = normalize(Array.from(output.text_embeds.data))
    if (vector.length !== 512) throw new Error(`Unexpected text embedding dimension: ${vector.length}`)
    await appendFile(join(outputDir, 'captions.jsonl'), `${JSON.stringify({ id: caption.id, imageId: caption.image_id, vector })}\n`)
    if ((i + 1) % 500 === 0) console.log(`Embedded captions ${i + 1}/${captions.length}`)
  }
  text.dispose?.()
}
console.log(`Finished ${images.length} real COCO images and ${captions.length} official captions.`)
